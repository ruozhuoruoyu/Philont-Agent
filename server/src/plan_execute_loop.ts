/**
 * Mechanism-driven plan–execute loop (docs/design/plan_execute_loop.md).
 *
 * The fixed workflow — read spec → draft plan → VERIFY coverage → revise until it passes →
 * execute with tool evidence → close — as a DETERMINISTIC STATE MACHINE. The model only fills
 * in each state's content; it cannot change states, skip VERIFY, or self-declare completion.
 * This is what makes the workflow hold on weak / edge-deployed models: transitions are computed
 * by code, completion is gated on real tool evidence, so process correctness does not depend on
 * the model's protocol discipline (prod: a weak model would not call plan_revise and declared
 * "注册完成" at the gate wall — the loop was policy, so it escaped).
 *
 * v1 scope: spec tier 1 only (external guide URL in the user message). Tier 2 (literal asks)
 * and tier 3 (model-drafted criteria) plug in later via the same SpecItem[] interface. Tier 4
 * (quality/exploration tasks) never enters — that is deep_explore's domain.
 *
 * Flag: PHILONT_PLAN_LOOP (default ON; set 0/off/false/no to fall back to the legacy
 * placeholder+gate path).
 */

import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopToolRunResult,
} from '@agent/tools';
import type { ToolDefinition } from '@agent/policy';

// ── Flag ────────────────────────────────────────────────────────────────────

