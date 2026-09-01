/**
 * Phase 18 (2026-06-15) ViabilityGate — the missing ACTUATOR.
 *
 * Problem it solves: philont already had all the SENSORS for "this goal is doomed" — grounding
 * [barrier] cards / matchBarriers, deep_explore noProgressRounds (Tooth-B strict progress),
 * reflection same_root_cause — but every one of them only NARRATED to the user or injected a soft
 * hint for a FUTURE turn. None could change the action of the CURRENT turn. The recurring
 * enthusiastic "要我继续吗 / shall I continue?" next-action pitch was pure LLM text under no gate.
 *
 * This gate reads those sensors and converts red signals into a verdict:
 *   continue        — fine, keep going.
 *   pivot           — the current METHOD is stalling but a real alternative exists → recommend it.
 *   stop_and_report — generic stall/doom → recommend stopping/reframing (user may still continue).
 *   intractable     — the GOAL itself is a known open problem; there is no try-able path. State the
 *                     categorical truth, offer NO path, do NOT invite "继续". (2026-06-16)
 *
 * The intractable verdict is the fix for the false-hope loop: previously even "stop" handed the user a
 * circumvention to try and ended with "reply 继续 to keep probing" — so the user always tried again. For a
 * genuinely open problem (Erdős–Straus, binary Goldbach), the "circumventions" are themselves unsolved
 * research, NOT paths; presenting them as try-able is the lie. intractable says so plainly and stops offering.
 *
 * Design: pure + dependency-free so it unit-tests trivially. The caller (chat-handler) gathers the raw
 * materials (barrier match incl. goalIsOpenProblem, session summary, same-root-cause count) and passes them in.
 *
 * Single env knob (rollout kill-switch, read in chat-handler): PHILONT_VIABILITY_GATE=0 disables the gate.
 * Everything else is a constant with a sensible default — no per-threshold env vars.
 */

import { INTERNAL_CORRECTION_FOOTER, INTERNAL_CORRECTION_FOOTER_NL } from './internal_correction.js';

export type ViabilityVerdict = 'continue' | 'pivot' | 'stop_and_report' | 'intractable';

/** Score ≥ this → stop_and_report. Constant: one internal scoring scale, no per-deployment tuning. */
const STOP_SCORE = 4;
/** Score ≥ this → pivot. */
const PIVOT_SCORE = 2;
/** noProgressRounds threshold that counts as stalled (mirrors deep_explore STUCK_ESCALATE_AFTER). */
const STUCK_ROUNDS = 3;
/** Prior consecutive non-continue verdicts after which a fresh 'pivot' escalates to 'stop' (de-facto stuck). */
const RATCHET_PIVOTS = 3;
/**
 * Minimum settled nodes (proved + dead_end) the CURRENT reasoning session must have before a generic
 * stop_and_report is allowed. 2026-06-17: prod showed the gate declaring "撞了 6 次" on a brand-new
 * direction the user had just redirected to — because same_root_cause (a global 24h ledger) and a stale
 * recommend_stop carried over from the PREVIOUS direction. You cannot honestly declare a wall you have not
 * walked into THIS episode. Below this floor a would-be stop is downgraded to `continue` so the direction
 * actually gets run first. Does NOT affect `intractable` (a known-open-problem goal is out of reach
 * regardless of attempts) — only the generic stall verdict.
 */
const MIN_EPISODE_ATTEMPTS = 2;
/**
 * Dead-ends + refutations on the goal at/above which a STUCK session is treated as a self-derived no-go
 * (de-facto intractable) even without a curated barrier match. Set high enough that ordinary backtracking
 * doesn't trip it — only a session that has ruled out this many approaches AND is stuck. (2026-06-24)
 */
const DEAD_END_INTRACTABLE_THRESHOLD = 4;

