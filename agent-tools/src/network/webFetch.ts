/**
 * webFetch tool - fetch web page content
 *
 * Design reference: Claude Code 2.1.88 WebFetchTool/utils.ts
 *
 * Key capabilities:
 *   1. URL validation (protocol, length, no credentials, parseable)
 *   2. http → https auto-upgrade
 *   3. Same-domain redirects auto-followed; cross-domain redirects **return REDIRECT_DETECTED for the model to re-issue explicitly**
 *      (prevent open redirect attacks + let the agent re-decide)
 *   4. HTML → Markdown conversion (no external deps; includes a lightweight converter)
 *   5. Optional prompt parameter: if given, runs callAuxLLM distillation (extracts per caller intent);
 *      if omitted, returns markdown truncated to maxChars
 *   6. Pre-approved domains (dev-doc sites) take the fast path: skip distillation, return raw content
 *   7. Simple TTL cache (15 minutes) to avoid re-fetching the same URL
 *   8. Named errors (IngestError) let the caller decide to retry / switch source / bounce
 *
 * Differences from the previous implementation:
 *   - Before: regex-stripped HTML, maxLength default 10K, no redirect policy, no distillation, no cache
 *   - Now: all of 1-8 are in place; the model context is no longer polluted by HTML noise
 */

import type { Tool } from '@agent/policy';
import { callAuxLLM, AuxLLMError } from '../utils/aux-llm.js';
import { withRetry } from '../utils/retry.js';
import { extractTitle, htmlToMarkdown } from './html-to-markdown.js';
import { isPreapprovedHost } from './preapproved.js';

// ── Constants ────────────────────────────────────────────────────────

const MAX_URL_LENGTH = 2000;
const MAX_HTTP_CONTENT_BYTES = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; PhilontAgent/1.0; +https://philont.dev)';
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Content truncation before calling aux-llm distillation (avoid stuffing an oversized prompt into the small model)
const DISTILL_INPUT_MAX_CHARS = 60_000;
// Maximum length for pre-approved sites when returning markdown inline — content beyond this is still truncated
const PREAPPROVED_INLINE_MAX = 100_000;

// ── Error class ──────────────────────────────────────────────────────

export type IngestErrorKind =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'too_many_redirects'
  | 'cross_host_redirect'
  | 'http_error'
  | 'timeout'
  | 'aborted'
  | 'response_too_large'
  | 'distill_failed';

export class IngestError extends Error {
  constructor(
    message: string,
    public readonly kind: IngestErrorKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

// ── Cache (lightweight TTL Map, avoids pulling in lru-cache) ─────────

interface CacheEntry {
  expiresAt: number;
  payload: FetchResultPayload;
}

const URL_CACHE = new Map<string, CacheEntry>();

function cacheGet(key: string): FetchResultPayload | undefined {
  const e = URL_CACHE.get(key);
  if (!e) return undefined;
  if (e.expiresAt < Date.now()) {
    URL_CACHE.delete(key);
    return undefined;
  }
  return e.payload;
}

function cacheSet(key: string, payload: FetchResultPayload): void {
  if (URL_CACHE.size >= CACHE_MAX_ENTRIES) {
    // Simple FIFO eviction (Map preserves insertion order)
    const oldest = URL_CACHE.keys().next().value;
    if (oldest !== undefined) URL_CACHE.delete(oldest);
  }
  URL_CACHE.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload,
  });
}

/** For testing only */
export function clearWebFetchCache(): void {
  URL_CACHE.clear();
}

// ── URL validation / upgrade ──────────────────────────────────────────

function validateAndUpgradeUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new IngestError(
      `URL too long (${raw.length} chars > ${MAX_URL_LENGTH})`,
      'invalid_url',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new IngestError(`Invalid URL: ${raw}`, 'invalid_url');
  }
  if (parsed.username || parsed.password) {
    throw new IngestError(
      'URL must not contain credentials',
      'invalid_url',
    );
  }
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  } else if (parsed.protocol !== 'https:') {
    throw new IngestError(
      `Unsupported protocol: ${parsed.protocol}`,
      'unsupported_protocol',
    );
  }
  // Must have a parseable hostname (at least one dot, filters out single-label hostnames)
  const parts = parsed.hostname.split('.');
  if (parts.length < 2 || parts.some((p) => p.length === 0)) {
    throw new IngestError(`Invalid hostname: ${parsed.hostname}`, 'invalid_url');
  }
  return parsed;
}