export function planLoopEnabled(): boolean {
  const v = (process.env.PHILONT_PLAN_LOOP ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// ── Spec extraction (tier 1: external guide text) ──────────────────────────

export interface SpecItem {
  /** Stable id, e.g. "part-1-register" */
  id: string;
  /** The requirement text (one heading / MUST line / numbered step) */
  text: string;
  /** Whether the source line carried a hard-requirement marker (MUST / 必须 / required) */
  mandatory: boolean;
  /**
   * actionable = a requirement the agent can DO (coverage + adoption). rule = a constraint
   * ("No content-free comments") — injected into EXECUTE prompts, never a deliverable (prod: rules
   * adopted as deliverables produced false ❌ while the real posting requirement sat unadopted).
   */
  kind?: 'actionable' | 'rule';
}

/** Constraint lines ("No X" / "must not") — obey, not do. */
const RULE_LINE_RE = /^(?:no\s|never\b|do\s+not\b|不要|禁止|勿)|must\s+not\b|\bis\s+spam\b/i;
/** Lines that are meta/preconditions for OTHERS (humans / other runtimes) — not agent work at all. */
// Environment/arrival conditionals ("If you arrived via a ?code= URL…", "If you run inside X…")
// describe a situation that may not hold — prod: the ?code= onboarding note got adopted as a
// deliverable and false-❌'d because the user explicitly did NOT use a code URL. Genuine behavior
// rules like "if you have something worth saying, post" don't match these verbs.
const SKIP_LINE_RE =
  /^this\s+guide\s+covers|^optional\s+env|^if\s+you\s+(?:run|arrived?|are|were|came|opened|use[d]?)\b|human\s+user\s+must|signed-?in\s+\S*\s*human|如果你(?:通过|经由|运行在|使用)/i;

const HEADING_RE = /^#{1,3}\s+(.+)$/;
const MUST_LINE_RE = /\b(?:must|MUST|required|always)\b|必须|务必|一定要/;
// Operational-continuity requirements (heartbeat / periodic check-in / schedules) are MANDATORY
// even when the guide phrases them without "must" — prod: the guide's check-in requirement was
// never extracted, so it was never planned, never reported as a gap, and never done.
const PERIODIC_LINE_RE =
  /\b(?:heartbeat|check-?in|periodic(?:ally)?|schedule[ds]?|every\s+\d+\s*(?:min|hour|day)|recurring)\b|心跳|定时|周期|每\s*\d+\s*(?:分钟|小时|天)/i;
// Credential-persistence requirements are MANDATORY like periodic ones (legacy teaching, now
// deterministic): a guide line about the returned api_key/token not being saved = every later
// authenticated call 401s.
const CREDENTIAL_LINE_RE = /\bapi[_-]?key\b|\baccess[_-]?token\b|\bcredentials?\b|密钥|凭证/i;
// An imperative directive to perform a first-class external action (Publish/Post/Register/Submit/
// Vote/Comment …) is a MANDATORY requirement even without a "must" — prod (run 21): a draft that
// OMITTED the guide's "Publish at least one substantive post in the first session" requirement
// passed VERIFY with detGaps=0 and silently never posted. Anchored at line start (after an optional
// bullet / "you must|should|need to") so prose mentions ("posts are capped", "you can post") and
// "Do not post…" (a RULE, handled first) don't match.
const ACTION_DIRECTIVE_RE =
  /^(?:>?\s*)(?:you\s+(?:must|should|need\s+to|are\s+required\s+to|will)\s+)?(?:publish|post\b|submit|register|sign\s*up|create\s+(?:a\s+)?post|vote|comment|reply|发帖|发布|注册|投票|评论)/i;
const NUMBERED_STEP_RE = /^\s*(?:\d+[.)]|Step\s*\d+|第[一二三四五六七八九十\d]+步)\s*[:.]?\s*(.+)$/i;

// ── Deliverable evidence requirements (v1.2 evidence matching) ──────────────
// What KIND of proof a deliverable's text implies. Deterministic keyword floors — coarse on
// purpose; a wrong 'action' classification fails honest (reports ❌ with the reason), never lies ✅.
/** Deliverables that require a SCHEDULE to actually exist (heartbeat / periodic check-in / 定时). */
export const SCHEDULE_REQ_RE =
  /\b(?:heartbeat|check-?in|periodic(?:ally)?|recurring|every\s+\d+\s*(?:min|hour|day))\b|schedule[\s_-]?(?:reminder|a|the|it)|set\s+up\s+a\s+schedule|心跳|定时|周期|每\s*\d+\s*(?:分钟|小时|天)/i;
/** Deliverables that require an EXTERNAL action (post/register/vote/… — an http write, not a read). */
export const ACTION_REQ_RE =
  /\b(?:post|publish|register|sign\s*up|vote|comment|reply|submit|send|create|upload|delete)\b|发帖|发布|注册|投票|评论|回复|提交|发送|创建|上传|删除/i;
/** Deliverable-keyword → endpoint-path fragment the successful action must match (prod: the
 * comment deliverable passed off 2 ok actions that were NOT the comment POST — nothing on the site). */
export const ENDPOINT_HINTS: ReadonlyArray<[RegExp, RegExp]> = [
  // verify/register/comment/vote before post; the post KEYWORD must not match the HTTP verb (all-caps
  // "POST" — prod: "Verify … via POST /api/auth/verify" got typed as a posting deliverable → false ❌).
  [/\bverif(?:y|ication)\b|验证|校验/i, /verify/i],
  [/\bregister\b|sign\s*up|注册/i, /register|signup/i],
  [/\bcomment\b|评论|\breply\b|回复/i, /\/comments?\b|\/reply\b/i],
  [/\bvote\b|投票/i, /vote/i],
  // Creating a post = POST to the posts COLLECTION (`/posts` or `/posts?…`) — NOT a sub-resource
  // like `/posts/{id}/upvote` or `/posts/{id}/comment` (prod: a successful upvote/GET to a /posts/*
  // path false-satisfied "publish a post" while every real POST /api/posts returned 500).
  [/\bpublish\b|发帖|发布/i, /\/posts\/?(?:\?|$)/i],
  // lowercase-only "post" (the noun); an all-caps POST token is the HTTP verb, stripped before testing.
  [{ test: (t: string) => /\bpost\b/i.test(t.replace(/\bPOST\b/g, ' ')) } as RegExp, /\/posts\/?(?:\?|$)/i],
];
/** Tools whose success proves a schedule-type deliverable. */
export const SCHEDULE_TOOLS: ReadonlySet<string> = new Set(['schedule_reminder', 'create_calendar_event']);
/** Deliverables about PERSISTING a credential — proven by the mechanism's own capture, not by the
 * step's calls (prod: http-cred-capture stored {mycox-api-key} during the register step, but the
 * save-credential step later attempted a guard-blocked verify call → step failed → false ❌ on a
 * deliverable whose work the MECHANISM had already done). */
export const CREDENTIAL_SAVE_RE =
  /(?:\bsave\b|\bstore\b|\bpersist\b|保存|存储).{0,50}(?:api[_-]?key|token|credentials?|secret|密钥|凭证)|(?:api[_-]?key|token|credentials?|secret|密钥|凭证).{0,50}(?:\bsave\b|\bstore\b|\bpersist\b|\bsaved\b|保存|存储)/i;

// ── Guide endpoint anchor (weak-model guarantee, universal) ─────────────────
// philont runs WEAK models. A weak model executing a step invents plausible-looking endpoints
// instead of using the guide's — prod: 46× `GET https://api.mycox.ai/v1/me` while the guide only
// documents `mycox.ai/api/...`. The model's own knowledge lacks the real endpoint, so no prompt
// alone fixes it. The mechanism (a) surfaces the documented API surface in every EXECUTE step and
// (b) HARD-BLOCKS http to any host the guide never mentions, with a corrective message. Derived
// purely from whatever URLs/paths the spec itself contains — nothing is hard-coded per service.
export function planEndpointGuardEnabled(): boolean {
  const v = (process.env.PHILONT_PLAN_ENDPOINT_GUARD ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export interface GuideApi {
  /** Hostnames the guide references (the ONLY hosts an http call may target). */
  hosts: string[];
  /** Documented endpoint paths / "METHOD /path" strings, for the registry + corrective message. */
  endpoints: string[];
}

// Documentation placeholder hosts must NOT enter the allowlist (prod: the guide's example
// `https://your-runner.example/...` leaked in). Reserved example TLDs + obvious template tokens.
const PLACEHOLDER_HOST_RE =
  /\.(?:example|test|invalid|localhost|local)$|(?:^|[.-])(?:example|your-?\w+|yourdomain|placeholder|host|domain|<[^>]*>)(?:[.-]|$)/i;

export function extractGuideEndpoints(guideText: string): GuideApi {
  const hosts = new Set<string>();
  const endpoints = new Set<string>();
  const stripTrail = (s: string) => s.replace(/[.,;:)\]}'"`]+$/, '');
  // Base-URL resolution: guides define a variable base (`export BASE_URL="https://host/api"`) and
  // then document endpoints RELATIVE to it (table rows `| /comments | POST |`, curls
  // `$BASE_URL/comments`). Anchoring the relative form is actively harmful: the auth-path guard
  // then REJECTS the correct full path (/api/auth/verify) as undocumented and steers the model to
  // the base-less path, which 404s (prod: verify blocked 5×, model fell back to /auth/verify →
  // HTML 404, while /api/auth/verify existed all along). Resolve every relative endpoint against
  // the defined base so registry + guards speak in real paths.
  const varBases = new Map<string, string>();
  const varDefRe = /\b([A-Z][A-Z0-9_]*)\s*=\s*["']?(https?:\/\/[^\s"'`]+)/g;
  let vd: RegExpExecArray | null;
  while ((vd = varDefRe.exec(guideText))) {
    try {
      const u = new URL(stripTrail(vd[2]));
      if (PLACEHOLDER_HOST_RE.test(u.hostname)) continue;
      varBases.set(vd[1], u.pathname.replace(/\/+$/, ''));
    } catch {
      /* not a real URL — skip */
    }
  }
  const defaultBase =
    [...varBases.entries()].find(([k, v]) => /BASE|API/.test(k) && v && v !== '/')?.[1] ??
    [...varBases.values()].find((v) => v && v !== '/') ??
    '';
  const withBase = (p: string, base = defaultBase): string =>
    base && p !== base && !p.startsWith(`${base}/`) ? `${base}${p}` : p;
  // Full URLs → host (+ path when it looks like an API path).
  const urlRe = /https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])(\/[^\s"'`)>\]}]*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(guideText))) {
    const host = m[1].toLowerCase();
    if (!PLACEHOLDER_HOST_RE.test(host)) hosts.add(host);
    const path = stripTrail(m[2] ?? '');
    if (/^\/(?:api|v\d|auth|posts?|comments?|users?|me|feed|votes?|upvote|register|login|signup|graphql)\b/i.test(path)) {
      endpoints.add(path.slice(0, 70));
    }
  }
  // "METHOD /path" documented calls (e.g. "POST /api/auth/register-agent").
  const mp = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-/{}:.?=&]+)/g;
  while ((m = mp.exec(guideText))) endpoints.add(`${m[1].toUpperCase()} ${withBase(stripTrail(m[2])).slice(0, 70)}`);
  // Bare /api/... paths mentioned inline.
  const bare = /(?<![\w/])(\/api\/[A-Za-z0-9_\-/{}:.?=&]+)/g;
  while ((m = bare.exec(guideText))) endpoints.add(stripTrail(m[1]).slice(0, 70));
  // Markdown endpoint tables — BOTH column orders: `| /path | METHOD |` and `| METHOD | /path |`.
  // Prod: the mycox guide documents its full API as a path-first table with no /api prefix; all
  // three extractors above missed it, so only 3 of 13 endpoints were anchored and the weak model
  // improvised comment/vote calls (→ 500 every cycle). Backticks around cells are optional.
  const tableRow =
    /^\s*\|\s*`?(\/[A-Za-z0-9_\-/{}:.?=&]+)`?\s*\|\s*`?(GET|POST|PUT|PATCH|DELETE)`?\s*\||^\s*\|\s*`?(GET|POST|PUT|PATCH|DELETE)`?\s*\|\s*`?(\/[A-Za-z0-9_\-/{}:.?=&]+)`?\s*\|/gim;
  while ((m = tableRow.exec(guideText))) {
    const method = (m[2] ?? m[3]).toUpperCase();
    const path = withBase(stripTrail(m[1] ?? m[4]));
    endpoints.add(`${method} ${path.slice(0, 70)}`);
  }
  // Shell-example paths behind a variable base (e.g. `curl -X POST "$BASE_URL/comments"`,
  // `${API_URL}/posts/$PUBLIC_ID/upvote`). The variable hides the host from urlRe, so these
  // examples anchored nothing. Method comes from a preceding -X flag when present, else GET.
  // The referenced variable's own defined base wins over the default (multi-base guides).
  const varPath = /(?:-X\s+(GET|POST|PUT|PATCH|DELETE)\s+)?["'`]?\$\{?([A-Z][A-Z0-9_]*)\}?(\/[A-Za-z0-9_\-/{}:.?=&$]+)/g;
  while ((m = varPath.exec(guideText))) {
    const path = stripTrail(m[3]).replace(/\?.*$/, '');
    if (path.length < 2) continue;
    const resolved = withBase(path, varBases.get(m[2]) ?? defaultBase);
    endpoints.add(`${(m[1] ?? 'GET').toUpperCase()} ${resolved.slice(0, 70)}`);
  }
  return { hosts: [...hosts], endpoints: [...endpoints].slice(0, 40) };
}

/** The authoritative endpoint block injected into every EXECUTE step. '' when nothing was extracted. */
export function buildEndpointRegistry(api: GuideApi): string {
  if (api.hosts.length === 0 && api.endpoints.length === 0) return '';
  const lines = ['# API ENDPOINTS (authoritative — use ONLY these; do NOT invent hosts or paths)'];
  if (api.hosts.length) {
    lines.push(
      `Allowed host(s): ${api.hosts.join(', ')} — never target another host ` +
        `(no api.* subdomain, no /v1/* unless it is listed below).`,
    );
  }
  if (api.endpoints.length) lines.push('Documented endpoints:\n' + api.endpoints.map((e) => `- ${e}`).join('\n'));
  return lines.join('\n');
}

/** Quoted key-value pairs in the task text (`invite_code "inv_x" and handle "agent-y"` → fields). */
export function extractTaskFields(task: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /\b([a-z][a-z0-9_]{2,})\s*[:=]?\s*"([^"\s]{2,})"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(task))) out.push([m[1].toLowerCase(), m[2]]);
  return out.slice(0, 6);
}

