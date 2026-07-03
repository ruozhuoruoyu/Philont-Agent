/**
 * Turn-entry intent router (aux-LLM, 3-way) — decide which engine a substantive turn should use.
 *
 * The legacy `autoClassify` (task_mode_classifier.ts) is a pure keyword heuristic with only two outcomes
 * (fast vs slow→plan). It misses two things: (1) keyword enumeration loses to paraphrase, and (2) it has
 * no notion of the deep_explore reasoning engine — so research/selection/diagnosis/proof tasks fall through
 * to a flat main-loop webSearch dump (observed: three WeChat turns re-searched the same landscape for ~12
 * min with zero carried-over state, because nothing routed them to a persistent deep_explore session).
 *
 * This module adds a semantic router over the cheap aux model (deepseek-flash), gated behind a lenient
 * pre-filter so chitchat never pays for a classification:
 *   - "deep_explore" — THINK / DECIDE: the deliverable is understanding or a conclusion reached by
 *     structured reasoning/investigation, and it benefits from a persistent reasoning session. Covers ALL
 *     deep_explore domains (formal proof / deliberate analysis-research-selection-design-evaluation /
 *     discover open-problems), not just selection/comparison.
 *   - "plan" — DO / BUILD: the deliverable is a completed multi-step task with side effects (build, deploy,
 *     integrate, configure, implement-and-run, migrate, refactor) — the plan-review-execute-revise path.
 *   - "direct" — a single lookup / single action / quick answer / confirmation / chitchat.
 *
 * The router only PRODUCES a decision; wiring (a lightweight proactive suggestion, or deferring to the
 * existing plan protocol) is the caller's job. Default ON; PHILONT_INTENT_ROUTER=0/off/false/no disables it.
 */
import { callAuxLLM, isAuxLLMConfigured, type AuxLLMRequest } from '@agent/tools';

export type IntentRoute = 'direct' | 'deep_explore' | 'plan';
export type DeepExploreDomain = 'formal' | 'deliberate' | 'discover';

export interface IntentDecision {
  route: IntentRoute;
  /** Only meaningful when route === 'deep_explore'. */
  domain?: DeepExploreDomain;
  /** 0..1 self-reported confidence (clamped). */
  confidence: number;
  /** Short rationale (for audit / the suggestion text). */
  reason: string;
}