/** Same domain ±www. is treated as a permitted redirect; all other cross-domain redirects require the caller to re-decide. */
function isPermittedRedirect(orig: URL, redirect: URL): boolean {
  if (redirect.protocol !== orig.protocol) return false;
  if (redirect.port !== orig.port) return false;
  if (redirect.username || redirect.password) return false;
  const stripWww = (h: string) => h.replace(/^www\./, '');
  return stripWww(orig.hostname) === stripWww(redirect.hostname);
}

// ── HTTP fetch (with custom redirect policy) ─────────────────────────

interface FetchSuccess {
  kind: 'success';
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
}

interface FetchRedirect {
  kind: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  status: number;
}

type FetchOutcome = FetchSuccess | FetchRedirect;

async function fetchWithRedirectPolicy(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<FetchOutcome> {
  if (depth > MAX_REDIRECTS) {
    throw new IngestError(
      `Too many redirects (>${MAX_REDIRECTS})`,
      'too_many_redirects',
    );
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Accept: 'text/markdown, text/html;q=0.9, */*;q=0.1',
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // We handle redirects ourselves to avoid fetch's default cross-domain following
      redirect: 'manual',
      signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      throw new IngestError(
        `Fetch timed out or aborted: ${err.message}`,
        signal.aborted ? 'aborted' : 'timeout',
      );
    }
    throw new IngestError(`Network error: ${err.message}`, 'http_error');
  }

  // Redirects: 301/302/303/307/308
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('location');
    if (!location) {
      throw new IngestError(
        `Redirect ${resp.status} missing Location header`,
        'http_error',
        resp.status,
      );
    }
    const redirectUrl = new URL(location, url).toString();
    const orig = new URL(url);
    const next = new URL(redirectUrl);
    if (isPermittedRedirect(orig, next)) {
      return fetchWithRedirectPolicy(redirectUrl, signal, depth + 1);
    }
    return {
      kind: 'redirect',
      originalUrl: url,
      redirectUrl,
      status: resp.status,
    };
  }

  if (!resp.ok) {
    throw new IngestError(
      `HTTP ${resp.status} ${resp.statusText}`,
      'http_error',
      resp.status,
    );
  }

  const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';

  // Read up to MAX_HTTP_CONTENT_BYTES. fetch has no native size cap; we use
  // ArrayBuffer and slice — this has no side effects for the vast majority of pages.
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_HTTP_CONTENT_BYTES) {
    throw new IngestError(
      `Response too large (${buf.byteLength} bytes > ${MAX_HTTP_CONTENT_BYTES})`,
      'response_too_large',
    );
  }
  const body = new TextDecoder('utf-8', { fatal: false }).decode(buf);

  return {
    kind: 'success',
    finalUrl: url,
    status: resp.status,
    contentType,
    body,
    bytes: buf.byteLength,
  };
}

// ── Distillation ─────────────────────────────────────────────────────

const SECONDARY_SYSTEM_PROMPT =
  'You extract information from web page content per the user\'s instructions. ' +
  'Reply concisely; quote sparingly (max 125 chars per quote); never reproduce song lyrics.';

function buildDistillUser(content: string, prompt: string): string {
  return `Web page content:\n---\n${content}\n---\n\n${prompt}\n\nProvide a concise response based only on the content above.`;
}

// ── Tool result payload ──────────────────────────────────────────────

interface FetchResultPayload {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  /** The body actually returned to the model (already distilled or truncated) */
  text: string;
  /** Whether the content was truncated */
  truncated: boolean;
  /** Extraction method: raw/markdown/distilled/preapproved/redirect/native/scraper/arxiv-atom */
  extractor:
    | 'raw'
    | 'markdown'
    | 'distilled'
    | 'preapproved'
    | 'redirect'
    | 'native'
    | 'scraper'
    | 'arxiv-atom';
  /** Raw markdown length (before truncation/distillation) */
  rawLength: number;
  fetchedAt: string;
  tookMs: number;
}

