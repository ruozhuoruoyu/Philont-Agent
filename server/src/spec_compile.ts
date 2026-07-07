/**
 * Spec compiler (spec_regime.md increment 1) — "the model understands prose; the mechanism
 * validates truth."
 *
 * A guide/API doc is a CONTRACT. The regex endpoint anchor simulated understanding of prose with
 * regexes and produced a patch treadmill (tables unseen → $VAR curls unseen → base prefix unseen —
 * each a production cycle). This module hands prose comprehension to the aux LLM under a strict
 * JSON contract, then applies what mechanisms are actually good at:
 *   - deterministic shape validation (methods legal, paths absolute, hosts real),
 *   - cross-check against the regex extractor (regex is the FLOOR: its hits are merged in, so the
 *     compiler can only ever widen coverage, never lose what the old path had),
 *   - content-hash caching (one compile per guide version per process).
 *
 * Failure of any kind returns null and the caller keeps the regex anchor verbatim — the upgrade is
 * incremental, never a bet. Kill switch: PHILONT_SPEC_COMPILE=0.
 */

import { createHash } from 'node:crypto';
import type { AuxLLMCaller } from '@agent/tools';
import type { GuideApi } from './plan_execute_loop.js';

export interface SpecEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute, base-resolved path as it must be SENT (e.g. /api/comments). */
  path: string;
  /** One-line purpose, for the registry and for deliverable typing. */
  purpose?: string;
  /** Required body/query field names, when the guide documents them. */
  requiredFields?: string[];
}

export interface SpecDoc {
  source: { contentHash: string; url?: string };
  service: { name: string; hosts: string[] };
  /** Common path prefix endpoints are resolved against (informational; paths are already resolved). */
  basePath?: string;
  auth?: { scheme?: string; header?: string };
  endpoints: SpecEndpoint[];
  /** Hard preconditions the guide states (e.g. "first session must publish one post"). */
  preconditions: string[];
  /** Behavioral rules/constraints (e.g. "no content-free comments"). */
  rules: string[];
  confidence: number;
}

