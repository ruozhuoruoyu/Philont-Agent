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
import { looksDeductive } from './phase_gate.js';

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
  /** Whether the message names a standalone goal rather than referring to prior work/context. */
  selfContained?: boolean;
  /** Whether the owner wants the exploration to keep advancing without another continue message. */
  continuous?: boolean;
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
    'chitchat. No structured reasoning or multi-step execution needed. ALSO direct: META-QUESTIONS about ' +
    'the assistant itself or its previous turn — how an answer was produced, which tool/mode was used, ' +
    'why it said something, status of its own sessions ("你这个分析是平铺的还是用deep_explore做的?", ' +
    '"你刚才用了什么工具?", "did you actually run it?"). The answer lives in the assistant\'s own ' +
    'records, never in external research.\n\n' +
    'KEY boundary: if the core ask is "figure out / which / why / whether / should" → deep_explore. If it ' +
    'is "build / set it up / make it work / deploy / implement and run" → plan. A reasoning task that only ' +
    'happens to need web search is still deep_explore, NOT plan.\n\n' +
    'CRITICAL — debugging OUR OWN artifact is NOT deep_explore. If the ask is to fix / change / correct a ' +
    'concrete artifact we produced and can simply open and edit (a file, a script, an HTML page, code), it ' +
    'is EXECUTION — route "plan" if it is several coordinated edits, "direct" if it is one fix. This holds ' +
    'even when the user phrases it as a diagnosis ("为什么搜索定位不到节点" / "点击不弹面板" / "问题4还是不对" / ' +
    '"why does the search not jump to the node"): the answer is found by READING THE FILE, not by research ' +
    'or a reasoning session. Reserve deep_explore\'s diagnosis mode for problems whose cause is genuinely ' +
    'unknown and external (a production incident, a system nobody can just read). A bug report about a ' +
    'file we just wrote is a work item, not an investigation.\n\n' +
    'Respond with ONLY a JSON object, no prose:\n' +
    '{"route":"direct|deep_explore|plan","domain":"formal|deliberate|discover","confidence":0.0-1.0,"reason":"<short>","selfContained":true|false,"continuous":true|false}\n' +
    'Set selfContained=false when the message depends on prior context (for example: this/new angle/continue/change direction).\n' +
    'Set continuous=true when the owner asks the exploration to keep pushing/running, rather than assess or advance only once.\n' +
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
  const selfContained = typeof obj.selfContained === 'boolean' ? obj.selfContained : undefined;
  const continuous = typeof obj.continuous === 'boolean' ? obj.continuous : undefined;
  return { route, domain, confidence, reason, selfContained, continuous };
}

/** A contextual deep-explore request with a live session means continue it, rather than answer flat. */
export function shouldForceRoutedDeepExploreContinue(opts: {
  decision: IntentDecision | null;
  hasActiveSession: boolean;
  advanceRanThisTurn: boolean;
  alreadyForced: boolean;
  selfReferentialMeta: boolean;
  userAsksStatus: boolean;
}): boolean {
  return opts.decision?.route === 'deep_explore' &&
    opts.decision.selfContained === false &&
    opts.hasActiveSession &&
    !opts.advanceRanThisTurn &&
    !opts.alreadyForced &&
    !opts.selfReferentialMeta &&
    !opts.userAsksStatus;
}