function renderRedirectPayload(
  url: string,
  outcome: FetchRedirect,
  tookMs: number,
): FetchResultPayload {
  const statusText =
    outcome.status === 301
      ? 'Moved Permanently'
      : outcome.status === 308
        ? 'Permanent Redirect'
        : outcome.status === 307
          ? 'Temporary Redirect'
          : outcome.status === 303
            ? 'See Other'
            : 'Found';
  const message =
    `REDIRECT DETECTED: The URL redirects to a different host.\n\n` +
    `Original URL: ${outcome.originalUrl}\n` +
    `Redirect URL: ${outcome.redirectUrl}\n` +
    `Status: ${outcome.status} ${statusText}\n\n` +
    `To complete your request, call webFetch again with url="${outcome.redirectUrl}".`;
  return {
    url,
    finalUrl: outcome.redirectUrl,
    status: outcome.status,
    contentType: 'text/plain',
    text: message,
    truncated: false,
    extractor: 'redirect',
    rawLength: message.length,
    fetchedAt: new Date().toISOString(),
    tookMs,
  };
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: text.slice(0, max) + '\n\n[Content truncated due to length...]',
    truncated: true,
  };
}

// ── Main entry point ─────────────────────────────────────────────────

interface WebFetchInput {
  url: string;
  /** Optional — if given, runs aux-llm distillation and extracts per prompt */
  prompt?: string;
  /** Extraction mode: markdown preserves links/headings; text is plain text only. Default markdown */
  extractMode?: 'markdown' | 'text';
  /** Maximum output characters. Default 100000 */
  maxChars?: number;
}