export interface ViabilityInput {
  /** Whether an owner-scoped active reasoning session exists. Gate is inert (continue) without one. */
  hasActiveSession: boolean;
  /** A matched barrier whose blocked METHOD was detected (severity 'applies'), not merely a hard goal. */
  barrierApplies: boolean;
  /** Title of the first applied barrier, for the honest no-go directive (optional). */
  barrierTitle?: string;
  /** Curated circumvention of the first applied barrier (optional). For pivot/stop it's the recommended
   *  reframe; for intractable it is named ONLY to explain it is itself unsolved, never as a path to try. */
  barrierCircumvention?: string;
  /** The matched barrier's GOAL is a famous OPEN problem (the circumvention is research-grade, not a path).
   *  Drives the intractable verdict. */
  goalIsOpenProblem: boolean;
  /** Consecutive rounds with no net tree progress (Tooth-B strict). */
  noProgressRounds: number;
  /** Reasoning session status. */
  status: string | null;
  /** Proved nodes accumulated so far. */
  provedCount: number;
  /** Actionable open frontier size. */
  openFrontierCount: number;
  /** Max same-signature failure cluster in the recent window (reflection's own signal). */
  sameRootCause: number;
  /** Rough turn count (user string messages this turn window), mirrors reflection.turnCount. */
  turnCount: number;
  /** WS4: reflection emitted recommend_stop for this session on a prior turn. */
  recommendStop: boolean;
  /** A deep_explore advance round ran AND reset noProgressRounds this turn → real progress. Vetoes stop. */
  madeProgressThisTurn: boolean;
  /**
   * Settled nodes (proved + dead_end) in the CURRENT reasoning session = how many real attempts this
   * EPISODE has had. A generic stop_and_report requires this to reach MIN_EPISODE_ATTEMPTS; a freshly
   * redirected direction (≈0) can't be declared a wall before it's actually been tried. 0 when no session.
   */
  attemptsThisEpisode: number;
  /**
   * Consecutive PRIOR turns this session got a non-continue viability verdict (the gate kept saying "stalling").
   * Generalizes intractable to goals NOT in the curated barrier library: if we've recommended pivot this many
   * turns running with nothing improving, that IS de-facto intractable → escalate pivot → stop. (2026-06-16)
   */
  repeatedPivotCount: number;
  /**
   * Dead-end + refuted nodes the CURRENT session has recorded on the goal (2026-06-24). When the agent
   * itself has ruled out many approaches and is genuinely stuck, that is a self-derived no-go even when the
   * goal matched NO curated barrier — the Goldbach run derived "additive-decay can't separate primes from
   * semiprimes" itself, but goalIsOpenProblem stayed false (the exotic framing didn't match parity-barrier),
   * so intractable never fired and the agent kept pitching new angles. Optional; defaults to 0.
   */
  deadEndCount?: number;
}

export interface ViabilityResult {
  verdict: ViabilityVerdict;
  score: number;
  reasons: string[];
  /** Short human-readable no-go summary for the regen directive + log line. */
  evidence: string;
  /** The recommended reframe to surface (barrier circumvention). Omitted for intractable — no path to offer. */
  recommendedReframe?: string;
}

/** True for the verdicts that should stop the pursuit (downgrade the outcome, arm abandon-on-accept). */
export function isStopVerdict(v: ViabilityVerdict): boolean {
  return v === 'stop_and_report' || v === 'intractable';
}

/**
 * Detects a "shall I continue?" continuation pitch in drafted text. Used after the regen to confirm
 * the model dropped the pitch; if it didn't and the verdict stops, the caller deterministically
 * downgrades the outcome. Deliberately matches the QUESTION form ("要我继续吗 / shall I continue"),
 * not the bare word 继续 (which legitimately appears in "reply 继续 to keep going").
 */
// NOTE (2026-06-24): the verb enumeration below is a known-incomplete STOPGAP — it leaked "要不要试?" /
// "要不要搞一下?" in production because 试/搞/碰 were not listed (and the next synonym will leak again).
// Enumerating surface forms of "shall I continue" is a losing game against an open paraphrase space; the
// REAL suppression is the intractable/self_derived_no_go verdict (computeViability) rewriting the reply so
// no pitch is offered. This regex is only the post-regen confirm that a residual pitch was dropped.
export const CONTINUATION_PITCH_RE =
  /要(?:我|不要)?[^。\n？?]{0,14}(?:继续|推进|深入|开始|开攻|往下|试|搞|碰)[^。\n？?]{0,6}(?:[吗嘛]\s*[?？]?|[?？])|是否(?:要|需要|继续|推进)|要不要(?:我)?[^。\n？?]{0,10}(?:继续|推进|深入|开|试|搞|碰)|继续(?:推进|攻|探|深入)?\s*[?？]|shall I (?:continue|proceed|keep going|go on)|want me to (?:continue|keep|proceed|go on)|should I (?:continue|keep|proceed|go on)/i;