export function intentRouterEnabled(): boolean {
  const v = (process.env.PHILONT_INTENT_ROUTER ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Pure pre-filter: should we spend an aux call classifying this turn? Lenient by design — let anything
 * substantive through (broad coverage is the goal), skip only the obviously trivial (greetings, acks,
 * "继续"/"停", single-word replies) so chitchat costs nothing.
 */
const TRIVIAL_TURN_RE =
  /^(?:继续|接着|往下|好的?|行|可以|对|是的?|嗯+|哦+|谢+|谢谢|多谢|收到|了解|明白|停|算了|没事|ok|okay|yes|no|yep|nope|thx|thanks?|sure|got\s*it|cool|nice|done)[\s!.。！？~]*$/i;

export function shouldClassifyIntent(userMessage: string): boolean {
  const t = (userMessage ?? '').trim();
  // Floor is deliberately tiny — dense Chinese commands are short ("调研深度不够，重做" is 9 chars, "为什么会崩"
  // is 5) and a 12-char floor wrongly skipped them (observed: "调研深度不够，重做" fell through to flat
  // webSearch). Only 1-3 char fragments are pure noise; the ack/greeting regex catches the rest, and the
  // aux call cheaply returns "direct" for whatever chitchat slips past.
  if (t.length < 4) return false;
  if (TRIVIAL_TURN_RE.test(t)) return false;
  return true;
}

export function buildIntentPrompt(userMessage: string): string {
  return (
    'You route a user turn to exactly ONE of three engines. Decide by the DELIVERABLE, not the topic.\n\n' +
    'ROUTE "deep_explore" — THINK / DECIDE. The deliverable is understanding or a conclusion reached by ' +
    'structured reasoning/investigation (decompose → weigh alternatives → verify → converge), and it ' +
    'benefits from a persistent reasoning session. Use for: investigating / surveying a topic; comparing / ' +
    'selecting / trade-offs; analyzing why / root-causing / diagnosing; evaluating feasibility / ' +
    'forecasting / judging worth; designing an approach at the conceptual level; proving / deriving / ' +
    'formally verifying; strategizing / deciding under uncertainty; open or hard questions with no single ' +
    'lookup answer; or any explicit request for depth (深入 / 系统 / 彻底 / 全面 / 深度).\n' +
    '  domain "formal": proof / derivation / formal verification (math, logic).\n' +
    '  domain "deliberate": evidence-based analysis, research, comparison, design, evaluation, decision.\n' +
    '  domain "discover": open problems / generating new conjectures or angles.\n\n' +
    'ROUTE "plan" — DO / BUILD. The deliverable is a COMPLETED multi-step task with side effects: building, ' +
    'deploying, integrating, configuring, implementing-and-running, onboarding, migrating, refactoring — ' +
    'work that executes concrete actions (write files, run commands, call APIs) and benefits from a plan ' +
    'with review/revise.\n\n' +
    'ROUTE "direct" — a single lookup, a single action, a quick factual answer, a confirmation, or ' +
    'chitchat. No structured reasoning or multi-step execution needed.\n\n' +
    'KEY boundary: if the core ask is "figure out / which / why / whether / should" → deep_explore. If it ' +
    'is "build / set it up / make it work / deploy / implement and run" → plan. A reasoning task that only ' +
    'happens to need web search is still deep_explore, NOT plan.\n\n' +
    'Respond with ONLY a JSON object, no prose:\n' +
    '{"route":"direct|deep_explore|plan","domain":"formal|deliberate|discover","confidence":0.0-1.0,"reason":"<short>"}\n' +
    'Omit "domain" unless route is deep_explore.\n\n' +
    'User message:\n"""\n' +
    userMessage.slice(0, 2000) +
    '\n"""'
  );
}

/** Robust parse: extract the first JSON object and validate the route/domain enums. Returns null on junk. */
export function parseIntentDecision(raw: string): IntentDecision | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const route = obj.route;
  if (route !== 'direct' && route !== 'deep_explore' && route !== 'plan') return null;
  let domain: DeepExploreDomain | undefined;
  if (route === 'deep_explore') {
    const d = obj.domain;
    domain = d === 'formal' || d === 'deliberate' || d === 'discover' ? d : 'deliberate';
  }
  const confRaw = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
  const confidence = Math.max(0, Math.min(1, confRaw));
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 200) : '';
  return { route, domain, confidence, reason };
}

// ── Deterministic cleanup/cancel override (mechanism, not aux) ─────────────────────────────────────
//
// "清除/删除/取消/停止 X" is a direct execution instruction, not a task to PLAN or a question to
// EXPLORE. Field evidence: the aux model routed the SAME cleanup phrasing three different ways
// ("清除所有定时"→direct, "清除mycox记忆、定时和技能"→plan, "清除mycox相关的记忆和技能"→deep_explore),
// and the plan/deep_explore routes dragged a trivial deletion through placeholder-plan → gate →
// auth_pending / deep_explore, so the user could not cleanly cancel anything. A cleanup command must
// deterministically route to `direct` regardless of the aux model.
const CLEANUP_VERB_RE =
  /清除|清空|清理|删除|删掉|移除|取消|停止|关闭|注销|禁用|卸载|\bforget\b|\bdelete\b|\bclear\b|\bcancel\b|\bstop\b|\bremove\b|\bdisable\b|\buninstall\b|\bpurge\b|\bwipe\b/i;
const CLEANUP_TARGET_RE =
  /记忆|技能|定时|任务|提醒|计划|凭证|密钥|事实|笔记|schedul|reminder|memor|skill|credential|secret|fact|note|task|cron|plan/i;
// A message that also asks to BUILD/REGISTER/… is a real task that happens to mention cleanup — not a
// pure cleanup command; let the normal router handle it.
const BUILD_VERB_RE =
  /注册|部署|实现|搭建|构建|集成|配置|迁移|重构|设计|开发|\bregister\b|\bdeploy\b|\bimplement\b|\bbuild\b|\bintegrate\b|\bconfigure\b|\bmigrate\b|\brefactor\b|\bdesign\b|\bdevelop\b/i;