async function runWebFetch(input: WebFetchInput): Promise<FetchResultPayload> {
  const start = Date.now();
  const parsed = validateAndUpgradeUrl(input.url);
  const upgradedUrl = parsed.toString();
  const extractMode = input.extractMode ?? 'markdown';
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const cacheKey = `${upgradedUrl}::${extractMode}::${maxChars}::${input.prompt ?? ''}`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const outcome = await fetchWithRedirectPolicy(upgradedUrl, signal);

  if (outcome.kind === 'redirect') {
    const payload = renderRedirectPayload(input.url, outcome, Date.now() - start);
    cacheSet(cacheKey, payload);
    return payload;
  }

  // Non-HTML (JSON/plain text/server-rendered markdown) treated directly as text
  let title: string | undefined;
  let markdown: string;
  let extractor: FetchResultPayload['extractor'];

  if (outcome.contentType.includes('text/html')) {
    title = extractTitle(outcome.body);
    markdown = htmlToMarkdown(outcome.body, {
      mode: extractMode,
      preserveLinks: extractMode === 'markdown',
      baseUrl: outcome.finalUrl,
    });
    extractor = 'markdown';
  } else if (outcome.contentType.includes('application/json')) {
    try {
      markdown = JSON.stringify(JSON.parse(outcome.body), null, 2);
    } catch {
      markdown = outcome.body;
    }
    extractor = 'raw';
  } else {
    markdown = outcome.body;
    extractor = 'raw';
  }

  const rawLength = markdown.length;

  // Pre-approved site + manageable content length → skip distillation and return directly (Claude Code design)
  const isPreapproved = isPreapprovedHost(parsed.hostname, parsed.pathname);
  if (
    isPreapproved &&
    !input.prompt &&
    rawLength <= PREAPPROVED_INLINE_MAX
  ) {
    const payload: FetchResultPayload = {
      url: input.url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      contentType: outcome.contentType,
      title,
      text: markdown,
      truncated: false,
      extractor: 'preapproved',
      rawLength,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // Caller passed a prompt → take the distillation path
  if (input.prompt) {
    const distillInput =
      rawLength > DISTILL_INPUT_MAX_CHARS
        ? markdown.slice(0, DISTILL_INPUT_MAX_CHARS) + '\n[content truncated]'
        : markdown;
    let distilled: string;
    try {
      distilled = await callAuxLLM({
        system: SECONDARY_SYSTEM_PROMPT,
        user: buildDistillUser(distillInput, input.prompt),
      });
    } catch (e) {
      if (e instanceof AuxLLMError) {
        // On distillation failure, degrade to truncated output but flag it explicitly so the model knows
        const fallback = truncate(markdown, maxChars);
        const payload: FetchResultPayload = {
          url: input.url,
          finalUrl: outcome.finalUrl,
          status: outcome.status,
          contentType: outcome.contentType,
          title,
          text:
            `[NOTE] Aux-LLM distillation failed (${e.kind}: ${e.message}). ` +
            `Returning ${fallback.truncated ? 'truncated' : 'full'} markdown instead.\n\n` +
            fallback.text,
          truncated: fallback.truncated,
          extractor: 'markdown',
          rawLength,
          fetchedAt: new Date().toISOString(),
          tookMs: Date.now() - start,
        };
        cacheSet(cacheKey, payload);
        return payload;
      }
      throw e;
    }
    const payload: FetchResultPayload = {
      url: input.url,
      finalUrl: outcome.finalUrl,
      status: outcome.status,
      contentType: outcome.contentType,
      title,
      text: distilled,
      truncated: rawLength > DISTILL_INPUT_MAX_CHARS,
      extractor: 'distilled',
      rawLength,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
    };
    cacheSet(cacheKey, payload);
    return payload;
  }

  // No prompt → return markdown directly with tail truncation
  const t = truncate(markdown, maxChars);
  const payload: FetchResultPayload = {
    url: input.url,
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    contentType: outcome.contentType,
    title,
    text: t.text,
    truncated: t.truncated,
    extractor,
    rawLength,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
  };
  cacheSet(cacheKey, payload);
  return payload;
}

function formatPayload(p: FetchResultPayload): string {
  // Similar to Claude Code — return metadata and body together. Structured fields first, body after.
  // The model gets key facts (url/title/extractor) and can also continue reading the full text.
  const meta = [
    `URL: ${p.url}`,
    p.finalUrl !== p.url ? `Final URL: ${p.finalUrl}` : null,
    p.title ? `Title: ${p.title}` : null,
    `Status: ${p.status}`,
    `Extractor: ${p.extractor}`,
    p.truncated ? `Truncated: true (raw length ${p.rawLength})` : null,
    `Fetched in ${p.tookMs}ms`,
  ]
    .filter(Boolean)
    .join('\n');
  return `${meta}\n\n---\n\n${p.text}`;
}

// ── arxiv → HTML routing (2026-06-17) ────────────────────────────────────────
// arxiv blocks aggressive PDF scraping (export.arxiv.org/pdf/… returns HTTP 403). It DOES serve a
// fetch-friendly HTML rendering: arxiv.org/html/<id> (native, 2024+) and ar5iv (older papers). When the
// model asks for an arxiv pdf/abs URL, try the HTML versions first; fall back to the original last.
const ARXIV_HOST_RE = /(^|\.)(arxiv\.org|export\.arxiv\.org)$/i;

/** Extract the bare arxiv id from a pdf/abs/html URL, or null if not a recognizable arxiv paper URL. */
export function arxivId(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!ARXIV_HOST_RE.test(u.hostname)) return null;
  // /pdf/<id>(.pdf)?  or  /abs/<id>  or  /html/<id> — id: new (2401.01234v2) or old (math/0309136)
  const m = u.pathname.match(/\/(?:pdf|abs|html)\/(.+?)(?:\.pdf)?\/?$/i);
  if (!m) return null;
  const id = m[1];
  if (!/^([a-z-]+(\.[A-Za-z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?$/i.test(id)) return null;
  return id;
}

export function arxivCandidates(rawUrl: string): string[] | null {
  const id = arxivId(rawUrl);
  if (!id) return null;
  return [
    `https://arxiv.org/html/${id}`,
    `https://ar5iv.labs.arxiv.org/html/${id}`,
    rawUrl, // original (likely 403 for pdf) as last resort
  ];
}

// ── Native server-side web_fetch tier (2026-06-17) ───────────────────────────
// Route the fetch through the provider's SERVER-SIDE web_fetch tool (same Anthropic-compatible endpoint as
// native web_search → DeepSeek in this deployment). The fetch then runs on the provider's infrastructure, not
// our process — so sites that 403 our direct GET (arxiv export, baidu, erdosproblems) succeed. Fully
// fallback-safe: any failure (no key, endpoint doesn't support the tool, parse miss) falls back to direct HTTP.
let nativeFetchSupported: boolean | null = null; // null=unknown, true=works, false=endpoint rejected the tool

/** Recursively collect text from a (web_fetch_tool_result) block subtree, tolerant of exact nesting. */
export function collectText(node: unknown, out: string[], budget: { n: number }): void {
  if (budget.n <= 0 || node == null) return;
  if (typeof node === 'string') return; // bare strings are usually ids/urls; only take labelled text below
  if (Array.isArray(node)) {
    for (const x of node) collectText(x, out, budget);
    return;
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o.text === 'string') {
      out.push(o.text);
      budget.n -= o.text.length;
    }
    if (typeof o.data === 'string' && typeof o.media_type === 'string' && o.media_type.includes('text')) {
      out.push(o.data);
      budget.n -= o.data.length;
    }
    for (const k of ['content', 'source', 'document', 'result']) if (k in o) collectText(o[k], out, budget);
  }
}

async function fetchNative(input: WebFetchInput): Promise<FetchResultPayload> {
  if (nativeFetchSupported === false) throw new Error('native web_fetch unsupported on this endpoint');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseURL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash';
  const toolType = process.env.PHILONT_WEB_FETCH_NATIVE_TOOL || 'web_fetch_20260209';
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const start = Date.now();

  const resp = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: `Use web_fetch to retrieve this URL and return its content. URL: ${input.url}` }],
      tools: [{ type: toolType, name: 'web_fetch', max_uses: 1 }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    // 4xx = the endpoint rejected the web_fetch tool (unsupported / bad param) → stop trying native this process.
    if (resp.status >= 400 && resp.status < 500) nativeFetchSupported = false;
    throw new Error(`native web_fetch HTTP ${resp.status}`);
  }
  nativeFetchSupported = true;
  const data = (await resp.json()) as { content?: Array<{ type?: string; content?: unknown }> };
  const out: string[] = [];
  const budget = { n: maxChars };
  for (const block of data.content ?? []) {
    if (typeof block?.type !== 'string' || !block.type.includes('web_fetch')) continue;
    const inner = block.content as { type?: string; error_code?: string } | unknown;
    if (inner && !Array.isArray(inner) && (inner as { type?: string }).type?.includes('error')) {
      throw new Error(`native web_fetch tool error: ${(inner as { error_code?: string }).error_code ?? 'unknown'}`);
    }
    collectText(block.content, out, budget);
  }
  const joined = out.join('\n').trim();
  if (!joined) throw new Error('native web_fetch returned no content');
  const { text, truncated } = truncate(joined, maxChars);
  return {
    url: input.url,
    finalUrl: input.url,
    status: 200,
    contentType: 'text/markdown',
    text,
    truncated,
    extractor: 'native',
    rawLength: joined.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
  };
}

// ── Scraper backend tier (2026-06-19) ────────────────────────────────────────
// Pattern adapted from hermes-agent (tools/web_tools.py `web_extract_tool`): dispatch the fetch to a
// third-party scraper backend that retrieves the page from THE PROVIDER's IP, not our process — so sites
// that 403 our direct GET (arxiv, huggingface, baidu, …) succeed without per-domain hacks. The backend is
// auto-selected from env keys (Firecrawl/Tavily); keyless Jina Reader is opt-in via
// PHILONT_WEB_FETCH_BACKEND=jina. When nothing is configured the tier is skipped, leaving the baseline
// native→direct behavior unchanged. Fully fallback-safe: any failure falls through to the direct-HTTP path.
type ScraperBackend = 'jina' | 'tavily' | 'firecrawl';

function pickScraperBackend(): ScraperBackend | null {
  const explicit = process.env.PHILONT_WEB_FETCH_BACKEND?.trim().toLowerCase();
  if (explicit === 'off' || explicit === 'none' || explicit === '0') return null;
  if (explicit === 'jina' || explicit === 'tavily' || explicit === 'firecrawl') return explicit;
  // Auto-detect by available key. Keyless Jina is NOT enabled implicitly — routing every
  // URL through a third-party reader by default is a privacy/dependency surprise and changes
  // baseline fetch behavior; opt in explicitly with PHILONT_WEB_FETCH_BACKEND=jina.
  if (process.env.FIRECRAWL_API_KEY) return 'firecrawl';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  return null;
}

/** Jina Reader (r.jina.ai) — keyless by default; reads from Jina's IP and returns markdown. */
async function scrapeJina(url: string): Promise<string> {
  const key = process.env.JINA_API_KEY?.trim();
  const resp = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      'X-Return-Format': 'markdown',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`jina reader HTTP ${resp.status}`);
  return await resp.text();
}