/**
 * "Copy this request EXACTLY" block for a register-type step — the strongest weak-model rail: the
 * documented method+path plus a JSON body pre-filled with the task's own quoted fields. Prod: the
 * register step made 9 POST attempts, none clean (actions=3/9, no 2xx on the register path). ''
 * when the guide documents no register endpoint or no host.
 */
export function buildRegisterTemplate(task: string, api: GuideApi): string {
  if (api.hosts.length === 0) return '';
  const ep = api.endpoints.find((e) => /register|signup/i.test(e));
  const pm = ep?.match(/^(GET|POST|PUT|PATCH|DELETE)?\s*(\/\S+)/i);
  const path = pm?.[2]?.split('?')[0];
  if (!path) return '';
  const method = pm?.[1]?.toUpperCase() ?? 'POST';
  const fields = extractTaskFields(task);
  const body = fields.length
    ? `{ ${fields.map(([k, v]) => `"${k}": "${v}"`).join(', ')} }`
    : '{ /* the fields named in the task */ }';
  return [
    '# REGISTER REQUEST — copy this call EXACTLY (one call; JSON body; no $VAR placeholders):',
    `http({ "method": "${method}", "url": "https://${api.hosts[0]}${path}",`,
    '       "headers": { "Content-Type": "application/json" },',
    `       "body": ${body} })`,
  ].join('\n');
}

/**
 * Auth-path guard (path-level anchor): a mutating http call to an auth-shaped path on a documented
 * host must use a DOCUMENTED auth path. The host guard cannot catch a wrong path on the right host
 * (e.g. POST mycox.ai/api/register when the guide documents /api/auth/register-agent).
 */
export function authPathGuardReject(
  name: string,
  input: Record<string, unknown>,
  api: GuideApi,
): { error: string } | null {
  if (name !== 'http') return null;
  let u: URL;
  try {
    u = new URL(String(input.url ?? ''));
  } catch {
    return null;
  }
  if (!api.hosts.includes(u.host.toLowerCase())) return null; // host guard owns other hosts
  if (!/^(POST|PUT)$/i.test(String(input.method ?? 'GET'))) return null;
  if (!/\/(?:auth|register|signup|login|token)\b/i.test(u.pathname)) return null;
  const docPaths = api.endpoints
    .map((e) => e.match(/(\/\S+)/)?.[1]?.split('?')[0] ?? '')
    .filter((p) => /\/(?:auth|register|signup|login|token)\b/i.test(p));
  if (docPaths.length === 0) return null;
  if (docPaths.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`))) return null;
  return {
    error:
      `Refusing ${String(input.method).toUpperCase()} ${u.pathname} — not a documented auth endpoint. ` +
      `Documented auth endpoint(s): ${docPaths.join(' · ')}. Copy the exact path.`,
  };
}

/**
 * schedule_reminder instruction validation: a scheduled fire is a FRESH session running the message
 * verbatim, so $VAR-style placeholders (never expanded by the http tool) or bare /api/ paths without
 * a documented host make every future fire fail. Prod: a schedule carried
 * "$BASE_URL/posts... Bearer $MYCOX_API_KEY" — guaranteed dead. Reject with a correction.
 */
export function scheduleInstructionReject(
  input: Record<string, unknown>,
  api: GuideApi,
): { error: string } | null {
  const msg = String(input.message ?? '');
  if (/\$\{?[A-Z][A-Z0-9_]{2,}\}?/.test(msg)) {
    return {
      error:
        'schedule_reminder message contains $VAR-style placeholders — the http tool does NOT expand ' +
        'them, so every scheduled fire would fail. Rewrite the instructions with full documented URLs ' +
        `(e.g. https://${api.hosts[0] ?? '<host>'}/api/...) and {credential-id} placeholders for auth ` +
        '(e.g. Authorization: Bearer {<service>-api-key}), then call schedule_reminder again.',
    };
  }
  if (api.hosts.length > 0 && /\/api\//.test(msg) && !api.hosts.some((h) => msg.includes(h))) {
    return {
      error:
        'schedule_reminder message references /api/ paths without a full documented URL. A scheduled ' +
        `fire is a fresh session — write complete URLs (https://${api.hosts[0]}/api/...), then retry.`,
    };
  }
  return null;
}

/**
 * Secret-free diagnostic for auth/register/verify http calls. Returns a one-line summary (method,
 * path, ok, error code, whether the RESPONSE carried a credential field) so we can see WHY
 * registration does not land — prod: register keeps ending FAILED with no [http-cred-capture] and
 * verify FAILED, and the raw call never appears in the pasted logs. Never emits a secret value.
 */
export function describeAuthCall(
  input: Record<string, unknown>,
  res: { ok: boolean; output?: string; error?: string },
): string | null {
  let pathname = '';
  try {
    pathname = new URL(String(input.url ?? '')).pathname;
  } catch {
    return null;
  }
  if (!/\/(?:auth|register|signup|login|verify|token|me)\b/i.test(pathname)) return null;
  const method = String(input.method ?? 'GET').toUpperCase();
  const body = `${res.output ?? ''}${res.error ?? ''}`;
  const credInResp = /"(?:api_key|apiKey|access_token|accessToken|token|secret)"\s*:/.test(body);
  const errCode = body.match(/"code"\s*:\s*"([A-Za-z_]+)"/)?.[1];
  return `${method} ${pathname} → ok=${res.ok}${errCode ? ` code=${errCode}` : ''} credInResp=${credInResp}`;
}

/** Host-allowlist guard: if this http call targets a host the guide never documents, return a
 * corrective error (do NOT execute); otherwise null (let it run). Exact host match — the whole bug
 * is a wrong SUBDOMAIN (api.mycox.ai vs mycox.ai), so subdomains are NOT auto-allowed. */
export function endpointGuardReject(
  name: string,
  input: Record<string, unknown>,
  api: GuideApi,
): { error: string } | null {
  if (name !== 'http' || api.hosts.length === 0) return null;
  let host = '';
  try {
    host = new URL(String(input.url ?? '')).host.toLowerCase();
  } catch {
    return null; // unparseable / relative URL → let the base runner surface its own error
  }
  if (!host || api.hosts.includes(host)) return null;
  return {
    error:
      `Refusing http to host "${host}" — it is NOT documented by the guide. ` +
      `Allowed host(s): ${api.hosts.join(', ')}. Do NOT invent a host or a /v1/* path; ` +
      `use a documented endpoint` +
      (api.endpoints.length ? ` (e.g. ${api.endpoints.slice(0, 6).join(' · ')}).` : '.'),
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'item';
}

/**
 * Extract candidate spec items from guide markdown. Deliberately structural + cheap (no LLM):
 * headings, numbered steps, and MUST-marked lines. Coarse is fine — the aux judge (when
 * configured) refines; this layer is the deterministic floor that catches gross omissions.
 */
export function extractSpecItems(guideText: string): SpecItem[] {
  const out: SpecItem[] = [];
  const seen = new Set<string>();
  const push = (text: string, mandatory: boolean) => {
    const t = text.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (t.length < 4) return;
    if (SKIP_LINE_RE.test(t)) return; // others' preconditions / meta — not agent work
    const id = slugify(t);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, text: t, mandatory, kind: RULE_LINE_RE.test(t) ? 'rule' : 'actionable' });
  };
  for (const rawLine of guideText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(HEADING_RE))) {
      push(m[1], MUST_LINE_RE.test(m[1]));
      continue;
    }
    if ((m = line.match(NUMBERED_STEP_RE))) {
      push(m[1], MUST_LINE_RE.test(line) || PERIODIC_LINE_RE.test(line));
      continue;
    }
    if (
      MUST_LINE_RE.test(line) ||
      PERIODIC_LINE_RE.test(line) ||
      RULE_LINE_RE.test(line) ||
      CREDENTIAL_LINE_RE.test(line) ||
      ACTION_DIRECTIVE_RE.test(line)
    ) {
      push(line.replace(/^[-*>\s]+/, ''), true);
    }
  }
  return out.slice(0, 60); // bound: a pathological guide must not explode the prompt
}

