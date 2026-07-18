/**
 * General-purpose auxiliary LLM client
 *
 * Design goals:
 *   - Allow tools like WebFetch to call a small model on demand for content distillation
 *   - Shared by other features (commit-message generation, memory compression, page classification, etc.)
 *   - Not bound to a specific vendor
 *
 * Configuration priority (inside callAuxLLM):
 *   1. All three of AUX_LLM_BASE_URL, AUX_LLM_API_KEY, and AUX_LLM_MODEL are set
 *      → use the protocol specified by AUX_LLM_PROTOCOL:
 *        - 'openai' (default) → POST /chat/completions (OpenAI Chat Completions)
 *        - 'anthropic'        → POST /v1/messages       (Anthropic Messages API)
 *      When AUX_LLM_PROTOCOL is not explicitly set, heuristically detect from baseUrl:
 *      contains 'anthropic' → anthropic; anything else → openai.
 *   2. Otherwise → call the main-model caller registered at server startup via registerMainLLM
 *   3. Neither available → throw AuxLLMError
 *
 * Compatible with most inexpensive small models: DeepSeek / Qwen / GLM / Moonshot / Groq / Together /
 * OpenRouter / self-hosted vLLM / Ollama (OpenAI protocol) + Anthropic official / gateways that speak
 * the Anthropic protocol (e.g. neolink.vnet.com / self-hosted anthropic-shim, etc.).
 */

export interface AuxLLMRequest {
  /** System prompt, optional */
  system?: string;
  /** User message (required) */
  user: string;
  /** Maximum output tokens, default 4096 */
  maxTokens?: number;
  /**
   * Per-call timeout override in ms. When omitted the timeout is derived from `maxTokens` (see
   * auxTimeoutFor), so a small classifier does not wait as long as a full-page distillation. Set this only
   * for a call that legitimately needs longer than the adaptive ceiling — e.g. compiling a whole API guide
   * into a spec generates thousands of JSON tokens and needs minutes on a small model (prod 2026-07-17:
   * that compile hit the old flat 60s wall every time, so the spec was never built and the spec guards ran
   * inert against a null spec).
   */
  timeoutMs?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export type AuxLLMCaller = (req: AuxLLMRequest) => Promise<string>;

export class AuxLLMError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'not_configured'
      | 'http_error'
      | 'timeout'
      | 'invalid_response'
      | 'aborted',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AuxLLMError';
  }
}

let mainLLMCaller: AuxLLMCaller | null = null;

/**
 * Register the main-model caller. Called once at application layer (server / demo) startup.
 *
 * When AUX_LLM_* environment variables are not configured, callAuxLLM falls back to the caller
 * registered here — whatever main model the server uses, auxiliary calls use the same one,
 * keeping cost and capability under control.
 */
export function registerMainLLM(caller: AuxLLMCaller): void {
  mainLLMCaller = caller;
}

/** For testing only: clear the registered main-model caller */
export function clearMainLLMRegistration(): void {
  mainLLMCaller = null;
}

/** Whether a main-model caller is currently registered */
export function hasMainLLMRegistered(): boolean {
  return mainLLMCaller !== null;
}

export type AuxLLMProtocol = 'openai' | 'anthropic';

interface AuxLLMEnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: AuxLLMProtocol;
}

// 2026-05-14: add Anthropic protocol support. The original system only used OpenAI Chat Completions;
// gateways like neolink/anthropic-shim only accept /v1/messages, causing 200+HTML false-success pages.
function detectProtocol(baseUrl: string): AuxLLMProtocol {
  const explicit = process.env.AUX_LLM_PROTOCOL?.trim().toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openai') return explicit;
  // Heuristic: URL contains 'anthropic' keyword (api.anthropic.com etc.) → anthropic
  if (/anthropic/i.test(baseUrl)) return 'anthropic';
  return 'openai';
}

function readAuxLLMEnv(): AuxLLMEnvConfig | null {
  const baseUrl = process.env.AUX_LLM_BASE_URL?.trim();
  const apiKey = process.env.AUX_LLM_API_KEY?.trim();
  const model = process.env.AUX_LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model, protocol: detectProtocol(baseUrl) };
}