/** Tavily extract — reuses the TAVILY_API_KEY already wired for native web search. */
async function scrapeTavily(url: string): Promise<string> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set');
  const resp = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [url], extract_depth: 'advanced', format: 'markdown' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`tavily extract HTTP ${resp.status}`);
  const data = (await resp.json()) as { results?: Array<{ raw_content?: string; content?: string }> };
  const r = data.results?.[0];
  return (r?.raw_content || r?.content || '').toString();
}

/** Firecrawl cloud (or self-hosted via FIRECRAWL_API_URL) scrape → markdown. */
async function scrapeFirecrawl(url: string): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY not set');
  const baseURL = (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/+$/, '');
  const resp = await fetch(`${baseURL}/v2/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url, formats: ['markdown'] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`firecrawl scrape HTTP ${resp.status}`);
  const data = (await resp.json()) as { data?: { markdown?: string } };
  const md = data.data?.markdown;
  if (!md) throw new Error('firecrawl returned no markdown');
  return md;
}

async function fetchScraper(input: WebFetchInput, backend: ScraperBackend): Promise<FetchResultPayload> {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const start = Date.now();
  const md =
    backend === 'jina'
      ? await scrapeJina(input.url)
      : backend === 'tavily'
        ? await scrapeTavily(input.url)
        : await scrapeFirecrawl(input.url);
  const joined = md.trim();
  if (!joined) throw new Error(`scraper(${backend}) returned no content`);
  const { text, truncated } = truncate(joined, maxChars);
  return {
    url: input.url,
    finalUrl: input.url,
    status: 200,
    contentType: 'text/markdown',
    text,
    truncated,
    extractor: 'scraper',
    rawLength: joined.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
  };
}

// ── arxiv Atom export API (2026-06-19) ───────────────────────────────────────
// Pattern adapted from hermes-agent (skills/research/arxiv/scripts/search_arxiv.py): arxiv's Atom export
// endpoint (export.arxiv.org/api/query) is fetch-friendly and does NOT 403 our IP, unlike the PDF host. It
// returns title + authors + abstract — a guaranteed metadata fallback when full-text HTML can't be fetched.
function xmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

async function fetchArxivAtom(id: string, input: WebFetchInput): Promise<FetchResultPayload> {
  const start = Date.now();
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  const resp = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`arxiv atom HTTP ${resp.status}`);
  const xml = await resp.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
  if (!entry) throw new Error('arxiv atom: no <entry> for id');
  const title = xmlField(entry, 'title');
  const summary = xmlField(entry, 'summary');
  const published = xmlField(entry, 'published');
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join(', ');
  const body = [
    `# ${title}`,
    authors ? `**Authors:** ${authors}` : null,
    published ? `**Published:** ${published}` : null,
    `**arXiv:** ${id} — https://arxiv.org/abs/${id}`,
    '',
    '## Abstract',
    summary,
    '',
    '[NOTE] Full text could not be fetched; this is the arXiv abstract + metadata via the Atom export API.',
  ]
    .filter((x) => x !== null)
    .join('\n');
  const { text, truncated } = truncate(body, maxChars);
  return {
    url: input.url,
    finalUrl: `https://arxiv.org/abs/${id}`,
    status: 200,
    contentType: 'text/markdown',
    title: title || undefined,
    text,
    truncated,
    extractor: 'arxiv-atom',
    rawLength: body.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
  };
}