/**
 * WS2: the user EXPLICITLY accepts stopping / reframing (after a stop was recommended).
 * Only then is the reasoning session abandoned — counsel-only, we never abandon on ambiguity.
 */
export const VIABILITY_ACCEPT_RE =
  /算了|不弄了|不做了|不搞了|放弃|换(?:个|一个|条)?(?:框架|方向|方法|思路|题|问题|路)|到此为止|先停|停(?:下|吧|了)|结束(?:吧|了)?|收(?:工|尾)|good enough|give up|let'?s stop|abandon|move on/i;

/** WS2: the user wants to keep going despite the wall — overrides acceptance, keeps the session active. */
export const VIABILITY_CONTINUE_RE = /继续|接着|再(?:试|跑|来|攻|想)|go on|keep going|continue|顶(?:着|上)|硬(?:上|刚)/i;

/**
 * Imperative "start doing it" words (complements VIABILITY_CONTINUE_RE) — approving a proposed next step.
 * Covers: explicit start words (启动/开始/开搞/开干/动手/执行/实施/落地), the "去<verb>" form (去做/去搞/去
 * 整理…), and the very common "<verb>…吧" imperative (整理论文吧 / 做这个吧 / 写代码吧) — a short verb-led
 * directive ending in 吧. Acceptance phrases (算了吧/放弃) are NOT verbs in the list and are also screened by
 * VIABILITY_ACCEPT_RE in the caller, so "算了吧" never reads as push-forward.
 */
const PUSH_FORWARD_RE =
  /启动|开吧|开始|开搞|开干|开整|做吧|干吧|搞起|动手|执行|实施|落地|去(?:做|搞|弄|写|跑|试|整理|执行|办|查)|(?:做|搞|弄|写|跑|试|整理|办|干|上|来)\S{0,5}吧|\bgo\b|\bstart\b|\bdo it\b|\bproceed\b/i;
/**
 * The prior turn OFFERED to do something and asked the user to choose/approve ("要我开这个搜索吗？", "要不要我
 * 列几个？", "选哪个？", "shall I…?"). Broader than CONTINUATION_PITCH_RE (which only catches the "要继续吗"
 * form) so commit-on-affirm recognizes the real proposal pitches seen in prod, not just literal "continue".
 */
const OFFER_QUESTION_RE =
  /(?:要(?:不要)?(?:我)?|我来|我帮你|选哪个|并行开|shall i|want me to|should i)[^。\n？?]{0,30}[?？]/i;
/** A bare acknowledgement, too ambiguous on its own to count as a stop-override. */
const BARE_AFFIRM_RE = /^\s*(?:ok|okay|yes|y|嗯+|好的?|收到|continue)\s*$/i;

/**
 * Vocabulary that only means "go on". Removed from a message before asking whether anything of
 * substance is left — so "继续下一步" reads as the continuation it is, while "继续，先把 Region3 的等分布
 * 引理证了" keeps its direction and still counts.
 */
const CONTINUATION_ONLY_RE =
  /(?:继续|接着|接下来|再来|再跑|再试|再推|下一步|往下|推进一?下?|探索一?下?|一下|一次|一轮|吧|呢|啊|好的?|ok|okay|please|pls|keep\s+going|go\s+on|carry\s+on|continue|next\s+step|proceed)/gi;

export interface TurnAnchorDecision {
  /** User overrode an accumulated stop (explicit push-forward OR a substantive redirect) → caller resets the
   *  doom accounting and anchors a fresh episode. */
  doomReset: boolean;
  /** Prior turn pitched a concrete next step AND the user approved → force EXECUTION this turn (no re-propose). */
  commit: boolean;
  /** Inject the stay-on-target / anti-substitution directive (redirect or commit). */
  anchor: boolean;
}