/** Whether a small model is currently configured via environment variables */
export function isAuxLLMConfigured(): boolean {
  return readAuxLLMEnv() !== null;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Per-call timeout sized to the output the CALLER asked for, instead of one flat ceiling for every aux
 * workload. Aux serves jobs spanning 20x in output size — a 4-token health probe, ~200-token classifiers
 * that block the user's turn (intent router, auth intent), a 2048-token reflection, a 4096-token page
 * distillation — and a flat 60s meant a tiny classifier still SQUATTED a queue slot for a full minute when
 * the endpoint was struggling.
 *
 * That matters because main and aux typically share one endpoint: prod 2026-07-18 saw the shared endpoint
 * answering `Request waiting timeout reached` (its queue full) while philont's own background aux chores
 * each held a slot for 60s, competing with the user's foreground turn. Same shape as the main adapter's
 * adaptive timeout, so both layers reason about latency the same way.
 *
 * Clamped to [8s, DEFAULT_TIMEOUT_MS] so this can only ever SHORTEN a call relative to the old flat value —
 * a 4096-token job still gets the same 60s it always had. An explicit req.timeoutMs overrides entirely
 * (spec compilation legitimately needs minutes).
 */
const AUX_TIMEOUT_BASE_MS = 8_000; // connect + prompt ingest + time to first token
const AUX_TIMEOUT_MS_PER_TOKEN = 15;
const AUX_TIMEOUT_MIN_MS = 8_000;

export function auxTimeoutFor(maxTokens: number | undefined): number {
  const tokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  const computed = AUX_TIMEOUT_BASE_MS + tokens * AUX_TIMEOUT_MS_PER_TOKEN;
  return Math.max(AUX_TIMEOUT_MIN_MS, Math.min(DEFAULT_TIMEOUT_MS, computed));
}

/**
 * Aux thinking policy. 2026-06-07: aux is the cheap small-model path (summaries /
 * classification / compression / reflection). Extended thinking is wasted cost here AND,
 * with DEFAULT_MAX_TOKENS=4096, thinking-capable models (deepseek-v4+/reasoner, kimi) burn
 * the whole budget on the thinking block → `returned empty content` (the reflection failure
 * seen in production). An unset thinking field also leaves DeepSeek's default-on path engaged,
 * risking the reasoning_content echo-400. So we DISABLE thinking explicitly on those models.
 * Opt back in with AUX_LLM_THINKING=on if you ever point aux at a model that needs it.
 */
function auxThinkingDisabled(model: string): boolean {
  if ((process.env.AUX_LLM_THINKING ?? '').trim().toLowerCase() === 'on') return false;
  const m = (model || '').trim().toLowerCase();
  if (m.startsWith('deepseek-v') && !m.startsWith('deepseek-v3')) return true;
  if (m === 'deepseek-reasoner') return true;
  if (m.includes('kimi') || m.includes('moonshot')) return true;
  return false;
}

/**
 * Call the auxiliary LLM.
 *
 * Prefers the small model configured via environment variables; otherwise falls back to the caller
 * registered via registerMainLLM. Throws AuxLLMError(kind='not_configured') when neither is available.
 */
// ── Health tracking (2026-07-16) ──────────────────────────────────────────────────────────────────
// The aux LLM is shared by reflection, the learning judge, auth-intent and the intent router. When its
// endpoint is misconfigured (prod: AUX_LLM_* returning HTTP 404) it fails SILENTLY: each caller degrades
// gracefully (judge → could_not_verify, auth → unclear, reflection → skip), the MAIN agent keeps working,
// and the owner never notices that learning + the judge are quietly dead. These counters + probeAuxLLM make
// that visible.
let auxCallCount = 0;
let auxErrorCount = 0;
let lastAuxError: string | null = null;

export function auxLLMHealth(): { configured: boolean; calls: number; errors: number; lastError: string | null } {
  return { configured: isAuxLLMConfigured(), calls: auxCallCount, errors: auxErrorCount, lastError: lastAuxError };
}

/**
 * One lightweight round-trip to check the aux endpoint actually answers. Returns ok/error WITHOUT throwing,
 * so a caller (server startup) can warn loudly on misconfiguration. When aux is not configured it reports
 * ok:false with a 'not configured' note — the caller decides whether that matters.
 */
export async function probeAuxLLM(signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  if (!isAuxLLMConfigured()) return { ok: false, error: 'not configured (AUX_LLM_* unset)' };
  try {
    const out = await callAuxLLM({ system: 'Reply with the single word: ok', user: 'ping', maxTokens: 4, signal });
    return out && out.trim().length > 0 ? { ok: true } : { ok: false, error: 'empty response' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function callAuxLLM(req: AuxLLMRequest): Promise<string> {
  const envConfig = readAuxLLMEnv();
  auxCallCount++;
  try {
    if (envConfig) {
      return envConfig.protocol === 'anthropic'
        ? await callAnthropicCompatible(envConfig, req)
        : await callOpenAICompatible(envConfig, req);
    }
    if (mainLLMCaller) {
      return await mainLLMCaller(req);
    }
    throw new AuxLLMError(
      'Aux LLM not configured: set AUX_LLM_BASE_URL/AUX_LLM_API_KEY/AUX_LLM_MODEL, ' +
        'or call registerMainLLM() at application startup.',
      'not_configured',
    );
  } catch (e) {
    auxErrorCount++;
    lastAuxError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
}

async function callOpenAICompatible(
  cfg: AuxLLMEnvConfig,
  req: AuxLLMRequest,
): Promise<string> {
  const endpoint = resolveEndpoint(cfg.baseUrl, 'chat/completions');
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.user });

  const body = {
    model: cfg.model,
    messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
    temperature: 0.2,
    // Disable thinking on thinking-capable models (deepseek-v4+/kimi). OpenAI-compat: the field
    // is top-level here (raw fetch; `extra_body` is an SDK-only flatten). See auxThinkingDisabled.
    ...(auxThinkingDisabled(cfg.model) ? { thinking: { type: 'disabled' } } : {}),
  };

  const timeoutMs = req.timeoutMs ?? auxTimeoutFor(req.maxTokens);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = req.signal
    ? anySignal([req.signal, timeoutSignal])
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new AuxLLMError(
        `Aux LLM request timed out after ${timeoutMs}ms`,
        req.signal?.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new AuxLLMError(`Aux LLM network error: ${err.message}`, 'http_error');
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new AuxLLMError(
      `Aux LLM HTTP ${resp.status}: ${detail.slice(0, 500)}`,
      'http_error',
      resp.status,
    );
  }

  // 2026-05-13: read raw text then manually JSON.parse; on failure write the body preview into
  // the error to aid debugging "non-JSON body" (observed in production: deepseek proxies occasionally
  // return an HTML error page / incomplete JSON / SSE residue).
  let bodyText: string;
  try {
    bodyText = await resp.text();
  } catch (e) {
    throw new AuxLLMError(
      `Aux LLM body read failed: ${(e as Error)?.message ?? e}`,
      'invalid_response',
    );
  }

  let json: OpenAIChatResponse;
  try {
    json = JSON.parse(bodyText) as OpenAIChatResponse;
  } catch {
    const ctype = resp.headers.get('content-type') ?? '<no-content-type>';
    // 2026-05-13: categorize common issues and provide a direct troubleshooting hint
    let hint = '';
    if (/text\/html/i.test(ctype)) {
      hint =
        ' [hint] the endpoint returned HTML rather than a JSON API, usually because:' +
        '(1) AUX_LLM_BASE_URL is wrong (missing /v1 / points at a web UI address / wrong protocol prefix);' +
        `(2) model name '${cfg.model}' does not exist at ${cfg.baseUrl}, so the service returns an HTML error page.` +
        ' Make sure BASE_URL points at an OpenAI-compatible /chat/completions endpoint and the model exists.';
    } else if (/^text\/(plain|event-stream)/i.test(ctype)) {
      hint =
        ' [hint] the endpoint returned non-JSON text (possibly SSE / plain text). callAuxLLM does not support streaming; make sure the endpoint does not force SSE.';
    }
    throw new AuxLLMError(
      `Aux LLM returned non-JSON body (status=${resp.status} content-type=${ctype} length=${bodyText.length} model=${cfg.model} url=${cfg.baseUrl}):${hint}\nBODY[0..400]: ${bodyText.slice(0, 400).replace(/\n/g, ' ')}`,
      'invalid_response',
    );
  }

  if (json.error) {
    throw new AuxLLMError(
      `Aux LLM provider error: ${json.error.message ?? 'unknown'}`,
      'http_error',
    );
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new AuxLLMError(
      'Aux LLM returned empty content',
      'invalid_response',
    );
  }
  return content;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  error?: { message?: string; type?: string };
}

async function callAnthropicCompatible(
  cfg: AuxLLMEnvConfig,
  req: AuxLLMRequest,
): Promise<string> {
  const endpoint = resolveEndpoint(cfg.baseUrl, 'messages');

  // Anthropic protocol: system is a top-level field and does not go into the messages array
  const body: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Array<{ role: 'user'; content: string }>;
    thinking?: { type: 'disabled' };
  } = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: req.user }],
  };
  if (req.system) body.system = req.system;
  // Disable thinking on thinking-capable models — see auxThinkingDisabled (fixes empty content).
  if (auxThinkingDisabled(cfg.model)) body.thinking = { type: 'disabled' };

  const timeoutMs = req.timeoutMs ?? auxTimeoutFor(req.maxTokens);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = req.signal
    ? anySignal([req.signal, timeoutSignal])
    : timeoutSignal;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new AuxLLMError(
        `Aux LLM (anthropic) request timed out after ${timeoutMs}ms`,
        req.signal?.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new AuxLLMError(
      `Aux LLM (anthropic) network error: ${err.message}`,
      'http_error',
    );
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new AuxLLMError(
      `Aux LLM (anthropic) HTTP ${resp.status}: ${detail.slice(0, 500)}`,
      'http_error',
      resp.status,
    );
  }

  let bodyText: string;
  try {
    bodyText = await resp.text();
  } catch (e) {
    throw new AuxLLMError(
      `Aux LLM (anthropic) body read failed: ${(e as Error)?.message ?? e}`,
      'invalid_response',
    );
  }

  let json: AnthropicMessagesResponse;
  try {
    json = JSON.parse(bodyText) as AnthropicMessagesResponse;
  } catch {
    const ctype = resp.headers.get('content-type') ?? '<no-content-type>';
    let hint = '';
    if (/text\/html/i.test(ctype)) {
      hint =
        ' [hint] endpoint returned HTML instead of JSON (Anthropic protocol):' +
        '(1) AUX_LLM_BASE_URL may be missing /v1 or pointing at a non-messages path;' +
        `(2) model name '${cfg.model}' may not exist in this gateway's whitelist (neolink/anthropic-shim);` +
        '(3) or this endpoint uses OpenAI protocol — check that AUX_LLM_PROTOCOL is not wrongly set to anthropic.';
    }
    throw new AuxLLMError(
      `Aux LLM (anthropic) returned non-JSON body (status=${resp.status} content-type=${ctype} length=${bodyText.length} model=${cfg.model} url=${cfg.baseUrl}):${hint}\nBODY[0..400]: ${bodyText.slice(0, 400).replace(/\n/g, ' ')}`,
      'invalid_response',
    );
  }

  if (json.error) {
    throw new AuxLLMError(
      `Aux LLM (anthropic) provider error: ${json.error.message ?? 'unknown'}`,
      'http_error',
    );
  }

  const text = json.content?.find((b) => b.type === 'text')?.text;
  if (typeof text !== 'string' || text.length === 0) {
    throw new AuxLLMError(
      'Aux LLM (anthropic) returned empty content',
      'invalid_response',
    );
  }
  return text;
}