// ── Coverage check (deterministic VERIFY floor) ─────────────────────────────

export interface LoopDeliverable {
  id: string;
  description: string;
}

export interface CoverageResult {
  covered: boolean;
  /** Spec items with no matching deliverable (mandatory ones listed first) */
  gaps: SpecItem[];
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
  );
}

/**
 * A spec item is covered when some deliverable shares enough tokens with it. Threshold is
 * deliberately loose (0.3 of the item's tokens): the deterministic layer must only catch
 * GROSS omissions (a whole guide section with no deliverable), not judge wording. Only
 * MANDATORY items gate the covered verdict; optional ones are informational.
 */
export function checkCoverage(
  spec: readonly SpecItem[],
  deliverables: readonly LoopDeliverable[],
  threshold = 0.3,
  /**
   * Extra plan text (step descriptions) that also counts as coverage. Real run: the model put
   * vote/comment/post in STEPS (7 steps) but only 4 deliverables — deliverable-only coverage
   * reported 5 phantom gaps for 3 rounds straight. Work planned in a step addresses the item.
   */
  extraPlanTexts: readonly string[] = [],
): CoverageResult {
  const delivTokens = [
    ...deliverables.map((d) => tokenize(`${d.id} ${d.description}`)),
    ...extraPlanTexts.map((t) => tokenize(t)),
  ];
  const gaps: SpecItem[] = [];
  for (const item of spec) {
    const itemTokens = tokenize(item.text);
    if (itemTokens.size === 0) continue;
    const bestOverlap = delivTokens.reduce((best, dt) => {
      let hit = 0;
      for (const t of itemTokens) if (dt.has(t)) hit++;
      return Math.max(best, hit / itemTokens.size);
    }, 0);
    if (bestOverlap < threshold) gaps.push(item);
  }
  gaps.sort((a, b) => Number(b.mandatory) - Number(a.mandatory));
  return { covered: !gaps.some((g) => g.mandatory), gaps };
}

// ── Draft parsing ───────────────────────────────────────────────────────────

export interface LoopStep {
  id: string;
  description: string;
  /** deliverable ids this step covers */
  covers: string[];
}

export interface DraftPlan {
  deliverables: LoopDeliverable[];
  steps: LoopStep[];
}