/**
 * Pure decision for the two "do, don't re-propose / don't substitute" anchors (2026-06-17). Caller supplies
 * the last assistant message text, the new user message, and whether doom had accumulated (pivot streak /
 * recommend_stop). Keeps the linguistic rules in this tested module; the caller only applies side effects.
 */
export function decideTurnAnchors(input: {
  lastAssistantText: string;
  userMessage: string;
  hadDoom: boolean;
  /**
   * Doom that has accumulated but that NOBODY WAS TOLD ABOUT — tree state alone (stalled rounds, dead
   * ends). It licenses a narrower override than `hadDoom`: a substantive redirect only, never a bare
   * push-forward.
   *
   * The asymmetry is the whole point. A bare "继续" answers nothing when nothing was delivered, so
   * letting it clear the accumulator means the stop can never survive to be spoken — prod 2026-09-01:
   * recommend_stop armed at 08:37:39, the owner heard nothing about it, and "继续" at 08:38:20 wiped it
   * (and the same pattern had repeated for days). A substantive redirect is different in kind: it
   * supplies a NEW direction, and the old episode's stall counters describe the old one, so they must
   * not be allowed to kill it — that is the case 33e12ec exists for and it keeps working.
   */
  undeliveredDoom?: boolean;
  /**
   * This turn's message is a REPLAY — a scheduled task firing the same stored prompt again, with no user
   * in the loop. Every branch below asks "how did the user respond to the stop?", and a replay is not a
   * response: nobody read the stop, nobody overrode it. Treating it as an override cleared the doom
   * accounting on every fire, so stop signals could never accumulate past one turn — prod 2026-07-21: the
   * agent itself concluded "这个模式已经走到死胡同了…同样的情况已经重复了 30+ 次", the gate fired
   * verdict=pivot, and six minutes later `doom-reset on user override ("MycoX check-in routi")` wiped it.
   * Its own correct conclusion was erased on a fixed schedule.
   */
  promptIsReplay?: boolean;
}): TurnAnchorDecision {
  const msg = input.userMessage ?? '';
  const pushesForward = VIABILITY_CONTINUE_RE.test(msg) || PUSH_FORWARD_RE.test(msg);
  const accepts = VIABILITY_ACCEPT_RE.test(msg);
  const bareAffirm = BARE_AFFIRM_RE.test(msg);
  const replay = input.promptIsReplay === true;
  // A message carrying NEW DIRECTION, as opposed to a longer way of saying "go on".
  //
  // Length was the wrong proxy: "继续下一步", "继续探索", "再试一次", "keep going", "continue please" all
  // clear four characters while telling the mechanism nothing it did not already know, and the first of
  // those is a phrase the owner actually types. Strip the vocabulary that only means "go on" and judge
  // what is LEFT.
  //
  // This is a deterministic floor over OUR OWN continuation vocabulary, not an attempt to classify
  // intent — and it is built to fail in the safe direction. Withholding a reset never loses the owner's
  // instruction: the gate keeps accumulating, delivers the stop, and any word then overrides it. The
  // opposite error is the one that costs something, because it silently erases a stop nobody ever saw.
  const residual = msg
    .replace(CONTINUATION_ONLY_RE, ' ')
    .replace(/[\s,.;:!?，。；：！？、~-]+/g, '')
    .trim();
  const substantive = !bareAffirm && residual.length >= 4;
  const doomReset =
    !replay && !accepts &&
    ((input.hadDoom && (pushesForward || substantive)) ||
      (input.undeliveredDoom === true && substantive));
  const prior = input.lastAssistantText ?? '';
  const priorPitch = prior.length > 0 && (CONTINUATION_PITCH_RE.test(prior) || OFFER_QUESTION_RE.test(prior));
  // !accepts guard: a trailing-吧 acceptance ("算了吧 / 放弃吧") must never read as "execute the proposal".
  const commit = priorPitch && pushesForward && !accepts && !replay;
  return { doomReset, commit, anchor: commit || doomReset };
}

