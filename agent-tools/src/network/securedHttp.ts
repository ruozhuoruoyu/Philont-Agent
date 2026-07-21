/**
 * Secured HTTP tool — supports zero-exposure credential injection
 *
 * Usage:
 *   const httpTool = createSecuredHttpTool(secretStore);
 *   // The LLM can call:
 *   httpTool.execute({
 *     url: 'https://api.github.com/user',
 *     headers: { 'Authorization': 'Bearer {GITHUB_TOKEN}' },
 *   });
 *   // The plaintext token never appears in the tool code; injection happens in the fetch wrapper layer.
 *
 * Differences from the plain httpTool:
 *   - Uses an injecting fetch that recognizes {SECRET_ID} and replaces them
 *   - Plaintext values never appear in tool params or tool output (unless the API echoes them back)
 *   - The response body is run through redactOutput (covers 15+ secret patterns) before being returned
 */

import type { Tool, SecretStore } from '@agent/policy';
import { createInjectingFetch, redactOutput } from '@agent/policy';
import { credentialCaptureEnabled, extractCapturableCredential } from './credential_capture.js';

/**
 * Normalize an LLM-supplied HTTP header NAME. Weaker models copy a header token straight out of a
 * doc's markdown code span and keep the wrapping — `` `X-Actor-Id` `` or `"X-Actor-Id"` — which native
 * fetch rejects with the cryptic `Headers.append: "…" is an invalid header name`; the model can't read
 * that and blindly retries the same broken shape (prod 2026-07-16, gemma-4-31B on mycox: the verify /
 * posts calls crashed on the header name for turn after turn). We SELF-HEAL by stripping wrapping
 * quotes/backticks/whitespace (a real header name never starts or ends with them), then validate the
 * result against the RFC 7230 token grammar. Returns the cleaned name, or null if it is still not a
 * valid token so the caller can fail fast with a readable message instead of the native error.
 */
export function normalizeHeaderName(raw: string): string | null {
  const stripped = raw.trim().replace(/^[`'"\s]+|[`'"\s]+$/g, '');
  // RFC 7230 token = 1*tchar; if it survives cleaning as a valid token, use it.
  return stripped && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(stripped) ? stripped : null;
}

/**
 * Normalize the `headers` PARAMETER itself (as opposed to one header's name, above).
 *
 * The schema says object, but a model that has just watched `body` accept a JSON *string* symmetrically
 * passes headers the same way — and the old code did `Object.entries(params.headers as Record<…>)` on it.
 * `Object.entries` of a string returns index→character pairs, so the request went out with ~45 headers
 * named "0","1","2"… and NO Authorization. The credential placeholder was therefore never substituted and
 * the service answered 401 UNAUTHORIZED — a wrong-credentials error for a request that never carried any.
 * Prod 2026-07-21: the model retried that exact shape three times, fell back to GET (404), tripped the
 * in-turn tool block, spawned a placeholder revise-plan, then fabricated a recovery claim that fired the
 * honesty gate. One unparsed parameter cost the entire run.
 *
 * So: accept the string form and parse it, exactly as `body` already accepts both forms. Anything that is
 * not an object after parsing fails fast with a message naming the shape, rather than silently sending a
 * request with no auth — an authentication error that is really a serialization error is close to
 * undebuggable from the model's side, because the error text points at the credential.
 *
 * Returns the header record, or an error string for the caller to surface.
 */
export function coerceHeadersParam(raw: unknown): { headers: Record<string, unknown> } | { error: string } {
  if (raw === undefined || raw === null) return { headers: {} };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { headers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        error:
          `http tool: headers must be an OBJECT, e.g. {"Authorization": "Bearer {my-key}"} — got a string ` +
          `that is not valid JSON either. Pass the object itself; do not serialize it.`,
      };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        error:
          `http tool: headers must be an OBJECT of name → value, e.g. {"Authorization": "Bearer {my-key}"}. ` +
          `The value given parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`,
      };
    }
    return { headers: parsed as Record<string, unknown> };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      error:
        `http tool: headers must be an OBJECT of name → value, e.g. {"Authorization": "Bearer {my-key}"} ` +
        `(got ${Array.isArray(raw) ? 'an array' : typeof raw}).`,
    };
  }
  return { headers: raw as Record<string, unknown> };
}