/** A pure, direct-execution cleanup/cancel command (delete/clear/cancel/stop a memory/skill/schedule/…). */
export function looksLikeCleanupIntent(userMessage: string): boolean {
  const s = (userMessage ?? '').trim();
  if (!s || s.length > 120) return false; // a long message is likely a real task, not a bare cleanup
  if (!CLEANUP_VERB_RE.test(s) || !CLEANUP_TARGET_RE.test(s)) return false;
  if (BUILD_VERB_RE.test(s)) return false; // "clear X then build Y" → real task
  return true;
}

export interface ClassifyIntentDeps {
  /** Injectable aux caller (defaults to callAuxLLM) — lets tests run without a live model. */
  call?: (req: AuxLLMRequest) => Promise<string>;
  signal?: AbortSignal;
}

/**
 * Classify a turn. Returns null when the router is disabled, the aux model is unconfigured, the turn is
 * trivial (pre-filter), or the aux call fails / returns junk — in every null case the caller simply keeps
 * today's behavior. Never throws.
 */
export async function classifyIntent(
  userMessage: string,
  deps: ClassifyIntentDeps = {},
): Promise<IntentDecision | null> {
  if (!intentRouterEnabled()) return null;
  // Deterministic short-circuit: a pure cleanup/cancel command is direct execution — skip the aux
  // call and never let it route to plan/deep_explore (which stall a trivial deletion).
  if (looksLikeCleanupIntent(userMessage)) {
    return { route: 'direct', confidence: 1, reason: 'cleanup/cancel — direct execution' };
  }
  if (!shouldClassifyIntent(userMessage)) return null;
  const call = deps.call ?? callAuxLLM;
  if (deps.call === undefined && !isAuxLLMConfigured()) return null;
  let raw: string;
  try {
    raw = await call({
      system: 'You are a precise intent classifier. Output only the requested JSON object.',
      user: buildIntentPrompt(userMessage),
      maxTokens: 200,
      signal: deps.signal,
    });
  } catch {
    return null;
  }
  return parseIntentDecision(raw);
}

// ── Wiring helpers (pure) ────────────────────────────────────────────────────────────────────────
//
// Per the confirmed behavior: SUGGEST by default, but go straight in when the user explicitly signaled
// depth/commitment (深入/深度/系统/彻底…) or the classifier is highly confident. plan-route reuses the
// existing slow→plan protocol; deep_explore-route injects a nudge into the system prefix.

const DEPTH_SIGNAL_RE =
  /深入|深度|系统(?:地|性)?|彻底|全面|仔细|认真|好好(?:地)?|详细|深挖|钻研|逐一|逐条|严谨|\bin[-\s]?depth\b|\bthorough|\bsystematic|\brigorous|\bdeep[-\s]?dive\b/i;

/** Did the user explicitly ask for depth/thoroughness → start the engine directly instead of offering. */
export function userSignaledDepth(msg: string): boolean {
  return DEPTH_SIGNAL_RE.test(msg ?? '');
}

/** plan route with enough confidence → drive the existing slow→plan protocol (reuse, don't reinvent). */
export function planRouteWantsSlow(dec: IntentDecision | null): boolean {
  return !!dec && dec.route === 'plan' && dec.confidence >= 0.6;
}

/**
 * A confident `direct` route → stay fast, overriding the legacy keyword classifier's slow verdict.
 * The keyword heuristic flags heavy words (记忆/技能/定时/…) as slow even for a bare "清除定时和技能"
 * deletion; the router's explicit direct decision (esp. the confidence-1 cleanup short-circuit) is the
 * authority and must not be dragged into the placeholder-plan protocol.
 */
export function directRouteWantsFast(dec: IntentDecision | null): boolean {
  return !!dec && dec.route === 'direct' && dec.confidence >= 0.6;
}