/**
 * Cross-task hijack guard (2026-07-01): the pivot/stop actuator (which pushes a reframe/stop directive and
 * forces a regen) must only fire when THIS turn is actually about the reasoning session. Otherwise a stale,
 * never-closed deep_explore session + a globally-inflated same_root_cause (e.g. a failing scheduled-task
 * pump) trips the pivot score on an UNRELATED turn and its directive hijacks it — prod: a "删除豆瓣技能" turn
 * (forget_skill succeeded, clean reply) got pivoted into "模型选型推理当前状态…".
 *
 * Relevant iff: no active session (a session-less doom-grind keeps its existing behavior), OR the turn ran
 * deep_explore (the session IS this turn's subject), OR the draft reply pitches to continue the session
 * (the exact "要我继续吗" pitch the gate exists to intercept). A clean unrelated task-completion reply with a
 * stale background session is none of these → the actuator has nothing to actuate.
 */
export function viabilityActuatorRelevant(input: {
  hasActiveSession: boolean;
  turnEngagedReasoning: boolean;
  replyPitchesContinuation: boolean;
  /**
   * The turn OBSERVED the session — a deep_explore status/list call. Not progress (that is
   * `turnEngagedReasoning`, which only advancing actions satisfy), but proof that this turn is ABOUT
   * this session, which is the only question the hijack guard is asking.
   *
   * Without it the guard was starving the stop. Prod 2026-09-01: three consecutive turns worked on the
   * session — read its Lean files, called `deep_explore status` — and each logged
   * `verdict=pivot score=3 SKIPPED … unrelated task`, so a pivot the gate had already decided on was
   * never delivered on any of them. The turn it was written to protect (a "删除豆瓣技能" reply with a
   * stale background session) touches deep_explore not at all, and is still protected.
   */
  turnObservedReasoning?: boolean;
}): boolean {
  return (
    !input.hasActiveSession ||
    input.turnEngagedReasoning ||
    input.turnObservedReasoning === true ||
    input.replyPitchesContinuation
  );
}

/**
 * Tree-backed stop evidence that survives a process restart.
 *
 * Counted EPISODE-RELATIVE, and deliberately not from `status`. A session's status is sticky — the
 * round loop only ever writes a non-'active' value (`if (status !== 'active') setSessionStatus(...)`),
 * so a tree that was once 'stuck' reports 'stuck' forever. Feeding that here makes `hadDoom` true on
 * every subsequent turn, and `hadDoom` is what licenses a doom-reset: every routine "继续" would then
 * re-baseline the very counters this gate needs to accumulate, and the stop could only ever fire from
 * evidence gathered inside a single message. The stop's own inputs must not decide when to clear the
 * stop's own inputs.
 *
 * After a restart there is no persisted baseline, so the caller's episode-relative numbers ARE the
 * lifetime ones — which is exactly the case this was written for: the owner's explicit redirect can
 * still open a fresh episode instead of being killed by yesterday's totals.
 */
export function reasoningStateCarriesDoom(input: {
  noProgressRounds?: number;
  deadEndCount?: number;
}): boolean {
  return (input.noProgressRounds ?? 0) >= STUCK_ROUNDS ||
    (input.deadEndCount ?? 0) >= DEAD_END_INTRACTABLE_THRESHOLD;
}

/**
 * Did this turn OBSERVE the owner's current reasoning session? — the hijack guard's actual question.
 *
 * Narrower than "called deep_explore at all": `list` enumerates every open session and says nothing
 * about which one the turn is on, and a status/continue naming a DIFFERENT session is a turn about that
 * other session. Both would let the pivot directive take over a reply it has no business in — the very
 * thing the guard exists to prevent.
 *
 * The tool accepts an id PREFIX (as printed by action=list), so the comparison is prefix-wise.
 */
export function isDeepExploreSessionRecord(
  record: { toolName: string; toolInput?: Record<string, unknown> },
  focusedSessionId: string | null | undefined,
): boolean {
  if (record.toolName !== 'deep_explore') return false;
  const action = String(record.toolInput?.action ?? '');
  if (!action || action === 'list') return false;
  const named = String(record.toolInput?.sessionId ?? '').trim();
  if (!named) return true; // no id given → the tool resolves it to the focused session
  return !!focusedSessionId && focusedSessionId.startsWith(named);
}