/** Continuous is a semantic router output; arm background work only after a real round proved the binding. */
export function shouldForceDeepExploreAutoOn(opts: {
  decision: IntentDecision | null;
  advanceRanThisTurn: boolean;
  hasActiveSession: boolean;
  autoOnRanThisTurn: boolean;
  selfReferentialMeta: boolean;
  userAsksStatus: boolean;
}): boolean {
  return opts.decision?.route === 'deep_explore' &&
    opts.decision.continuous === true &&
    opts.advanceRanThisTurn &&
    opts.hasActiveSession &&
    !opts.autoOnRanThisTurn &&
    !opts.selfReferentialMeta &&
    !opts.userAsksStatus;
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
// Per the confirmed behavior: SUGGEST by default. The engine is entered on the OWNER's word (the ask
// tier), never on a keyword or on router confidence alone. plan-route reuses the existing slow→plan
// protocol; deep_explore-route injects a nudge into the system prefix.

/**
 * NOTE (2026-07-13, owner decision): `userSignaledDepth` / DEPTH_SIGNAL_RE are GONE.
 *
 * They answered "did the owner ask for depth?" — an open-ended question about THEIR language — with a
 * keyword regex. That is the exact failure this router was built to replace (see the header: "keyword
 * enumeration loses to paraphrase"), and it failed in both directions: bare 系统 matched "编排系统"
 * (orchestration SYSTEM) and bare 深度 matched 深度学习, force-starting sessions the owner never asked
 * for; while "花点时间好好琢磨一下" matched nothing and got no depth at all.
 *
 * The regex was only load-bearing because it was the SOLE bypass of the ask tier. Rather than make it
 * accurate, the bypass itself is deleted: when the router lands in the ask tier, we ASK — always. The
 * ask is free (deep_explore is capability=execute, so entering already costs an auth prompt), and the
 * thing it buys back — never spending the owner's 6 minutes without their word — is worth far more than
 * saving them one tap. Two regressions in one week came from bypass mechanisms built to save that tap.
 *
 * Keywords remain correct where the vocabulary is OURS (classifyExploreAskReply: we told the owner to
 * type "进"/"直接"). They are wrong where the vocabulary is THEIRS.
 */

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
// exactly like force-continue guarantees a continue. Gated on the owner having approved, so it never
// fires on a casual research question (those get the ask).

// ── Three-tier deep_explore routing (2026-07-09, owner decision) ────────────────────────────
// Prod showed the advisory nudge is never adopted on research tasks (two flat runs in one day:
// the survey and the candidate-path generation both had route=deep_explore conf>=0.9 and still
// flattened into webSearch). Tiering by router confidence:
//   conf >= FORCE              → force-start without asking;
//   ASK <= conf < FORCE (0.7)  → ask the owner first (one question; their reply decides);
//   conf < ASK                 → direct flat execution, no nudge (it never worked anyway).
//
// 2026-07-12 (owner decision): FORCE defaults to 1.01 — UNREACHABLE, i.e. router CONFIDENCE ALONE
// never force-starts a session; everything >= ASK asks the owner instead. Reasons:
//   1. The force tier's accuracy was never validated, and it has a logged false positive expensive
//      enough to need a special-case patch: "你这个分析是平铺的还是使用deepexplore做的?" routed
//      conf>=0.9, was force-started, and the engine burned 9.5 minutes web-searching its own tool's
//      name (hence isSelfReferentialMetaQuestion below). Needing a special case is the tell.
//   2. Asking costs the owner NOTHING extra: deep_explore is capability='execute', so entering the
//      engine already interrupts them with an auth card. The ask replaces a contentless approval
//      prompt with a meaningful choice — same one round-trip.
//   3. The ask path CARRIES its state (pendingExploreAsk stores {goal, decision} and restores both on
//      the reply), whereas force-start's state lives in a per-turn signalBus that is silently lost
//      across a pending-auth resume (prod 2026-07-12, see the carry fix in chat-handler).
// The ONLY way in is the owner's yes (the ask tier). The keyword bypass is gone; see the note above.
// Set PHILONT_DEEP_EXPLORE_FORCE_CONF=0.9 to restore the old behavior.
export type DeepExploreRouteTier = 'force' | 'ask' | 'direct';

function parseConf(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1.01 ? n : fallback;
}

export function deepExploreRouteTier(
  dec: IntentDecision | null,
  env: NodeJS.ProcessEnv = process.env,
): DeepExploreRouteTier | null {
  if (!dec || dec.route !== 'deep_explore') return null;
  const force = parseConf(env.PHILONT_DEEP_EXPLORE_FORCE_CONF, 1.01); // 1.01 = unreachable → confidence alone never forces
  const ask = parseConf(env.PHILONT_DEEP_EXPLORE_ASK_CONF, 0.7);
  if (dec.confidence >= force) return 'force';
  if (dec.confidence >= ask) return 'ask';
  return 'direct';
}

/**
 * The one question the ask tier sends (the reply is classified grant/deny like an auth card).
 *
 * Kept to one line with SINGLE-KEYSTROKE answers. The first version explained the engine in two
 * sentences and asked the owner to type 进 or 直接 — and in production (2026-07-24 16:33 and 17:34) the
 * owner typed 深度推理 instead, four characters, on a phone, twice. A question the recipient answers by
 * retyping its subject line is asking too much: this fires on every borderline task, so the cost is paid
 * over and over. The digits are the primary answer; the words stay accepted (see
 * classifyExploreAskReply) because someone who already learned them must not be punished for it.
 *
 * A THIRD option was added later, and it went on 3 — not into the middle. `2` had meant "just answer
 * me" since the two-option version, and this owner replies to the card with a bare digit (prod
 * 2026-08-25 21:57:50: `1`). Renumbering so that 2 means "hand the session to a background ticker"
 * would turn the most conservative answer into the most autonomous one, silently, for anyone acting on
 * muscle memory. These are OUR words handed to the owner; their meaning may be extended, never moved.
 */
export function buildDeepExploreAskText(dec: IntentDecision | null): string {
  const mode = dec?.domain === 'formal' ? '形式化证明' : '循证推演';
  return `🧭 进深度推理引擎?(${mode}:跨天续跑、逐节点验证,每轮约 10 分钟)\n回 1 = 进一轮 · 2 = 直接答 · 3 = 自动持续`;
}

/**
 * Classify a reply to the ask-tier question DETERMINISTICALLY, on the exact vocabulary the question
 * itself offered ("进" → engine, "直接" → flat). Returns null when the reply is neither, so the caller
 * can fall back to the generic authorisation classifier.
 *
 * Why this must not go through the generic classifier (prod 2026-07-13): buildDeepExploreAskText tells
 * the owner 回复"直接"就快速平铺作答 — i.e. 直接 is our DENY word. But the ask reply was handed to the
 * generic auth classifier, whose prompt only asks "did the user authorise the operation?". Read in
 * isolation, 直接 means "just go ahead / do it directly" → the LLM answered `grant`, and the log shows
 * `ask-tier APPROVED` on a reply that was an explicit REFUSAL. We literally told the user which word to
 * type and then used a classifier that does not know that word. Under the old code this was mostly
 * harmless (the model happened not to call deep_explore); once force-start is evaluated at every
 * terminal path, exploreAskApproved is authoritative and this would FORCE a reasoning session onto a
 * task the owner just declined. The words we hand out must be matched, not inferred.
 */
export function classifyExploreAskReply(reply: string): 'grant' | 'auto' | 'deny' | null {
  const r = (reply ?? '').trim().toLowerCase().replace(/[。！？，,!?.\s]+/g, '');
  if (!r) return null;
  // The offered answers FIRST — 1 and 2 are what the question now hands out, so they must be matched
  // here and never inferred by a general classifier (a bare "2" means nothing to a model asked "did the
  // user authorise this?"). Then the words the older question offered, plus the near-synonyms people
  // type instead: someone who learned 进/直接 must not be punished for still using them.
  if (/^[1１]$/.test(r)) return 'grant';
  // 2 has meant "just answer me" since the two-option card. The auto option is additive, on 3.
  if (/^[2２]$/.test(r)) return 'deny';
  if (/^[3３]$/.test(r)) return 'auto';
  if (/^(自动|自己跑|持续|自动持续|不用问我)$/.test(r)) return 'auto';
  if (/^(进|进入|深度推理|深度|深入|深挖|推理|开始深度推理)$/.test(r)) return 'grant';
  if (/^(直接|平铺|快速|快答|直接答|不用|不深入|简单说)$/.test(r)) return 'deny';
  return null; // anything else → generic classifier
}

export function deepExploreForceStartEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_FORCE_START ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function shouldForceDeepExploreStart(opts: {
  decision: IntentDecision | null;
  /**
   * Depth is ESTABLISHED for this turn — i.e. the owner approved via the ask tier (or the force tier is
   * explicitly re-enabled by env). No longer inferred from keywords in the owner's message: see the note
   * above DEPTH_SIGNAL_RE's removal.
   */
  explicitDepth: boolean;
  /** The message carries a self-contained goal (long enough to stand alone, not a bare "重做"/"深入点"). */
  goalSubstantial: boolean;
  alreadyForcedStart: boolean;
  alreadyForcedContinue: boolean;
  deepExploreRanThisTurn: boolean;
  hasActiveSession: boolean;
  /** Three-tier routing: 'force' (env-restorable only) enters without asking. */
  tier?: DeepExploreRouteTier | null;
  /** The owner answered the ask-tier question with approval this turn. */
  approvedViaAsk?: boolean;
  /** The message is a meta-question about the assistant itself (isSelfReferentialMetaQuestion). */
  selfReferentialMeta?: boolean;
}): boolean {
  if (opts.alreadyForcedStart || opts.alreadyForcedContinue) return false; // anti-reentry
  if (!opts.decision || opts.decision.route !== 'deep_explore') return false;
  if (opts.selfReferentialMeta) return false; // meta-question about the assistant — never a session goal
  // Entry: the owner said yes (ask tier), or the force tier was explicitly re-enabled by env.
  if (!opts.explicitDepth && opts.tier !== 'force' && !opts.approvedViaAsk) return false;
  // A forced session needs a real goal. Short context-dependent messages ("调研深度不够，重做", "深入点")
  // point at the PRIOR topic the harness can't capture as a goal → don't auto-start a garbage session.
  if (!opts.goalSubstantial) return false;
  if (opts.deepExploreRanThisTurn) return false; // model already used the engine → nothing to force
  if (opts.hasActiveSession) return false; // a session exists → continue path / force-continue handles it
  return true;
}

/**
 * Meta-questions about the assistant itself must never become a deep_explore GOAL (prod
 * 2026-07-09: "你这个分析是平铺的还是使用deepexplore做的?" was force-started as a session — the
 * engine spent 9.5 minutes web-searching its own tool's name and a dictionary entry for 平铺 to
 * answer a question whose answer sits in its own ledger). Heuristic: the message references the
 * assistant's own machinery (tool/mode names) or its previous output in second person.
 */
export function isSelfReferentialMetaQuestion(msg: string): boolean {
  const m = (msg ?? '').toLowerCase();
  const mentionsMachinery =
    /deep[\s_-]?explore|philont|平铺|工作日志|work log|honesty|执行账本|ledger|什么工具|哪个工具|which tool|what tool/.test(m);
  const referencesPriorSelf =
    /你(?:这|刚|上|之前|前面)|你的(?:分析|回答|报告|结论)|(?:刚才|上一(?:条|轮|次)|之前)的?(?:分析|回答|报告|结论)|did you|你是怎么|你用(?:了|的)/.test(m);
  return mentionsMachinery && referencesPriorSelf;
}

/** Does the message carry a self-contained reasoning goal? (Crude length proxy; dense Chinese ≥ ~12 chars.) */
export function messageIsSelfContainedGoal(userMessage: string): boolean {
  return (userMessage ?? '').trim().length >= 12;
}

/** Build the synthetic deep_explore(start) input. mode is passed only for formal/deliberate (discover is an
 * action, not a mode); omitted → the engine auto-detects the domain from the goal. goal = the user message.
 *
 * 2026-07-27. The mode is not a label — it picks the round's TOOL SET. `formal` gets pariGp / z3Verify /
 * magnitude and deliberately NO web (web tools "degrade the reasoning loop to browsing"); `deliberate` gets
 * the web and no verifier at all. And an explicitly passed mode outranks classifyGoal, the detector that
 * reads the goal text.
 *
 * So a guess made here is permanent. Production: "继续LRC深度推理" — an acronym the aux model cannot
 * resolve — came back `deep_explore:deliberate` (deliberate is also what parseIntentDecision falls back to
 * whenever the domain is missing or unrecognised), and the Lonely Runner PROOF session was created with no
 * way to compute anything. Its next round spent eleven web searches and one decomposition, proved nothing,
 * and the owner said 你怎么又找回来其它的问题了.
 *
 * A guess must not outrank evidence. `looksDeductive` reads the goal itself and is deliberately
 * conservative — it fires on 证明 / 猜想 / 定理 / prove / conjecture / theorem and math symbols, not on
 * topic. When it fires and the router said `deliberate`, the router was defaulting; drop the pin and let
 * the engine classify. `formal` from the router is kept as-is: it is a positive claim, not a fallback.
 */
export function buildForceStartInput(
  decision: IntentDecision | null,
  userMessage: string,
): { action: 'start'; goal: string; mode?: 'formal' | 'deliberate' } {
  const goal = (userMessage ?? '').trim().slice(0, 2000);
  const dom = decision?.domain;
  let mode = dom === 'formal' || dom === 'deliberate' ? dom : undefined;
  if (mode === 'deliberate' && looksDeductive(goal)) mode = undefined;
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