export function specCompileEnabled(): boolean {
  const v = (process.env.PHILONT_SPEC_COMPILE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function guideContentHash(guideText: string): string {
  return createHash('sha256').update(guideText).digest('hex').slice(0, 16);
}

const COMPILE_SYSTEM =
  'You are a precise API-spec extractor. Output ONLY a JSON object, no markdown fences, no prose.';

function buildCompilePrompt(guideText: string): string {
  return [
    'Extract the machine-actionable spec from this service guide.',
    'Output JSON exactly in this shape:',
    '{"service":{"name":"<short-slug>","hosts":["host.tld"]},',
    ' "basePath":"/api",',
    ' "auth":{"scheme":"bearer","header":"Authorization"},',
    ' "endpoints":[{"method":"POST","path":"/api/comments","purpose":"create comment","requiredFields":["post_id","body"]}],',
    ' "preconditions":["..."], "rules":["..."]}',
    'Hard requirements:',
    '- paths must be ABSOLUTE and base-resolved: if the guide defines BASE_URL="https://host/api" and',
    '  documents `/comments`, the path is `/api/comments`. Every path starts with "/".',
    '- hosts: bare hostnames only, no scheme, no placeholder/example hosts.',
    '- include EVERY documented endpoint (tables, curl examples, prose).',
    '- requiredFields: only when the guide names them; field names verbatim.',
    '- preconditions: mandatory acts (registration, first-post rules); rules: behavioral constraints.',
    '- No commentary. JSON only.',
    '',
    '--- GUIDE ---',
    guideText.slice(0, 50_000),
  ].join('\n');
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Deterministic shape validation. Returns a cleaned SpecDoc core or null (unusable). */
function validateCompiled(raw: unknown, contentHash: string): SpecDoc | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const svc = o.service as Record<string, unknown> | undefined;
  const hosts = Array.isArray(svc?.hosts)
    ? (svc!.hosts as unknown[])
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter((h) => /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h))
    : [];
  const endpoints: SpecEndpoint[] = [];
  if (Array.isArray(o.endpoints)) {
    for (const e of o.endpoints as Array<Record<string, unknown>>) {
      if (typeof e !== 'object' || e === null) continue;
      const method = String(e.method ?? '').toUpperCase();
      const path = String(e.path ?? '').trim();
      if (!METHODS.has(method) || !path.startsWith('/') || path.length < 2 || /\s/.test(path)) continue;
      endpoints.push({
        method: method as SpecEndpoint['method'],
        path: path.slice(0, 120),
        purpose: typeof e.purpose === 'string' ? e.purpose.slice(0, 120) : undefined,
        requiredFields: Array.isArray(e.requiredFields)
          ? (e.requiredFields as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 12)
          : undefined,
      });
    }
  }
  if (hosts.length === 0 || endpoints.length === 0) return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string').map((s) => s.slice(0, 200)).slice(0, 20) : [];
  const auth = o.auth as Record<string, unknown> | undefined;
  return {
    source: { contentHash },
    service: {
      name: typeof svc?.name === 'string' ? (svc.name as string).slice(0, 40) : hosts[0],
      hosts: [...new Set(hosts)].slice(0, 4),
    },
    basePath: typeof o.basePath === 'string' ? (o.basePath as string).slice(0, 40) : undefined,
    auth: auth
      ? {
          scheme: typeof auth.scheme === 'string' ? (auth.scheme as string).slice(0, 20) : undefined,
          header: typeof auth.header === 'string' ? (auth.header as string).slice(0, 40) : undefined,
        }
      : undefined,
    endpoints: dedupeEndpoints(endpoints).slice(0, 60),
    preconditions: strList(o.preconditions),
    rules: strList(o.rules),
    confidence: 1,
  };
}

function dedupeEndpoints(eps: SpecEndpoint[]): SpecEndpoint[] {
  const seen = new Set<string>();
  const out: SpecEndpoint[] = [];
  for (const e of eps) {
    const k = `${e.method} ${e.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/**
 * Cross-check: the regex extractor is the floor. Any "METHOD /path" it found that the compiled
 * spec lacks is merged in (marked as regex-sourced in purpose), and confidence drops — an LLM that
 * missed documented calls may have missed more.
 */
export function mergeRegexFloor(spec: SpecDoc, regexApi: GuideApi): SpecDoc {
  const have = new Set(spec.endpoints.map((e) => `${e.method} ${e.path}`));
  let merged = 0;
  const extra: SpecEndpoint[] = [];
  for (const entry of regexApi.endpoints) {
    const m = entry.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/);
    if (!m) continue; // bare paths without a method stay in the GuideApi union below
    if (have.has(`${m[1]} ${m[2]}`)) continue;
    extra.push({ method: m[1] as SpecEndpoint['method'], path: m[2], purpose: 'regex-extracted (LLM missed)' });
    merged++;
  }
  const hosts = [...new Set([...spec.service.hosts, ...regexApi.hosts])];
  if (merged === 0 && hosts.length === spec.service.hosts.length) return spec;
  return {
    ...spec,
    service: { ...spec.service, hosts },
    endpoints: dedupeEndpoints([...spec.endpoints, ...extra]),
    confidence: merged > 0 ? Math.max(0.3, spec.confidence - 0.15 * merged) : spec.confidence,
  };
}

/** Adapter: SpecDoc → the GuideApi shape every existing consumer (registry/guards) reads. */
export function specToGuideApi(spec: SpecDoc): GuideApi {
  return {
    hosts: spec.service.hosts,
    endpoints: spec.endpoints.map((e) => `${e.method} ${e.path}`),
  };
}

// One compile per guide version per process. Increment 3 persists this as a service skill.
const specCache = new Map<string, SpecDoc | null>();

/** Test hook. */
export function clearSpecCache(): void {
  specCache.clear();
}

/**
 * Spec-driven body guard: for a documented endpoint, a write request whose body is not a JSON
 * object (prod: POST /api/posts got a 2945-char raw-markdown string body → server 500 "Failed to
 * create post") or is missing documented required fields is rejected BEFORE sending, with a
 * corrective message naming the expected shape. Only enforced when the spec actually documents the
 * endpoint; endpoints without requiredFields only get the JSON-object check. Generic — everything
 * comes from the SpecDoc.
 */
export function specBodyGuardReject(
  toolName: string,
  input: Record<string, unknown>,
  spec: SpecDoc,
): { error: string } | null {
  if (toolName !== 'http') return null;
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!/^(POST|PUT|PATCH)$/.test(method)) return null;
  let u: URL;
  try {
    u = new URL(String(input.url ?? ''));
  } catch {
    return null;
  }
  if (!spec.service.hosts.includes(u.host.toLowerCase())) return null;
  const ep = spec.endpoints.find((e) => {
    if (e.method !== method) return false;
    // Param segments (:id / $VAR / {id}) match any one path segment.
    const pattern = e.path
      .split('/')
      .map((seg) => (/^[:$]|^\{/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return new RegExp(`^${pattern}/?$`).test(u.pathname);
  });
  if (!ep) return null;
  const raw = input.body;
  let parsed: Record<string, unknown> | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    } else if (typeof raw === 'string') {
      try {
        const p = JSON.parse(raw) as unknown;
        if (typeof p === 'object' && p !== null && !Array.isArray(p)) parsed = p as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
  }
  const fieldsDoc = ep.requiredFields?.length
    ? `Required fields: ${ep.requiredFields.join(', ')}.`
    : 'Send a JSON object body.';
  if (raw !== undefined && raw !== null && parsed === null) {
    return {
      error:
        `[spec body guard] ${method} ${ep.path} expects a JSON OBJECT body, but the body is ` +
        `${typeof raw === 'string' ? `a raw string (${(raw as string).length} chars — likely your content pasted directly)` : `of type ${Array.isArray(raw) ? 'array' : typeof raw}`}. ` +
        `${fieldsDoc} Wrap your content in the documented fields, e.g. body: {${(ep.requiredFields ?? ['...']).map((f) => `"${f}": "..."`).join(', ')}}.`,
    };
  }
  if (ep.requiredFields?.length) {
    const have = new Set(Object.keys(parsed ?? {}));
    const missing = ep.requiredFields.filter((f) => !have.has(f));
    if (missing.length > 0) {
      return {
        error:
          `[spec body guard] ${method} ${ep.path} body is missing documented required field(s): ` +
          `${missing.join(', ')}. ${fieldsDoc} Do not send until every required field is present.`,
      };
    }
  }
  return null;
}

export interface CompileSpecDeps {
  call: AuxLLMCaller;
  log?: (msg: string) => void;
  signal?: AbortSignal;
}

/**
 * Compile a guide into a SpecDoc. Null on ANY failure (disabled / LLM error / unparseable /
 * fails validation) — the caller keeps the regex anchor. Results (including null) are cached by
 * content hash so a broken compile is not retried every round within a process lifetime.
 */
export async function compileSpec(
  guideText: string,
  regexApi: GuideApi,
  deps: CompileSpecDeps,
): Promise<SpecDoc | null> {
  if (!specCompileEnabled()) return null;
  const hash = guideContentHash(guideText);
  if (specCache.has(hash)) return specCache.get(hash) ?? null;
  const log = deps.log ?? (() => {});
  let result: SpecDoc | null = null;
  try {
    const raw = await deps.call({
      system: COMPILE_SYSTEM,
      user: buildCompilePrompt(guideText),
      maxTokens: 4000,
      signal: deps.signal,
    });
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonText) as unknown;
    const validated = validateCompiled(parsed, hash);
    if (validated) {
      result = mergeRegexFloor(validated, regexApi);
      log(
        `[spec-compile] hash=${hash} endpoints=${result.endpoints.length} ` +
          `(llm=${validated.endpoints.length}, regex-merged=${result.endpoints.length - validated.endpoints.length}) ` +
          `preconditions=${result.preconditions.length} rules=${result.rules.length} confidence=${result.confidence.toFixed(2)}`,
      );
    } else {
      log(`[spec-compile] hash=${hash} compile output failed validation — keeping regex anchor`);
    }
  } catch (e) {
    log(`[spec-compile] hash=${hash} failed (${(e as Error)?.message ?? String(e)}) — keeping regex anchor`);
  }
  specCache.set(hash, result);
  return result;
}