/** list/status only observe a tree; they must not make viability think this turn advanced it. */
export function isDeepExploreAdvanceRecord(record: {
  toolName: string;
  toolInput?: Record<string, unknown>;
}): boolean {
  if (record.toolName !== 'deep_explore') return false;
  const action = String(record.toolInput?.action ?? '');
  return action === 'start' || action === 'continue' || action === 'discover';
}

/**
 * Pure verdict computation. Weighted multi-signal accumulation (not a single trip-wire) so a single
 * noisy sensor never stops a task: stop needs the score from ≥2 independent sensor families. Any genuine
 * progress this turn zeroes the score (absolute veto). A goal that IS a known open problem, once stuck,
 * overrides to 'intractable' regardless of score — there is no honest path to offer.
 */
export function computeViability(input: ViabilityInput): ViabilityResult {
  // Progress veto (absolute): a round that genuinely advanced the tree this turn is never a stop.
  if (input.madeProgressThisTurn) {
    return { verdict: 'continue', score: 0, reasons: ['progress_this_turn'], evidence: '' };
  }

  let score = 0;
  const reasons: string[] = [];

  // same_root_cause is a GLOBAL action-ledger signal (independent of any deep_explore session), so it works
  // even when the doom-loop has moved into raw shell/patch/writeFile grinding outside deep_explore. Weight it
  // by MAGNITUDE: a runaway count (the prod log hit 8–9) is a strong standalone stop signal, not a flat +2.
  if (input.sameRootCause >= 9) {
    score += 4;
    reasons.push('same_root_cause_severe');
  } else if (input.sameRootCause >= 6) {
    score += 3;
    reasons.push('same_root_cause_high');
  } else if (input.sameRootCause >= 3) {
    score += 2;
    reasons.push('same_root_cause');
  }
  if (input.recommendStop) {
    score += 3;
    reasons.push('reflection_recommend_stop');
  }

  if (input.hasActiveSession) {
    if (input.barrierApplies && input.noProgressRounds >= STUCK_ROUNDS) {
      score += 3;
      reasons.push('barrier_applies_and_stalled');
    }
    if (input.status === 'stuck' && input.provedCount === 0) {
      score += 3;
      reasons.push('frontier_empty_no_proof');
    }
    if (input.noProgressRounds >= STUCK_ROUNDS) {
      score += 1;
      reasons.push('no_progress_rounds');
    }
    if (input.turnCount >= 15 && input.provedCount === 0) {
      score += 1;
      reasons.push('long_barren');
    }
  } else if (input.turnCount >= 20) {
    // Session-less path: only the global same_root_cause (above) + a very long, churny history count.
    score += 1;
    reasons.push('long_barren');
  }

  // INTRACTABLE override: the goal itself is a known open problem AND we're genuinely stuck on it. There is
  // no try-able path (the "circumventions" are themselves unsolved research), so this is a categorical no-go,
  // not a pivot. Requires real stuckness so a session making sub-lemma progress on a hard target isn't killed.
  const reallyStuck =
    input.status === 'stuck' ||
    input.noProgressRounds >= STUCK_ROUNDS ||
    (input.turnCount >= 15 && input.provedCount === 0);
  // A self-derived wall: the agent itself has recorded many dead-ends / refutations on the goal and is
  // stuck. This generalizes intractable to goals with NO curated barrier match — the agent proving its own
  // no-go (Goldbach: "additive splitting can't separate primes from semiprimes") should stop the treadmill
  // just as a parity-barrier match would. Conservative: requires real stuckness, so a session backtracking
  // its way toward a proof (dead-ends + ongoing progress) is not killed.
  const selfDerivedWall = (input.deadEndCount ?? 0) >= DEAD_END_INTRACTABLE_THRESHOLD && reallyStuck;
  if ((input.goalIsOpenProblem || selfDerivedWall) && reallyStuck) {
    reasons.push(input.goalIsOpenProblem ? 'goal_is_open_problem' : 'self_derived_no_go');
    const name = input.barrierTitle ? input.barrierTitle.replace(/\s*[—–-].*$/, '').trim() : 'this goal';
    return {
      verdict: 'intractable',
      score: Math.max(score, STOP_SCORE),
      reasons,
      evidence: input.goalIsOpenProblem
        ? `${name} is a known OPEN problem; the remaining directions are themselves unsolved research, not paths we can try here`
        : `the reasoning has recorded ${input.deadEndCount} dead-end(s) on this goal and is not advancing — the tried class of approaches is exhausted; this is out of reach for the current attack`,
      // No recommendedReframe — intractable must not hand the user a "try this" path.
    };
  }

  let verdict: ViabilityVerdict =
    score >= STOP_SCORE ? 'stop_and_report' : score >= PIVOT_SCORE ? 'pivot' : 'continue';

  // RATCHET: the gate has recommended pivot for several turns running and nothing improved. That repeated
  // self-reported stalling IS de-facto intractable, even for a goal with no curated barrier — escalate to stop
  // so the loop doesn't pivot forever on the untracked long tail.
  if (verdict === 'pivot' && input.repeatedPivotCount >= RATCHET_PIVOTS) {
    verdict = 'stop_and_report';
    reasons.push('repeated_pivot_ratchet');
  }

  // EPISODE-ATTEMPT FLOOR (2026-06-17): a generic stop_and_report on an active session that has not
  // actually attempted this direction yet (settled < MIN_EPISODE_ATTEMPTS) is a phantom wall — it's the
  // global same_root_cause / stale recommend_stop bleeding over from a PREVIOUS, now-redirected direction.
  // Downgrade to `continue` so the agent RUNS the new direction instead of declaring it dead unseen. The
  // intractable verdict already returned above (open-problem goals are out of reach regardless of attempts).
  if (
    verdict === 'stop_and_report' &&
    input.hasActiveSession &&
    input.attemptsThisEpisode < MIN_EPISODE_ATTEMPTS
  ) {
    reasons.push('insufficient_episode_attempts');
    return {
      verdict: 'continue',
      score,
      reasons,
      evidence: '',
    };
  }

  const evidence =
    verdict === 'continue'
      ? ''
      : reasons.includes('repeated_pivot_ratchet')
        ? `recommended pivoting ${input.repeatedPivotCount + 1} turns running with no improvement — this approach is de-facto exhausted`
      : input.barrierApplies && input.barrierTitle
        ? `blocked by a known barrier (${input.barrierTitle}); ${input.noProgressRounds} round(s) without progress`
        : input.status === 'stuck'
          ? `frontier exhausted (0 proved, ${input.openFrontierCount} open) after ${input.noProgressRounds} stalled round(s)`
          : input.sameRootCause >= 3
            ? `the same failure has recurred ${input.sameRootCause}× — repeatedly hitting the same wall`
            : `${input.noProgressRounds} stalled round(s)`;

  return {
    verdict,
    score,
    reasons,
    evidence,
    recommendedReframe: input.barrierCircumvention,
  };
}