// ── Force-START (mechanism, not prompt) ──────────────────────────────────────────────────────────
//
// Field evidence (4 WeChat turns): for deep_explore-routed research requests the model keeps doing flat
// main-loop webSearch and ignores the soft START nudge. Soft prompts lose to the model's flat-search
// default. So when the user EXPLICITLY asked for depth and the model still answered flat without ever
// calling deep_explore, the harness synthesizes a real deep_explore(action=start) — grounding + round 1 —
// exactly like force-continue guarantees a continue. Gated by explicitDepth so it never fires on a casual
// research question (those only ever get the soft OFFER).

export function deepExploreForceStartEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_FORCE_START ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function shouldForceDeepExploreStart(opts: {
  decision: IntentDecision | null;
  explicitDepth: boolean;
  /** The message carries a self-contained goal (long enough to stand alone, not a bare "重做"/"深入点"). */
  goalSubstantial: boolean;
  alreadyForcedStart: boolean;
  alreadyForcedContinue: boolean;
  deepExploreRanThisTurn: boolean;
  hasActiveSession: boolean;
}): boolean {
  if (opts.alreadyForcedStart || opts.alreadyForcedContinue) return false; // anti-reentry
  if (!opts.decision || opts.decision.route !== 'deep_explore') return false;
  if (!opts.explicitDepth) return false; // only the confirmed "明确要深度才直接进" case
  // A forced session needs a real goal. Short context-dependent messages ("调研深度不够，重做", "深入点")
  // point at the PRIOR topic the harness can't capture as a goal → don't auto-start a garbage session.
  if (!opts.goalSubstantial) return false;
  if (opts.deepExploreRanThisTurn) return false; // model already used the engine → nothing to force
  if (opts.hasActiveSession) return false; // a session exists → continue path / force-continue handles it
  return true;
}

/** Does the message carry a self-contained reasoning goal? (Crude length proxy; dense Chinese ≥ ~12 chars.) */
export function messageIsSelfContainedGoal(userMessage: string): boolean {
  return (userMessage ?? '').trim().length >= 12;
}

/** Build the synthetic deep_explore(start) input. mode is passed only for formal/deliberate (discover is an
 * action, not a mode); omitted → the engine auto-detects the domain from the goal. goal = the user message. */
export function buildForceStartInput(
  decision: IntentDecision | null,
  userMessage: string,
): { action: 'start'; goal: string; mode?: 'formal' | 'deliberate' } {
  const goal = (userMessage ?? '').trim().slice(0, 2000);
  const dom = decision?.domain;
  const mode = dom === 'formal' || dom === 'deliberate' ? dom : undefined;
  return mode ? { action: 'start', goal, mode } : { action: 'start', goal };
}

/**
 * The deep_explore nudge appended to the system prefix (messages[0]). START directly on explicit depth or
 * high confidence; otherwise instruct the model to OFFER a one-line suggestion before answering flat.
 * Returns '' for non-deep_explore routes (the caller skips).
 */
export function buildDeepExploreNudge(dec: IntentDecision | null, explicitDepth: boolean): string {
  if (!dec || dec.route !== 'deep_explore') return '';
  const mode = dec.domain ?? 'deliberate';
  // START directly ONLY when the USER signaled depth (深入/深度/系统/彻底…) — the confirmed "明确要深度才直接
  // 进" behavior. Classifier confidence measures "is this deep_explore", NOT "how much depth the user wants",
  // so a high-confidence light "调研一下" still only gets an OFFER, never an auto-started session.
  const goStraightIn = explicitDepth;
  if (goStraightIn) {
    return (
      '\n\n[intent-router] This turn is a deliberate reasoning task (deep_explore domain=' +
      mode +
      '). START a deep_explore session for it now (action=start, mode=' +
      mode +
      ') and work it through the engine — do NOT answer with a flat one-shot web-search dump. The engine ' +
      'structures the reasoning, verifies, and persists so it can be continued.'
    );
  }
  return (
    '\n\n[intent-router] This turn looks like a deliberate reasoning task (deep_explore domain=' +
    mode +
    ') that the deep_explore engine would handle better — structured, verifiable, and persistent (so you ' +
    'build on it instead of re-searching the same ground each turn). Before answering flat, briefly OFFER ' +
    'the user ONE sentence: ask whether to run it as a deep_explore session. Do not over-explain the offer.'
  );
}