export interface SecuredHttpOptions {
  /** Whitelist of secret IDs allowed for injection; if not provided, all secrets in the store are allowed */
  allowedSecrets?: string[];
  /** Whether to redact secrets from the response body, default true */
  redactResponse?: boolean;
  /** Injection callback (for auditing) */
  onInject?: (info: { secretIds: string[]; url: string }) => void;
}

export function createSecuredHttpTool(
  store: SecretStore,
  options: SecuredHttpOptions = {},
): Tool {
  const allowed = options.allowedSecrets ? new Set(options.allowedSecrets) : undefined;
  const redactResponse = options.redactResponse ?? true;

  const injectingFetch = createInjectingFetch(store, {
    allowedSecrets: allowed,
    scanPreInject: true,
    onInject: options.onInject,
  });

  return {
    name: 'http',
    description: 'Send an HTTP request (supports {SECRET_ID} credential placeholders, injected automatically by the host)',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL, may contain {SECRET_ID} placeholders' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        headers: { type: 'object', description: 'Request headers, may contain {SECRET_ID} placeholders' },
        body: {
          description:
            'Request body. Pass a string (sent as-is) or an object (auto JSON.stringify + adds Content-Type: application/json). May contain {SECRET_ID} placeholders.',
        },
      },
      required: ['url'],
    },
    capability: 'read',
    domain: 'network',
    classify(params) {
      const method = String(params.method ?? 'GET').toUpperCase();
      const isWrite = /^(POST|PUT|DELETE|PATCH)$/.test(method);
      return { capability: isWrite ? 'write' : 'read', domain: 'network' };
    },
    async execute(params) {
      // 2026-05-11: url is required. schema required: ['url'] is not always enforced server-side
      // (some LLMs omit fields); old code cast it to undefined, causing fetch to throw
      // "Cannot read properties of undefined (reading 'url')" — a very misleading error for the LLM.
      // Fail fast here with a clear error.
      const url = params.url;
      if (typeof url !== 'string' || url.length === 0) {
        return {
          success: false,
          output: '',
          error: `http tool: 'url' is required and must be a non-empty string (got ${typeof url === 'undefined' ? 'undefined' : JSON.stringify(url)}). Pass full URL like "https://api.example.com/path".`,
        };
      }

      // 2026-05-17: URL HTML-leak validation.
      // Real-world bug: when the LLM copies a URL from rendered text / markdown links it sometimes
      // includes HTML closing tag characters, e.g. `https://my">https://mycox.ai/...` — fetch fails
      // to parse it, the LLM doesn't understand the error and retries repeatedly → triggers
      // in-turn-reflection tool lock. Fail fast here with a clear message.
      //
      // Only check for obvious HTML tag characters (", <, >, HTML entities). The "double protocol"
      // pattern is not checked — OAuth redirect URLs like `?to=https://...` are legitimate and
      // would be falsely flagged. HTML characters are sufficient to block the real-world bug path.
      const htmlLeak = /["<>]|&(?:quot|lt|gt|amp);/;
      if (htmlLeak.test(url)) {
        const preview = url.length > 100 ? `${url.slice(0, 100)}...` : url;
        return {
          success: false,
          output: '',
          error:
            `http tool: URL contains HTML tag characters (got: "${preview}").\n` +
            `Common cause: copying \`<a href="...">...\` from markdown / rendered HTML and bringing the closing \`">\` along.\n` +
            `Fix: take the URL directly from a JSON response field (e.g. response.posts[i].url or response.id), not from rendered text.\n` +
            `If you are just building an endpoint from an id, assemble \`https://host/api/posts/\${id}\` yourself; don't copy the whole markdown link.`,
        };
      }
      // 2026-06-08: unresolved template-placeholder guard.
      // Real-world bug: a skill's action_template carries a shell-style placeholder like
      // `$BASE_URL/api/posts`, but the http tool does NOT expand env / `$VAR` placeholders (only
      // `{SECRET_ID}` is resolved at injection time). When the authoritative value is missing (e.g.
      // a `project.<svc>` fact got lost), the model silently substitutes a GUESSED domain
      // (mycox.app / api.mycox.app instead of mycox.ai) → a string of `fetch failed` against
      // hallucinated hosts + failure-ledger noise. Fail LOUD instead: reject any leftover
      // `$NAME` / `${NAME}` placeholder so the misconfig surfaces immediately.
      // Scope: only `$`-style env-var placeholders (uppercase `$BASE_URL`, or `${...}`). Does NOT
      // touch `{SECRET_ID}` (curly, no `$` — resolved later) or OData params (`$filter`/`$top` —
      // lowercase), which are legitimate.
      const placeholderLeak = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z][A-Z0-9_]+/;
      const phMatch = placeholderLeak.exec(url);
      if (phMatch) {
        return {
          success: false,
          output: '',
          error:
            `http tool: URL still contains an unresolved placeholder "${phMatch[0]}" — the http tool does NOT expand ` +
            `env / $VAR placeholders (only {SECRET_ID} is resolved). Do not guess the value.\n` +
            `Fix: substitute the REAL value before calling http (e.g. get the service base URL from a fact / memory, ` +
            `or ask the user), then pass the full concrete URL like "https://host/api/posts". ` +
            `If the value is a secret, use the {SECRET_ID} form and configure it in the secret store.`,
        };
      }

      const method = (params.method as string) || 'GET';
      // 2026-05-17 Phase 13.5: method character-set validation.
      // Real-world bug: LLM provider template fragments (DSML / qwen tool-call templates) sometimes
      // leak into the method field, e.g. `POST</｜DSML｜parameter name="headers"...>` as a whole block.
      // fetch receiving an invalid method throws the very cryptic
      // `Cannot convert argument to a ByteString because the character at index N has a value of 65372`
      // — the LLM can't understand this and retries or switches tools. Fail fast with a clear message.
      const VALID_METHODS = new Set([
        'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
      ]);
      const methodUpper = method.toUpperCase();
      if (!VALID_METHODS.has(methodUpper)) {
        const preview = method.length > 60 ? `${method.slice(0, 60)}...` : method;
        return {
          success: false,
          output: '',
          error:
            `http tool: method must be one of ${[...VALID_METHODS].join('/')} (got: "${preview}").\n` +
            `Common cause: the LLM tool-call output contained DSML / Qwen tool-call template fragments (e.g. ` +
            `a whole "POST</｜DSML｜parameter...>" stuffed into the method field).\n` +
            `Fix: the method field takes only the verb word; headers / body go in their own parameters — don't splice in template text.`,
        };
      }
      // Normalize header names before they reach native fetch: weak models wrap the name in markdown
      // backticks / quotes copied from the doc (`` `X-Actor-Id` ``), which fetch rejects cryptically.
      // Self-heal by stripping the wrapping; fail fast with a clear message only if it is still invalid.
      const headers: Record<string, string> = {};
      const coerced = coerceHeadersParam(params.headers);
      if ('error' in coerced) return { success: false, output: '', error: coerced.error };
      for (const [rawKey, rawVal] of Object.entries(coerced.headers)) {
        const key = normalizeHeaderName(rawKey);
        if (!key) {
          return {
            success: false,
            output: '',
            error:
              `http tool: "${rawKey}" is not a valid header name. A header name is a bare token like ` +
              `X-Actor-Id or Authorization — no surrounding quotes, backticks, or spaces. ` +
              `Common cause: the name was copied from a doc's markdown code span (\`X-Actor-Id\`) with the ` +
              `backticks kept. Pass just the token.`,
          };
        }
        headers[key] = typeof rawVal === 'string' ? rawVal : String(rawVal);
      }
      // 2026-05-11: body object compatibility — LLMs often pass object literals; old code cast them to
      // string, causing fetch to call toString() and send "[object Object]"; the target service then
      // reports "JSON Parse error: Unexpected identifier 'object'". Here, if we receive an object,
      // auto-stringify it and add Content-Type: application/json when the caller hasn't set it.
      let body: string | undefined;
      const rawBody = params.body;
      if (rawBody === undefined || rawBody === null) {
        body = undefined;
      } else if (typeof rawBody === 'string') {
        body = rawBody;
      } else {
        body = JSON.stringify(rawBody);
        const hasContentType = Object.keys(headers).some(
          (k) => k.toLowerCase() === 'content-type',
        );
        if (!hasContentType) {
          headers['Content-Type'] = 'application/json';
        }
      }

      try {
        const response = await injectingFetch(url, { method, headers, body });
        let text = await response.text();
        const rawText = text; // pre-redaction copy (mechanism-layer credential capture reads this)

        if (redactResponse) {
          text = redactOutput(text);
        }

        if (!response.ok) {
          // 2026-05-10: on failure, concatenate URL + method + response body prefix into the error,
          // so the LLM sees complete diagnostic info instead of an isolated "HTTP 401".
          // The url is still in placeholder form (input.url has not been replaced with plaintext;
          // redact only touches the response), so no secret is leaked.
          const bodyPreview = text.slice(0, 300);
          const richError =
            `HTTP ${response.status} ${method} ${url}` +
            (bodyPreview ? `\nResponse body: ${bodyPreview}` : '');
          // Also log to console for operator debugging (real-world: mycox heartbeat debug couldn't see the URL)
          console.warn(`[http] FAIL ${response.status} ${method} ${url}`);
          if (bodyPreview) {
            console.warn(`[http] body preview: ${bodyPreview.slice(0, 200)}`);
          }
          // 5xx shape diagnostic: a server INTERNAL_ERROR usually means OUR body shape tripped it
          // (missing required field / string where an object is specced), but the value-bearing
          // request must never be logged. Log field NAMES + JS types only — enough to compare
          // against the spec (prod: memories PUT 500 ×3, request shape invisible, undiagnosable).
          if (response.status >= 500 && body) {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const shape = Object.entries(parsed)
                .map(([k, v]) => `${k}:${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v}`)
                .join(', ');
              console.warn(`[http] request shape (names/types only): {${shape}}`);
            } catch {
              console.warn(`[http] request shape: non-JSON body (${body.length} chars)`);
            }
          }
          return {
            success: false,
            output: text,
            error: richError,
          };
        }

        // Mechanism-layer credential capture: a successful auth/register response's credential is
        // persisted to the SecretStore under a service-derived id ({<service>-api-key}) so later
        // authenticated calls resolve it — critical on autonomous/scheduled turns where the model
        // cannot call saveCredential (blacklisted). Never breaks the http call.
        if (credentialCaptureEnabled()) {
          try {
            const cap = extractCapturableCredential(url, method, rawText);
            if (cap) {
              const stored: string[] = [];
              for (const id of cap.ids) {
                if (store.get(id) !== cap.value) store.set(id, cap.value);
                stored.push(id);
              }
              let where = '';
              try { const u = new URL(url); where = `${u.host}${u.pathname}`; } catch { where = '(url)'; }
              console.warn(
                `[http-cred-capture] ${method} ${where} → stored credential as ` +
                  `{${stored.join('}, {')}} (field=${cap.field}); value not logged`,
              );
            }
          } catch {
            /* capture must never break the request */
          }
        }

        return {
          success: true,
          output: text,
          error: undefined,
        };
      } catch (error) {
        const richError = `${method} ${url} threw: ${String(error)}`;
        console.warn(`[http] EXCEPTION ${method} ${url}: ${String(error).slice(0, 200)}`);
        return {
          success: false,
          output: '',
          error: richError,
        };
      }
    },
  };
}