/**
 * Builds the intra-turn regen directive. Two shapes:
 *  - intractable: state the categorical truth, offer NO try-able path, and do NOT invite "继续" — the only
 *    legitimate continuation is a genuinely NEW idea from the user, not a menu of research-grade dead ends.
 *  - pivot/stop: forbid the continuation pitch, present stop/reframe as the recommendation. Counsel, not a wall.
 */
export function buildViabilityDirective(
  result: ViabilityResult,
  ctx: {
    provedCount: number;
    openProblemNote?: string;
    /**
     * The deep_explore session this verdict is about, or null when there is none. The actuator
     * deliberately still fires without one (`viabilityActuatorRelevant`: a session-less doom-grind keeps
     * its behaviour) — but the wording below assumed one existed, and told the model to "summarize the
     * proved lemmas that persist in the tree" on turns that had no tree.
     *
     * Prod 2026-07-22: a `system:scheduled:mycox-checkin` turn hit stop_and_report with hasSession=false
     * and provedCount=0, and the model — asked to credit banked lemmas for "the active reasoning goal" —
     * went looking in its memory for something that fit and reported on Goldbach CRT residue-class
     * coverage instead. The check-in's own owner-facing reply was about an unrelated conjecture. Nothing
     * was wrong with the verdict; the directive simply described a different kind of work than the one
     * being done. (It became reachable only once the pivot ratchet stopped being cleared every fire.)
     */
    hasReasoningSession: boolean;
    /** What this turn is actually about, so a session-less rewrite anchors on the real subject. */
    taskHint?: string;
  },
): string {
  if (result.verdict === 'intractable') {
    const lines = [
      `[drive Viability/${result.reasons.join(',')}] STOP offering paths. ${result.evidence}.`,
      '',
      '**This goal is categorically out of reach in this setting — do NOT treat it like a solvable problem with a blocked sub-step.**',
      ctx.openProblemNote
        ? `The only known directions (${ctx.openProblemNote}) are THEMSELVES unsolved research problems — name them only to explain why there is no path, NEVER as something to "try".`
        : 'Any remaining "directions" are themselves unsolved research — not things we can try out in this session.',
      '',
      '**Rewrite the final reply (keep `## For User` / `## Work Log`) so it:**',
      '  1. States the categorical truth plainly: this is a known open problem; we will not solve it here. No hedging, no "but we could try…".',
      `  2. Credits what we BANKED — ${ctx.provedCount} proved lemma(s) + any real artifacts (surveys, partial results) persist and are reusable. Be honest: "compiled" ≠ "correct/novel".`,
      '  3. RECOMMENDS stopping this goal entirely.',
      '  4. **Forbidden**: do NOT list approaches to try; do NOT pitch "要我继续吗"; do NOT end with "reply 继续 to keep probing". The ONLY opening you may leave is: "if you have a genuinely new idea, tell me — otherwise there is nothing productive to continue here."',
      '',
      INTERNAL_CORRECTION_FOOTER,
    ];
    return lines.join('\n');
  }

  const stopping = result.verdict === 'stop_and_report';
  // The subject line and the "what we banked" credit are the two places the old wording assumed a
  // reasoning tree. Both now follow whether one actually exists.
  const subject = ctx.hasReasoningSession
    ? 'The active reasoning goal is not advancing'
    : ctx.taskHint
      ? `This task ("${ctx.taskHint}") is not advancing`
      : 'This task is not advancing';
  const banked = ctx.hasReasoningSession
    ? `  2. Credits what we BANKED — ${ctx.provedCount} proved lemma(s) persist in the tree and are reusable by a future attack; summarize them.`
    : `  2. Credits what this run DID achieve — name only what THIS turn's tools actually returned. If that is ` +
      `nothing beyond confirming the same unchanged state, say exactly that. Do NOT reach into memory for a ` +
      `different piece of work to report on: the subject is the task above and nothing else.`;
  const lines = [
    `[drive Viability/${result.reasons.join(',')}] ${subject}: ${result.evidence}.`,
    '',
    '**Do NOT pitch "要我继续吗 / shall I continue?" as if progress were normal.** The sensors say this path is',
    stopping ? 'exhausted via the current method.' : 'stalling.',
    '',
    '**Rewrite the final reply (keep the two-section `## For User` / `## Work Log` format) so it:**',
    `  1. States the no-go HONESTLY and concretely: ${result.evidence}.`,
    banked,
    result.recommendedReframe
      ? `  3. RECOMMENDS the concrete reframe (a genuinely DIFFERENT method, not the same wall): ${result.recommendedReframe}.`
      : `  3. RECOMMENDS changing the framework / goal rather than grinding the same wall.`,
    stopping
      ? `  4. Makes stopping/reframing the RECOMMENDATION, not a question. End with: "I recommend we stop here / reframe — reply 继续 only if you want me to keep probing despite the wall."`
      : `  4. Offers the pivot as the recommended next step; the user may still steer.`,
    '',
    '**You are a trusted advisor, not a warden** — never refuse the user. This rewrite changes your RECOMMENDATION, not their option.',
    '',
    INTERNAL_CORRECTION_FOOTER,
  ];
  return lines.join('\n');
}