/**
 * One URL, tried through three tiers in order, each running off a different IP so an our-IP 403 never ends
 * the chain: (1) provider server-side web_fetch, (2) third-party scraper backend, (3) direct HTTP.
 */
async function fetchOne(input: WebFetchInput): Promise<FetchResultPayload> {
  // Tier 1: provider server-side web_fetch (fetches from the LLM provider's infra).
  try {
    const r = await fetchNative(input);
    console.log(`[webFetch] backend=native url=${input.url}`);
    return r;
  } catch (e) {
    const reason =
      nativeFetchSupported === false
        ? 'endpoint does not support the web_fetch tool (latched off)'
        : (e as Error)?.message ?? String(e);
    console.log(`[webFetch] backend=native unavailable (${reason}) url=${input.url}`);
  }
  // Tier 2: third-party scraper backend (fetches from the scraper provider's IP).
  const backend = pickScraperBackend();
  if (backend) {
    try {
      const r = await fetchScraper(input, backend);
      console.log(`[webFetch] backend=scraper:${backend} url=${input.url}`);
      return r;
    } catch (e) {
      console.log(
        `[webFetch] backend=scraper:${backend} unavailable (${(e as Error)?.message ?? String(e)}) url=${input.url}`,
      );
    }
  }
  // Tier 3: direct HTTP from our process (last resort; subject to our-IP 403).
  console.log(`[webFetch] backend=direct url=${input.url}`);
  return withRetry(() => runWebFetch(input), {
    isRetryable: (e) => e instanceof IngestError && (e.kind === 'timeout' || e.kind === 'aborted'),
  });
}