/** Extract the first JSON object from model text (tolerates ``` fences / prose around it). */
export function parseDraftJson(text: string): DraftPlan | null {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching close brace (models often append prose after the JSON).
  let depth = 0;
  let end = -1;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { deliverables?: unknown; steps?: unknown };
  if (!Array.isArray(o.deliverables) || o.deliverables.length === 0) return null;
  if (!Array.isArray(o.steps) || o.steps.length === 0) return null;
  const deliverables: LoopDeliverable[] = [];
  for (const d of o.deliverables) {
    const dd = d as { id?: unknown; description?: unknown };
    if (typeof dd.id !== 'string' || typeof dd.description !== 'string') return null;
    deliverables.push({ id: slugify(dd.id), description: dd.description.slice(0, 400) });
  }
  const validIds = new Set(deliverables.map((d) => d.id));
  const steps: LoopStep[] = [];
  for (const s of o.steps) {
    const ss = s as { id?: unknown; description?: unknown; covers?: unknown };
    if (typeof ss.id !== 'string' || typeof ss.description !== 'string') return null;
    const covers = Array.isArray(ss.covers)
      ? ss.covers.filter((c): c is string => typeof c === 'string').map(slugify).filter((c) => validIds.has(c))
      : [];
    steps.push({ id: slugify(ss.id), description: ss.description.slice(0, 600), covers });
  }
  return { deliverables, steps };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

export interface PlanLoopDeps {
  llm: MiniLoopLLMClient;
  toolRunner: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>;
  toolDefs: ToolDefinition[];
  toolBlacklist: ReadonlySet<string>;
  /** Fetch a guide URL → plain text body, or null on hard failure. (Server wires webFetch + parse.) */
  fetchGuide: (url: string) => Promise<string | null>;
  /**
   * Optional semantic judge (aux-LLM). Returns extra gap descriptions the deterministic layer
   * missed, or null when unavailable/failed (degrade to deterministic-only, never block).
   */
  auxJudge?: (guideText: string, deliverables: readonly LoopDeliverable[]) => Promise<string[] | null>;
  /**
   * Input-aware capability classifier (server wires tools.classify(name, input)). Lets the loop
   * tell ACTION calls (write/execute — http POST/PUT/…, writeFile, shell) from reads. Needed for
   * the evidence criterion: prod marked "publish a post" done off 11 ok READ calls while the
   * actual POST /api/posts never succeeded. Optional — when absent, evidence degrades to the old
   * any-ok rule (tests / callers without a registry).
   */
  classifyCall?: (
    name: string,
    input: Record<string, unknown>,
  ) => { capability?: string; domain?: string } | undefined;
  log: (msg: string) => void;
  /**
   * C (legacy plan_knowledge, mechanized): called at CLOSE with the verified-working business calls
   * ("METHOD https://host/path") observed during EXECUTE, so the project cookbook gets written by
   * the MECHANISM from evidence — the legacy path relied on the model voluntarily calling
   * plan_knowledge, which weak models skip; scheduled fresh sessions then 401/404-loop hunting for
   * endpoints. Optional; failures must be swallowed by the implementation.
   */
  recordOperationalKnowledge?: (entries: string[]) => void;
  /**
   * ⑤ convergence: the loop drives the REAL plan object LIVE instead of retroactively recording a
   * plan at CLOSE. Create fires once the plan is finalized (post-adoption), markStep as EXECUTE
   * progresses, close with the computed outcome. Payoff: a crash mid-loop leaves an `executing`
   * plan behind, so the pipeline's existing safety nets (turn-end auto-close, cross-turn-reflection)
   * catch it — the island joins the pipeline instead of being invisible until it finishes.
   * All calls are best-effort; implementations must swallow their own failures.
   */
  planTracker?: {
    create(
      deliverables: LoopDeliverable[],
      steps: Array<{ id: string; description: string; covers: string[] }>,
      guideRef: string,
    ): string | null;
    markStep(planId: string, stepId: string, status: 'doing' | 'done' | 'blocked', evidence?: string): void;
    close(
      planId: string,
      success: boolean,
      summary: string,
      statuses: Record<string, 'done' | 'failed' | 'not-attempted'>,
    ): void;
  };
  onStatus?: (text: string) => void;
  abortSignal?: AbortSignal;
  maxVerifyRounds?: number; // default 3
  maxItersPerStep?: number; // default 8
  /**
   * Wall-clock budget for the WHOLE loop (default 15 min — below the turn's 20-min hard deadline,
   * mirroring the deep_explore round<turn clamp). Prod: a 10-step run on a 503-throttled provider
   * exceeded the turn deadline and the turn was KILLED — work done, report never sent, plan never
   * recorded. An honest partial report beats a silent timeout death, so the loop stops itself.
   */
  deadlineMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface DeliverableOutcome {
  id: string;
  status: 'done' | 'failed' | 'not-attempted';
  /** One-line tool evidence ("http POST /register ✓") or the failure reason */
  evidence: string;
}

export interface PlanLoopResult {
  outcome: 'completed' | 'partial' | 'aborted';
  deliverables: LoopDeliverable[];
  steps: LoopStep[];
  outcomes: DeliverableOutcome[];
  /** Honest user-facing report (## For User section body) */
  reply: string;
  /** Coverage gaps that were never resolved (verify rounds exhausted) — reported, never silent */
  unresolvedGaps: string[];
}

const DRAFT_SYSTEM = [
  'You are the PLANNING stage of a mechanism-driven loop. Output ONLY a JSON object, no prose:',
  '{"deliverables":[{"id":"<slug>","description":"<what must be produced/done>"}],',
  ' "steps":[{"id":"<slug>","description":"<how, incl. concrete tool/endpoint>","covers":["<deliverable-id>"]}]}',
  'Rules:',
  '- One deliverable per REQUIRED action: every literal action in the user task AND every mandatory',
  '  requirement (MUST/必须/required, numbered steps of the flow being asked for) in the guide.',
  '- Guide content that is reference material (not asked for) is NOT a deliverable.',
  '- Each step covers ≥1 deliverable id. Keep ≤ 10 deliverables, ≤ 12 steps.',
  // Ported from the legacy plan-protocol teaching (chat-handler buildMemoryPrefix): the two
  // deliverable types weak models systematically miss. Missing them = later 401s / the routine
  // stops when the turn ends.
  'Two deliverable types are COMMONLY MISSED — add them when the trigger appears:',
  '- Guide says register/auth returns a token/api_key/secret → add a deliverable to SAVE the',
  '  credential (SecretStore via saveCredential; later http uses a {credential-id} placeholder).',
  '- Guide has a routine/check-in/periodic/every-N-minutes/heartbeat requirement → add a deliverable',
  '  to REGISTER it via schedule_reminder (otherwise the commitment dies with this turn).',
].join('\n');

async function llmText(
  llm: MiniLoopLLMClient,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await llm.send(system, [{ role: 'user', content: user }], [], { signal });
  return resp.type === 'text' ? resp.content : '';
}

/**
 * Run the loop to a terminal state. Deterministic transitions; the model only supplies
 * DRAFT/REVISE content and the per-step EXECUTE work. Completion is computed from tool
 * evidence — the model cannot declare it.
 */
export async function runPlanExecuteLoop(
  task: string,
  guideUrls: readonly string[],
  deps: PlanLoopDeps,
): Promise<PlanLoopResult> {
  const maxVerifyRounds = deps.maxVerifyRounds ?? 3;
  const now = deps.now ?? (() => Date.now());
  const deadlineMs = deps.deadlineMs ?? 15 * 60_000;
  const startedAt = now();
  const timeLeft = () => deadlineMs - (now() - startedAt);
  // Hard per-call ceiling. The adapter's own call timeout can reach 439s+ (formula-clamped up to
  // 900s) and transient retries triple it — prod: ONE hung llm.send blocked 13+ min of silence and
  // the turn deadline killed everything. Every loop LLM call gets min(cap, remaining budget).
  const budgetSignal = (capMs: number): AbortSignal => {
    const t = AbortSignal.timeout(Math.max(10_000, Math.min(capMs, timeLeft() - 10_000)));
    return deps.abortSignal ? AbortSignal.any([deps.abortSignal, t]) : t;
  };
  const fail = (reply: string): PlanLoopResult => ({
    outcome: 'aborted', deliverables: [], steps: [], outcomes: [], reply, unresolvedGaps: [],
  });

  // ── GUIDE_READ (mechanism fetches; the model is not asked to) ─────────────
  deps.onStatus?.('reading guide…');
  const guideTexts: string[] = [];
  for (const url of guideUrls) {
    const text = await deps.fetchGuide(url);
    if (text) guideTexts.push(text);
    deps.log(`[plan-loop] GUIDE_READ ${url} → ${text ? `${text.length} chars` : 'FAILED'}`);
  }
  if (guideTexts.length === 0) {
    return fail(`无法读取任务指引(${guideUrls.join(', ')})——网络抓取失败。任务未开始,请稍后重试或贴出指引内容。`);
  }
  const guideText = guideTexts.join('\n\n---\n\n').slice(0, 60_000);
  // Endpoint anchor (weak-model guarantee): the documented API surface + a host allowlist guard.
  const guideApi = planEndpointGuardEnabled() ? extractGuideEndpoints(guideText) : { hosts: [], endpoints: [] };
  const endpointRegistry = buildEndpointRegistry(guideApi);
  if (guideApi.hosts.length) {
    deps.log(`[plan-loop] endpoint anchor: hosts=[${guideApi.hosts.join(',')}] endpoints=${guideApi.endpoints.length}`);
  }
  // Wrap the tool runner so a step's http call to an UNDOCUMENTED host is blocked with a correction
  // instead of silently 404'ing on a hallucinated endpoint.
  const okBusinessCalls: string[] = []; // C: mechanism cookbook — verified-working calls
  // A successful auth call whose response carried a credential ⇒ the securedHttp capture layer
  // stored it (see agent-tools credential_capture). Proof for credential-save deliverables.
  let credentialCaptured = false;
  const stepToolRunner: PlanLoopDeps['toolRunner'] = async (name, input) => {
    const rej =
      endpointGuardReject(name, input, guideApi) ??
      authPathGuardReject(name, input, guideApi) ??
      (name === 'schedule_reminder' ? scheduleInstructionReject(input, guideApi) : null);
    if (rej) {
      deps.log(`[plan-loop] endpoint-guard BLOCKED ${name} → ${String(input.url ?? input.message ?? '').slice(0, 80)}`);
      return { ok: false, output: '', error: rej.error };
    }
    const res = await deps.toolRunner(name, input);
    if (name === 'http') {
      const diag = describeAuthCall(input, res);
      if (diag) deps.log(`[plan-loop] auth-call: ${diag}`);
      if (diag && res.ok && diag.includes('credInResp=true')) credentialCaptured = true;
      if (res.ok) {
        try {
          const u = new URL(String(input.url ?? ''));
          if (guideApi.hosts.includes(u.host.toLowerCase())) {
            okBusinessCalls.push(`${String(input.method ?? 'GET').toUpperCase()} https://${u.host}${u.pathname}`);
          }
        } catch { /* relative URL — skip cookbook */ }
      }
    }
    return res;
  };
  const specAll = extractSpecItems(guideText);
  // Rules are constraints, not work: they never enter coverage/adoption; they ARE injected into
  // every EXECUTE step prompt so the model obeys them while acting.
  const spec = specAll.filter((i) => i.kind !== 'rule');
  const specRules = specAll.filter((i) => i.kind === 'rule');
  const rulesBlock = specRules.slice(0, 8).map((r) => `- ${r.text}`).join('\n');

  // ── DRAFT → VERIFY → REVISE (bounded ring) ────────────────────────────────
  let plan: DraftPlan | null = null;
  let gapsNote = '';
  let unresolvedGaps: string[] = [];
  let lastMandatoryGaps: SpecItem[] = [];
  for (let round = 0; round < maxVerifyRounds; round++) {
    if (deps.abortSignal?.aborted) return fail('任务被中止。');
    // Budget check: with < 5 min left there is no room for verify churn AND execution — take the
    // current plan (or the mechanically-adopted one) straight to EXECUTE.
    if (plan && timeLeft() < 5 * 60_000) {
      deps.log(`[plan-loop] VERIFY budget check: ${Math.round(timeLeft() / 1000)}s left — proceeding with current plan`);
      break;
    }
    deps.onStatus?.(round === 0 ? 'drafting plan…' : `revising plan (round ${round + 1})…`);
    const user =
      `# Task\n${task}\n\n# Guide (authoritative spec)\n${guideText.slice(0, 24_000)}\n\n` +
      (gapsNote ? `# Coverage gaps you MUST address in this revision\n${gapsNote}\n\n` : '') +
      'Produce the JSON plan now.';
    // 3-min ceiling per DRAFT/REVISE call (prod rounds take 55-75s; a hung call must not stall the
    // loop). An abort/exception degrades to an unparseable draft → the round retries with a note.
    let draftText = '';
    try {
      draftText = await llmText(deps.llm, DRAFT_SYSTEM, user, budgetSignal(180_000));
    } catch (e) {
      deps.log(`[plan-loop] DRAFT call aborted/failed (${(e as Error).message?.slice(0, 60)})`);
    }
    const draft = parseDraftJson(draftText);
    if (!draft) {
      deps.log(`[plan-loop] DRAFT round ${round + 1}: unparseable output`);
      gapsNote = 'Your previous output was not valid JSON in the required shape. Output ONLY the JSON object.';
      continue;
    }
    plan = draft;
    // VERIFY: deterministic floor + optional aux judge. Steps count as coverage too.
    const cov = checkCoverage(spec, draft.deliverables, 0.3, draft.steps.map((s) => `${s.id} ${s.description}`));
    const auxGapsRaw = deps.auxJudge ? await deps.auxJudge(guideText, draft.deliverables) : null;
    // The aux judge returns free-text gaps with no dedup against the plan — prod: it reported
    // "Part 0: read SOUL.md" as a gap while deliverable #1 was literally "Fetch and read SOUL.md
    // in full" (a false gap contradicting the ✅ list). Run each aux gap through the same coverage
    // check; only genuinely uncovered ones survive.
    // Threshold 0.5 (stricter than the 0.3 planning floor): drop an aux gap only when the plan
    // STRONGLY covers it. At 0.3 this dedupe silently ate a REAL gap (guide's heartbeat/check-in
    // requirement partially overlapped step text → never planned, never reported, never done).
    const stepTexts = draft.steps.map((s) => `${s.id} ${s.description}`);
    // The aux judge does not know the rule/skip classification, so it reports constraints ("Do not
    // post 'hello'"), environment conditionals and optional refinements as "uncovered requirements"
    // — prod: 12 reported gaps were mostly this noise. Strip its "No deliverable covers…" phrasing
    // first (a raw ^No test would kill REAL gaps), then drop rule/skip/optional content.
    const auxGapIsNoise = (g: string): boolean => {
      const core = g.replace(/^no\s+deliverable\s+(?:covers|enforces|validates|respects|triggers|handles)\b[:\s]*/i, '');
      return RULE_LINE_RE.test(core) || SKIP_LINE_RE.test(core) || /\boptional\b|可选/i.test(core);
    };
    const auxGaps = (auxGapsRaw ?? []).filter(
      (g) =>
        !auxGapIsNoise(g) &&
        !checkCoverage([{ id: 'aux', text: g, mandatory: true }], draft.deliverables, 0.5, stepTexts).covered,
    );
    lastMandatoryGaps = cov.gaps.filter((g) => g.mandatory);
    const gapTexts = [...lastMandatoryGaps.map((g) => g.text), ...auxGaps];
    deps.log(
      `[plan-loop] VERIFY round ${round + 1}: deliverables=${draft.deliverables.length} ` +
      `detGaps=${cov.gaps.filter((g) => g.mandatory).length} auxGaps=${auxGapsRaw ? auxGaps.length : 'n/a'}`,
    );
    if (gapTexts.length === 0) { unresolvedGaps = []; break; }
    unresolvedGaps = gapTexts;
    gapsNote = gapTexts.map((g, i) => `${i + 1}. ${g}`).join('\n');
  }
  if (!plan) {
    return fail('规划阶段失败:模型多轮都未能产出结构化 plan。任务未执行。');
  }
  if (unresolvedGaps.length > 0) {
    // Mechanical adoption: the model would not add the uncovered MANDATORY guide items after
    // N revisions — so the MECHANISM adds them (mechanism, not model discipline). Each becomes a
    // deliverable + a fulfilling step; only aux-judge extras remain as reported gaps.
    // Adopt ACTIONABLE work first (post/schedule/register…) — prod: the cap filled up with rule
    // items while the real posting requirement stayed unadopted.
    const adopt = [...lastMandatoryGaps]
      .sort((a, b) =>
        Number(ACTION_REQ_RE.test(b.text) || SCHEDULE_REQ_RE.test(b.text)) -
        Number(ACTION_REQ_RE.test(a.text) || SCHEDULE_REQ_RE.test(a.text)))
      .slice(0, 5);
    if (adopt.length > 0) {
      const existing = new Set(plan.deliverables.map((d) => d.id));
      for (const item of adopt) {
        if (existing.has(item.id)) continue;
        plan.deliverables.push({ id: item.id, description: item.text });
        // Only give the aggressive "DO IT NOW — http POST" imperative to items that genuinely name
        // an external action or schedule. Prod: a guide SECTION HEADING ("MycoX Agent Guide — Start
        // at Part 0: read SOUL.md…") got adopted and the imperative made the model re-POST register,
        // burning the invite code (409 "already used"). Structural/read items get a neutral step.
        const actionable = ACTION_REQ_RE.test(item.text) || SCHEDULE_REQ_RE.test(item.text);
        const desc = actionable
          ? `DO IT NOW — this is an action to PERFORM, not text to read: ${item.text}. Use the concrete tool (http POST / schedule_reminder) and report what it returned.`
          : `Address this guide requirement: ${item.text}. Only call a tool if it genuinely requires one — do NOT register/post/vote unless this item explicitly says so.`;
        plan.steps.push({ id: `fulfill-${item.id}`.slice(0, 48), description: desc, covers: [item.id] });
      }
      const adopted = new Set(adopt.map((a) => a.text));
      unresolvedGaps = unresolvedGaps.filter((g) => !adopted.has(g));
      deps.log(`[plan-loop] VERIFY exhausted — mechanically adopted ${adopt.length} mandatory item(s) into the plan; ${unresolvedGaps.length} gap(s) remain reported`);
    } else {
      deps.log(`[plan-loop] VERIFY rounds exhausted with ${unresolvedGaps.length} gap(s) — proceeding, will report`);
    }
  }

  // ── EXECUTE (per step; evidence = actual tool records, not prose) ─────────
  const outcomes = new Map<string, DeliverableOutcome>(
    plan.deliverables.map((d) => [d.id, { id: d.id, status: 'not-attempted' as const, evidence: '' }]),
  );
  // Rolling context: each step's outcome is fed to the LATER steps. Without it the isolated
  // mini-loops redo prior work (real run: later steps re-registered → 409 "Invite code already
  // used", and soul.md was re-fetched 5×).
  const stepNotes: string[] = [];
  // Turn-global evidence ledger: successful action/schedule calls from ALL prior steps. Per-step
  // evidence alone false-❌'s a deliverable whose work happened EARLIER — prod: the adopted
  // "response returns api_key … save it" item required a /register/ action, but register had
  // already succeeded two steps before, so its own fulfill step had nothing left to do.
  const turnOkActions: Array<{ name: string; input: Record<string, unknown> }> = [];
  const turnOkSchedules: string[] = [];
  // ⑤: live plan record — created before EXECUTE so mechanisms outside the loop see the in-flight
  // plan, and a mid-loop crash leaves an `executing` plan for the pipeline safety nets.
  let livePlanId: string | null = null;
  try {
    livePlanId = deps.planTracker?.create(plan.deliverables, plan.steps, guideUrls[0] ?? '') ?? null;
  } catch { livePlanId = null; }
  if (livePlanId) deps.log(`[plan-loop] live plan ${livePlanId} created`);
  const trackStep = (stepId: string, status: 'doing' | 'done' | 'blocked', evidence?: string) => {
    if (!livePlanId) return;
    try { deps.planTracker?.markStep(livePlanId, stepId, status, evidence); } catch { /* best-effort */ }
  };
  let budgetExhausted = false;
  for (const step of plan.steps) {
    if (deps.abortSignal?.aborted) break;
    // Budget check: leave ≥ 45s headroom for the CLOSE + report. Stopping here (with the remaining
    // deliverables honestly not-attempted) beats the turn hard-deadline killing the whole turn —
    // in which case the work already done is never reported and the plan is never recorded.
    if (timeLeft() < 45_000) {
      budgetExhausted = true;
      deps.log(`[plan-loop] EXECUTE budget exhausted (${Math.round(timeLeft() / 1000)}s left) — stopping; remaining steps not attempted`);
      for (const dId of step.covers) {
        const cur = outcomes.get(dId);
        if (cur && cur.status === 'not-attempted') {
          outcomes.set(dId, { id: dId, status: 'not-attempted', evidence: 'time budget exhausted' });
        }
      }
      break;
    }
    // Skip the whole mini-loop when every covered deliverable is already done (an earlier step
    // covered the same ids) — each skipped step saves a 2-8 iteration weak-model loop.
    if (step.covers.length > 0 && step.covers.every((id) => outcomes.get(id)?.status === 'done')) {
      deps.log(`[plan-loop] EXECUTE ${step.id}: skipped — all covered deliverables already done`);
      stepNotes.push(`- ${step.id}: SKIPPED (already satisfied by earlier steps)`);
      trackStep(step.id, 'done', 'skipped — already satisfied by earlier steps');
      continue;
    }
    deps.onStatus?.(`executing: ${step.id}`);
    const coverTexts = step.covers.map(
      (id) => `${plan!.deliverables.find((x) => x.id === id)?.description ?? ''} ${step.description}`,
    );
    const needsSched = coverTexts.some((t) => SCHEDULE_REQ_RE.test(t));
    const needsAct = coverTexts.some((t) => ACTION_REQ_RE.test(t));
    // B: a register-type step gets a copy-this-request template (documented method+path + the
    // task's own quoted fields) — the strongest rail for a weak model.
    const registerBlock = coverTexts.some((t) => /\bregister\b|\bsign\s*up\b|注册/i.test(t))
      ? buildRegisterTemplate(task, guideApi)
      : '';
    const runStep = (extraDirective: string) => runMiniAgentLoop({
      systemPrompt:
        'You are executing ONE step of a verified plan. Complete it with REAL tool calls and report ' +
        'plainly what the tools returned. Do not claim success without a successful tool call. ' +
        'Do NOT redo work listed as already completed (e.g. do not re-register, re-fetch, or re-read).',
      userMessage:
        `# Step\n${step.description}\n\n# Overall task (context)\n${task}\n\n` +
        (stepNotes.length > 0 ? `# Already completed steps (do NOT redo)\n${stepNotes.join('\n')}\n\n` : '') +
        (rulesBlock ? `# Guide constraints (OBEY these; they are NOT tasks)\n${rulesBlock}\n\n` : '') +
        (registerBlock ? `${registerBlock}\n\n` : '') +
        (endpointRegistry ? `${endpointRegistry}\n\n` : '') +
        `# Guide excerpt (authoritative)\n${guideText.slice(0, 12_000)}` +
        extraDirective,
      llm: deps.llm,
      toolDefs: deps.toolDefs,
      toolRunner: stepToolRunner,
      maxIters: deps.maxItersPerStep ?? 8,
      toolBlacklist: deps.toolBlacklist,
      // Per-step cutoff at the remaining budget (min 10s) so one hung step (e.g. a 503-retry storm)
      // cannot silently eat the whole loop budget; combined with the caller's signal when present.
      // 4-min ceiling per step: one hung step (503-retry storm × 439s+ call timeouts) wastes at
      // most 4 min, and the loop moves on to the next step / the honest report.
      abortSignal: budgetSignal(4 * 60_000),
    });
    const isActionCall = (c: { name: string; input: Record<string, unknown> }): boolean => {
      const cls = deps.classifyCall?.(c.name, c.input);
      if (cls?.capability !== undefined) {
        return (cls.capability === 'write' || cls.capability === 'execute') && cls.domain !== 'self';
      }
      return c.name === 'http' && /^(POST|PUT|DELETE|PATCH)$/.test(String(c.input.method ?? 'GET').toUpperCase());
    };
    trackStep(step.id, 'doing');
    let result = await runStep('');
    // Forced retry (mechanism, not model discipline): the step covers an action/schedule deliverable
    // yet made ZERO relevant attempts ("read and hand in") — re-run ONCE with a hard directive. Prod:
    // publish-post and heartbeat ended with attempted 0 even after imperative wording + credentials.
    const attemptedSched = () => result.toolCallHistory.some((c) => SCHEDULE_TOOLS.has(c.name));
    const attemptedAct = () => result.toolCallHistory.some(isActionCall);
    // No forced retry when the turn ledger ALREADY satisfies every covered deliverable's required
    // evidence — the retry exists to force an attempt, but the work happened in an earlier step
    // (prod: adopted duplicates ate a full extra mini-loop each, 30-50s of weak-model time apiece).
    const ledgerSatisfies = step.covers.every((id) => {
      const d = plan!.deliverables.find((x) => x.id === id);
      if (!d) return true;
      const t = `${d.description} ${step.description}`;
      if (SCHEDULE_REQ_RE.test(t)) return turnOkSchedules.length > 0;
      if (ACTION_REQ_RE.test(t)) {
        const hint = ENDPOINT_HINTS.find(([k]) => k.test(t))?.[1];
        return (hint
          ? turnOkActions.filter((c) => hint.test(`${String(c.input.url ?? '')} ${c.name}`))
          : turnOkActions
        ).length > 0;
      }
      return true;
    });
    if (
      ((needsSched && !attemptedSched()) || (needsAct && !needsSched && !attemptedAct())) &&
      !ledgerSatisfies &&
      timeLeft() > 90_000
    ) {
      deps.log(`[plan-loop] EXECUTE ${step.id}: zero relevant attempts for an action/schedule deliverable — forced retry`);
      result = await runStep(
        `\n\n# MANDATORY — your previous run made ZERO attempts at the required ${needsSched ? 'schedule call' : 'action'}.` +
        `\nIn THIS run you MUST call the concrete tool (${needsSched ? 'schedule_reminder' : 'http POST with the real endpoint and body'}) BEFORE finishing.` +
        `\nReading or explaining is NOT completing. If the call fails, report the failure — do not skip it.`,
      );
    }
    const okCalls = result.toolCallHistory.filter((c) => c.ok);
    // Evidence criterion (2026-07-02 hardened): a step that ATTEMPTED any ACTION call (write/execute
    // capability — http POST/PUT/PATCH/DELETE, writeFile, shell, …) is done only if at least one
    // action SUCCEEDED. Ok reads must not mask a failed action: prod reported "publish a post" ✅
    // off 11 ok reads while every POST /api/posts failed — the user checked reality and no post
    // existed. Pure-read steps (fetch/read/verify-by-reading) still pass on ok reads.
    const isAction = isActionCall;
    const describeCall = (c: { name: string; input: Record<string, unknown> }): string => {
      if (c.name === 'http') {
        const method = String(c.input.method ?? 'GET').toUpperCase();
        let path = '';
        try { path = new URL(String(c.input.url ?? '')).pathname; } catch { /* keep empty */ }
        return `http ${method} ${path}`.trim();
      }
      return c.name;
    };
    const actionAttempts = result.toolCallHistory.filter(isAction);
    const okActions = actionAttempts.filter((c) => c.ok);
    turnOkActions.push(...okActions.map((c) => ({ name: c.name, input: c.input })));
    turnOkSchedules.push(...result.toolCallHistory.filter((c) => c.ok && SCHEDULE_TOOLS.has(c.name)).map((c) => c.name));
    const stepSucceeded =
      okCalls.length > 0 && !result.error && (actionAttempts.length === 0 || okActions.length > 0);
    const evidence = okActions.length > 0
      ? okActions.map(describeCall).join(', ').slice(0, 120)
      : stepSucceeded
        ? okCalls.map((c) => c.name).join(',').slice(0, 120)
        : actionAttempts.length > 0
          ? `all ${actionAttempts.length} action call(s) failed: ${actionAttempts.map(describeCall).join(', ').slice(0, 90)}`
          : (result.error ?? 'no successful tool call');
    deps.log(
      `[plan-loop] EXECUTE ${step.id}: tools=${result.toolCallHistory.length} ok=${okCalls.length} ` +
      `actions=${okActions.length}/${actionAttempts.length} ` +
      `iters=${result.itersUsed}${result.error ? ` error=${result.error}` : ''} → ${stepSucceeded ? 'done' : 'failed'}`,
    );
    stepNotes.push(
      `- ${step.id}: ${stepSucceeded ? 'DONE' : 'FAILED'} (${evidence}). ${result.finalText.replace(/\s+/g, ' ').slice(0, 180)}`,
    );
    trackStep(step.id, stepSucceeded ? 'done' : 'blocked', evidence.slice(0, 200));
    // Per-deliverable evidence MATCHING (2026-07-02 v1.2). "Some action succeeded" is not enough:
    // prod reported 9/9 ✅ while NO post existed and NO schedule was set — the posting step made
    // ZERO action attempts (dodged into the pure-read pass) and the heartbeat step's one "action"
    // was a memory write. Each deliverable now requires the KIND of evidence its text implies:
    //   schedule-type  → a successful schedule tool call (schedule_reminder / create_calendar_event);
    //   action-type    → ≥1 successful EXTERNAL action (e.g. http POST) — zero attempts = FAILED;
    //   read-type      → the step's read rule (unchanged).
    const stepVerdicts: string[] = [];
    for (const dId of step.covers.length > 0 ? step.covers : []) {
      const cur = outcomes.get(dId);
      if (!cur) continue;
      const dText = `${plan.deliverables.find((x) => x.id === dId)?.description ?? ''} ${step.description}`;
      let dOk: boolean;
      let dEvidence: string;
      if (CREDENTIAL_SAVE_RE.test(dText) && credentialCaptured) {
        dOk = true;
        dEvidence = 'credential captured and stored by the mechanism (http-cred-capture) during registration';
      } else if (SCHEDULE_REQ_RE.test(dText)) {
        const hit = result.toolCallHistory.find((c) => c.ok && SCHEDULE_TOOLS.has(c.name));
        if (hit && !result.error) {
          dOk = true;
          dEvidence = hit.name;
        } else if (turnOkSchedules.length > 0) {
          // Turn-global fallback: the schedule already landed in an earlier step this turn.
          dOk = true;
          dEvidence = `${turnOkSchedules[0]} (satisfied by an earlier step)`;
        } else {
          dOk = false;
          dEvidence = 'requires a schedule tool (schedule_reminder) — no successful call';
        }
      } else if (ACTION_REQ_RE.test(dText)) {
        // Endpoint matching: the successful action must be THE one the deliverable names, not any write.
        const hint = ENDPOINT_HINTS.find(([k]) => k.test(dText))?.[1];
        const matched = hint
          ? okActions.filter((c) => hint.test(`${String((c.input as Record<string, unknown>).url ?? '')} ${c.name}`))
          : okActions;
        const conflict = result.toolCallHistory.find(
          (c) => !c.ok && /\b409\b|conflict|already\s+(?:used|exist|exists|registered|taken)/i.test(c.outputPreview),
        );
        // Single-use REGISTER semantics (user-confirmed): a 409 "invite already used" on a
        // register/signup deliverable PROVES registration already succeeded — the invite is
        // single-use and dies on success. Treat it as DONE, not a false FAILED that triggers an
        // endless re-register loop (prod: register kept reporting FAILED + retrying while the agent
        // was in fact already registered). For NON-register actions a 409 stays an actionable failure.
        const isRegister = /\bregister\b|\bsign\s*up\b|注册/i.test(dText);
        dOk = matched.length > 0 && !result.error;
        // Turn-global fallback: the required action already succeeded in an EARLIER step this turn
        // (adopted duplicates land in late fulfill-steps with nothing left to do).
        const globalMatched = !dOk
          ? (hint ? turnOkActions.filter((c) => hint.test(`${String(c.input.url ?? '')} ${c.name}`)) : turnOkActions)
          : [];
        if (!dOk && globalMatched.length > 0) {
          dOk = true;
          dEvidence = `${describeCall(globalMatched[0])} (satisfied by an earlier step)`;
        } else if (!dOk && conflict && isRegister) {
          dOk = true;
          dEvidence = `already registered (409 "${conflict.outputPreview.replace(/\s+/g, ' ').slice(0, 70)}" — single-use invite consumed by a prior successful registration; reuse the stored credential)`;
        } else {
          dEvidence = dOk
            ? matched.map(describeCall).join(', ').slice(0, 120)
            : conflict
              ? `409 conflict — "${conflict.outputPreview.replace(/\s+/g, ' ').slice(0, 90)}". The resource already exists; do not retry — reuse the existing one or provide a fresh input.`
              : hint
                ? `requires a successful action matching ${String(hint)} (e.g. http POST to that endpoint) — none did`
                : `requires an external action (e.g. http POST) — attempted ${actionAttempts.length}, succeeded 0`;
        }
      } else {
        dOk = stepSucceeded;
        dEvidence = evidence;
      }
      stepVerdicts.push(`${dId}=${dOk ? 'done' : 'FAILED'}`);
      if (dOk) {
        outcomes.set(dId, { id: dId, status: 'done', evidence: dEvidence });
      } else if (cur.status !== 'done') {
        outcomes.set(dId, { id: dId, status: 'failed', evidence: dEvidence });
      }
    }
    // The step log above reports STEP-level success (had ok tool calls); this reports the
    // DELIVERABLE-level verdict, which can differ (prod: a "vote" step logged → done off ok reads
    // while its vote deliverable was ❌ because no upvote POST landed). Log both to avoid misreading.
    if (stepVerdicts.length > 0) {
      deps.log(`[plan-loop] EXECUTE ${step.id}: deliverables ${stepVerdicts.join(', ')}`);
    }
  }

  // C: mechanism cookbook — record what verifiably worked so later sessions (esp. scheduled fresh
  // ones) reuse real endpoints instead of rediscovering them.
  if (deps.recordOperationalKnowledge) {
    const uniq = [...new Set(okBusinessCalls)].slice(0, 12);
    if (uniq.length > 0) {
      try {
        deps.recordOperationalKnowledge(uniq.map((l) => `${l} — verified working this run (use {credential-id} placeholder for auth)`));
        deps.log(`[plan-loop] cookbook: ${uniq.length} verified call(s) recorded`);
      } catch { /* cookbook is best-effort */ }
    }
  }

  // ── CLOSE (computed, never declared) ──────────────────────────────────────
  const list = [...outcomes.values()];
  const done = list.filter((o) => o.status === 'done').length;
  const outcome: PlanLoopResult['outcome'] =
    done === list.length && unresolvedGaps.length === 0 ? 'completed' : done > 0 ? 'partial' : 'aborted';
  if (livePlanId) {
    try {
      deps.planTracker?.close(
        livePlanId,
        outcome === 'completed',
        `[plan-loop] ${outcome}: ${done}/${list.length} deliverables with tool evidence`,
        Object.fromEntries(list.map((o) => [o.id, o.status === 'done' ? 'done' as const : o.status === 'failed' ? 'failed' as const : 'not-attempted' as const])),
      );
    } catch { /* an unclosed executing plan is caught by the pipeline auto-close */ }
  }
  // Truncate with an explicit ellipsis so a cut reads as a cut, not as the whole requirement. Wider
  // than the old 80 chars (prod: reports read as "信息总结不全" — deliverables cut mid-sentence). The
  // outbound layer chunks by byte size, so fuller lines are safe.
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = list.map((o) => {
    const mark = o.status === 'done' ? '✅' : o.status === 'failed' ? '❌' : '⏸';
    const desc = plan!.deliverables.find((d) => d.id === o.id)?.description ?? o.id;
    return `${mark} ${trunc(desc, 160)}${o.status !== 'done' && o.evidence ? ` (${trunc(o.evidence, 100)})` : ''}`;
  });
  // Cap the gap list (readability + channel size); the count is always honest.
  const shownGaps = unresolvedGaps.slice(0, 8);
  const gapLines = unresolvedGaps.length > 0
    ? `\n\n⚠️ ${unresolvedGaps.length} 项指引要求未纳入本次计划(多轮校验仍未覆盖,已如实报告):\n` +
      shownGaps.map((g) => `- ${trunc(g, 120)}`).join('\n') +
      (unresolvedGaps.length > shownGaps.length ? `\n- …另 ${unresolvedGaps.length - shownGaps.length} 项` : '')
    : '';
  const budgetNote = budgetExhausted
    ? '\n\n⏱ 时间预算耗尽,余下步骤未执行(已如实标注 ⏸)。需要的话回复"继续",我接着做剩下的。'
    : '';
  const reply =
    (outcome === 'completed'
      ? `任务完成(${done}/${list.length} 项交付,均有工具执行证据):\n`
      : outcome === 'partial'
        ? done === list.length
          ? `${done}/${list.length} 项交付均完成(有工具证据),但部分指引要求未覆盖(见下):\n`
          : `任务部分完成(${done}/${list.length} 项):\n`
        : '任务未能执行:\n') +
    lines.join('\n') +
    gapLines +
    budgetNote;
  return { outcome, deliverables: plan.deliverables, steps: plan.steps, outcomes: list, reply, unresolvedGaps };
}