/**
 * Build the endpoint from a possibly-partial base URL, tolerating every way people fill AUX_LLM_BASE_URL:
 *   - bare host          (https://api.deepseek.com)                   → add /v1/<method> (matches the MAIN
 *                                                                       adapter: bare-host base + provider path)
 *   - host + version     (https://api.deepseek.com/v1, /api/paas/v4)  → add /<method>   (don't double the version)
 *   - host + non-version (https://neolink.vnet.com/api)               → add /v1/<method> (version still missing)
 *   - full endpoint      (https://api.deepseek.com/v1/chat/completions) → use as-is
 *
 * The historical bug: aux appended only /chat/completions, so a bare-host base (the same value as the main
 * model's) dropped the /v1 → HTTP 404, silently killing reflection / the learning judge / auth-intent
 * (prod 2026-07, "configured same as main, different key"). The discriminator is whether the base path
 * already ENDS in a version segment (/v1, /v4, /v1beta …) — not merely whether it has a path. `method` is
 * 'chat/completions' (OpenAI) or 'messages' (Anthropic); the same tolerance applies to both — an anthropic
 * base ending in /v1 previously double-appended to /v1/v1/messages.
 */
export function resolveEndpoint(baseUrl: string, method: 'chat/completions' | 'messages'): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  // Already the full endpoint (…/chat/completions or …/messages) → use verbatim.
  if (new RegExp(`/${method}$`).test(trimmed)) return trimmed;
  let pathname = '';
  try {
    pathname = new URL(trimmed).pathname.replace(/\/+$/, '');
  } catch {
    /* unparseable — treat as bare host */
  }
  // Path already ends in a version segment → just append the method; otherwise supply the /v1 prefix.
  return /\/v\d+[a-z]*$/.test(pathname) ? `${trimmed}/${method}` : `${trimmed}/v1/${method}`;
}

/**
 * Merge multiple AbortSignals into one — fires when any of them aborts.
 *
 * Node 20+ has a native AbortSignal.any, but the current tsconfig targets ES2022 lib,
 * so this polyfill is used to avoid introducing a runtime detection branch.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener(
      'abort',
      () => controller.abort(s.reason),
      { once: true },
    );
  }
  return controller.signal;
}