export const webFetchTool: Tool = {
  name: 'webFetch',
  description: [
    'Fetch URL content and extract it as Markdown / plain text; can call an auxiliary LLM to do structured extraction per a prompt.',
    'Behavior contract:',
    '  - url is required; prompt is optional (if given, distills per intent; if not, returns truncated markdown)',
    '  - http is auto-upgraded to https',
    '  - cross-host redirects are not auto-followed; returns REDIRECT_DETECTED so you re-issue explicitly',
    '  - pre-approved hosts (dev-doc sites) skip distillation and return the raw content',
    '  - default output cap is 100K characters; adjustable via maxChars',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP/HTTPS URL' },
      prompt: {
        type: 'string',
        description: 'Optional: if given, an auxiliary LLM extracts content per this prompt; if omitted, returns truncated markdown',
      },
      extractMode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: 'Extraction mode, default markdown (preserves heading/link structure)',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum output characters, default 100000',
      },
    },
    required: ['url'],
  },
  capability: 'read',
  domain: 'network',
  async execute(params) {
    const reqUrl = params.url as string;
    const opts = {
      prompt: params.prompt as string | undefined,
      extractMode: params.extractMode as 'markdown' | 'text' | undefined,
      maxChars: params.maxChars as number | undefined,
    };
    // arxiv pdf/abs → try HTML renderings first (PDF 403s); other URLs → just the one. Each candidate goes
    // through fetchOne (native → scraper → direct HTTP).
    const candidates = arxivCandidates(reqUrl) ?? [reqUrl];
    let lastErr: unknown;
    for (const url of candidates) {
      try {
        const payload = await fetchOne({ url, ...opts });
        return { success: true, output: formatPayload(payload) };
      } catch (e) {
        lastErr = e;
      }
    }
    // arxiv guaranteed fallback: if every full-text candidate failed, return the abstract + metadata via the
    // Atom export API, which is served off export.arxiv.org and does not 403 our IP.
    const axId = arxivId(reqUrl);
    if (axId) {
      try {
        const payload = await fetchArxivAtom(axId, { url: reqUrl, ...opts });
        console.log(`[webFetch] backend=arxiv-atom id=${axId}`);
        return { success: true, output: formatPayload(payload) };
      } catch (e) {
        lastErr = e;
      }
    }
    {
      const e = lastErr;
      if (e instanceof IngestError) {
        return {
          success: false,
          output: '',
          error: `Fetch failed (${e.kind}${e.status ? `, HTTP ${e.status}` : ''}): ${e.message}`,
        };
      }
      const err = e as Error;
      return {
        success: false,
        output: '',
        error: `Fetch failed: ${err.message ?? String(e)}`,
      };
    }
  },
};
