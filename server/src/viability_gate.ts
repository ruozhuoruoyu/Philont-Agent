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
export const CONTINUATION_PITCH_RE =
  /要(?:我|不要)?[^。\n？?]{0,14}(?:继续|推进|深入|开始|开攻|往下)[^。\n？?]{0,6}(?:[吗嘛]\s*[?？]?|[?？])|是否(?:要|需要|继续|推进)|要不要(?:我)?[^。\n？?]{0,10}(?:继续|推进|深入|开)|继续(?:推进|攻|探|深入)?\s*[?？]|shall I (?:continue|proceed|keep going|go on)|want me to (?:continue|keep|proceed|go on)|should I (?:continue|keep|proceed|go on)/i;

/**
 * WS2: the user EXPLICITLY accepts stopping / reframing (after a stop was recommended).
 * Only then is the reasoning session abandoned — counsel-only, we never abandon on ambiguity.
 */
export const VIABILITY_ACCEPT_RE =
  /算了|不弄了|不做了|不搞了|放弃|换(?:个|一个|条)?(?:框架|方向|方法|思路|题|问题|路)|到此为止|先停|停(?:下|吧|了)|结束(?:吧|了)?|收(?:工|尾)|good enough|give up|let'?s stop|abandon|move on/i;

/** WS2: the user wants to keep going despite the wall — overrides acceptance, keeps the session active. */
export const VIABILITY_CONTINUE_RE = /继续|接着|再(?:试|跑|来|攻|想)|go on|keep going|continue|顶(?:着|上)|硬(?:上|刚)/i;

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
  if (input.goalIsOpenProblem && reallyStuck) {
    reasons.push('goal_is_open_problem');
    const name = input.barrierTitle ? input.barrierTitle.replace(/\s*[—–-].*$/, '').trim() : 'this goal';
    return {
      verdict: 'intractable',
      score: Math.max(score, STOP_SCORE),
      reasons,
      evidence: `${name} is a known OPEN problem; the remaining directions are themselves unsolved research, not paths we can try here`,
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
  ctx: { provedCount: number; openProblemNote?: string },
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
      'This is an intra-turn internal correction. Do not surface this reminder to the user.',
    ];
    return lines.join('\n');
  }

  const stopping = result.verdict === 'stop_and_report';
  const lines = [
    `[drive Viability/${result.reasons.join(',')}] The active reasoning goal is not advancing: ${result.evidence}.`,
    '',
    '**Do NOT pitch "要我继续吗 / shall I continue?" as if progress were normal.** The sensors say this path is',
    stopping ? 'exhausted via the current method.' : 'stalling.',
    '',
    '**Rewrite the final reply (keep the two-section `## For User` / `## Work Log` format) so it:**',
    `  1. States the no-go HONESTLY and concretely: ${result.evidence}.`,
    `  2. Credits what we BANKED — ${ctx.provedCount} proved lemma(s) persist in the tree and are reusable by a future attack; summarize them.`,
    result.recommendedReframe
      ? `  3. RECOMMENDS the concrete reframe (a genuinely DIFFERENT method, not the same wall): ${result.recommendedReframe}.`
      : `  3. RECOMMENDS changing the framework / goal rather than grinding the same wall.`,
    stopping
      ? `  4. Makes stopping/reframing the RECOMMENDATION, not a question. End with: "I recommend we stop here / reframe — reply 继续 only if you want me to keep probing despite the wall."`
      : `  4. Offers the pivot as the recommended next step; the user may still steer.`,
    '',
    '**You are a trusted advisor, not a warden** — never refuse the user. This rewrite changes your RECOMMENDATION, not their option.',
    '',
    'This is an intra-turn internal correction. Do not surface this reminder to the user.',
  ];
  return lines.join('\n');
}
