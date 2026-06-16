/**
 * Phase 18 (2026-06-15) ViabilityGate — the missing ACTUATOR.
 *
 * Problem it solves: philont already had all the SENSORS for "this goal is doomed" — grounding
 * [barrier] cards / matchBarriers, deep_explore noProgressRounds (Tooth-B strict progress),
 * reflection same_root_cause — but every one of them only NARRATED to the user or injected a soft
 * hint for a FUTURE turn. None could change the action of the CURRENT turn. The recurring
 * enthusiastic "要我继续吗 / shall I continue?" next-action pitch was pure LLM text under no gate,
 * hardwired after narration regardless of what the sensors said. knowing and acting were decoupled.
 *
 * This gate reads the existing sensors for the owner-scoped active reasoning session and converts
 * red signals into a verdict (continue | pivot | stop_and_report). The chat-handler turns a
 * pivot/stop verdict into one regen that forbids the continuation-pitch and presents stop/reframe
 * as the RECOMMENDED option (counsel, not a wall — the user can always reply "继续").
 *
 * Design: pure + dependency-free so it unit-tests trivially. The caller (chat-handler) gathers the
 * raw materials (barrier match, session summary, same-root-cause count) and passes primitives in.
 *
 * Tunables (env, mirroring PHILONT_*_GATE convention):
 *   PHILONT_VIABILITY_GATE=0          disable entirely
 *   PHILONT_VIABILITY_STOP_SCORE=4    score ≥ this → stop_and_report
 *   PHILONT_VIABILITY_PIVOT_SCORE=2   score ≥ this → pivot
 *   PHILONT_VIABILITY_STUCK_ROUNDS=3  noProgressRounds threshold (mirrors deep_explore STUCK_ESCALATE_AFTER)
 */

export type ViabilityVerdict = 'continue' | 'pivot' | 'stop_and_report';

export interface ViabilityInput {
  /** Whether an owner-scoped active reasoning session exists. Gate is inert (continue) without one. */
  hasActiveSession: boolean;
  /** A matched barrier whose blocked METHOD was detected (severity 'applies'), not merely a hard goal. */
  barrierApplies: boolean;
  /** Title of the first applied barrier, for the honest no-go directive (optional). */
  barrierTitle?: string;
  /** Curated circumvention of the first applied barrier, surfaced as the recommended reframe (optional). */
  barrierCircumvention?: string;
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
}

export interface ViabilityResult {
  verdict: ViabilityVerdict;
  score: number;
  reasons: string[];
  /** Short human-readable no-go summary for the regen directive + log line. */
  evidence: string;
  /** The recommended reframe to surface to the user (barrier circumvention when available). */
  recommendedReframe?: string;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * Detects a "shall I continue?" continuation pitch in drafted text. Used after the regen to confirm
 * the model dropped the pitch; if it didn't and the verdict was stop, the caller deterministically
 * downgrades the outcome. Deliberately matches the QUESTION form ("要我继续吗 / shall I continue"),
 * not the bare word 继续 (which legitimately appears in "reply 继续 to keep going").
 */
export const CONTINUATION_PITCH_RE =
  /要(?:我|不要)?[^。\n？?]{0,14}(?:继续|推进|深入|开始|开攻|往下)[^。\n？?]{0,6}(?:[吗嘛]\s*[?？]?|[?？])|是否(?:要|需要|继续|推进)|要不要(?:我)?[^。\n？?]{0,10}(?:继续|推进|深入|开)|继续(?:推进|攻|探|深入)?\s*[?？]|shall I (?:continue|proceed|keep going|go on)|want me to (?:continue|keep|proceed|go on)|should I (?:continue|keep|proceed|go on)/i;

/**
 * WS2: the user EXPLICITLY accepts stopping / reframing (after a stop_and_report was recommended).
 * Only then is the reasoning session abandoned — counsel-only, we never abandon on ambiguity.
 */
export const VIABILITY_ACCEPT_RE =
  /算了|不弄了|不做了|不搞了|放弃|换(?:个|一个|条)?(?:框架|方向|方法|思路|题|问题|路)|到此为止|先停|停(?:下|吧|了)|结束(?:吧|了)?|收(?:工|尾)|good enough|give up|let'?s stop|abandon|move on/i;

/** WS2: the user wants to keep going despite the wall — overrides acceptance, keeps the session active. */
export const VIABILITY_CONTINUE_RE = /继续|接着|再(?:试|跑|来|攻|想)|go on|keep going|continue|顶(?:着|上)|硬(?:上|刚)/i;

/**
 * Pure verdict computation. Weighted multi-signal accumulation (not a single trip-wire) so a single
 * noisy sensor never stops a task: stop_and_report needs the score from ≥2 independent sensor families.
 * Any genuine progress this turn zeroes the score (absolute veto).
 */
export function computeViability(input: ViabilityInput): ViabilityResult {
  const STOP = envInt('PHILONT_VIABILITY_STOP_SCORE', 4);
  const PIVOT = envInt('PHILONT_VIABILITY_PIVOT_SCORE', 2);
  const STUCK = envInt('PHILONT_VIABILITY_STUCK_ROUNDS', 3);

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
  // WS4: reflection's persisted recommend_stop — strong cross-turn judgment.
  if (input.recommendStop) {
    score += 3;
    reasons.push('reflection_recommend_stop');
  }

  if (input.hasActiveSession) {
    // HARD no-go: the blocked method is detected AND the frontier is stalled. A barrier ALONE is not
    // enough (the goal could legitimately route around it); barrier + stall = doomed via this method.
    if (input.barrierApplies && input.noProgressRounds >= STUCK) {
      score += 3;
      reasons.push('barrier_applies_and_stalled');
    }
    // Empty frontier with nothing proved = genuinely stuck (judgeConvergence already says 'stuck').
    if (input.status === 'stuck' && input.provedCount === 0) {
      score += 3;
      reasons.push('frontier_empty_no_proof');
    }
    // Persistent no-progress beyond the escalate threshold (Tooth-B strict counter).
    if (input.noProgressRounds >= STUCK) {
      score += 1;
      reasons.push('no_progress_rounds');
    }
    // Long task accumulating zero proved nodes (churn without yield).
    if (input.turnCount >= 15 && input.provedCount === 0) {
      score += 1;
      reasons.push('long_barren');
    }
  } else {
    // Session-less path: no deep_explore session to read stall/barrier from, so the only signals are the
    // global same_root_cause (above) and a very long, churny turn history. Keeps false positives near zero —
    // without a real repeated-failure signal the score stays 0 → continue.
    if (input.turnCount >= 20) {
      score += 1;
      reasons.push('long_barren');
    }
  }

  // Progress veto (absolute): a round that genuinely advanced the tree this turn cannot be a stop.
  if (input.madeProgressThisTurn) {
    return {
      verdict: 'continue',
      score: 0,
      reasons: ['progress_this_turn'],
      evidence: '',
    };
  }

  const verdict: ViabilityVerdict =
    score >= STOP ? 'stop_and_report' : score >= PIVOT ? 'pivot' : 'continue';

  const evidence =
    verdict === 'continue'
      ? ''
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
 * Builds the intra-turn regen directive injected when the verdict is pivot/stop. It forbids the
 * continuation pitch and forces the draft to present stop/reframe as the recommendation while
 * crediting what was already established — counsel, never a hard block on the user.
 */
export function buildViabilityDirective(result: ViabilityResult, ctx: { provedCount: number }): string {
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
      ? `  3. RECOMMENDS the concrete reframe: ${result.recommendedReframe}.`
      : `  3. RECOMMENDS changing the framework / goal rather than grinding the same wall.`,
    stopping
      ? `  4. Makes stopping/reframing the RECOMMENDATION, not a question. End with: "I recommend we stop here / reframe — reply 继续 only if you want me to keep probing despite the wall."`
      : `  4. Offers the pivot as the recommended next step; the user may still steer.`,
    '',
    '**You are a trusted advisor, not a warden** — never refuse the user. If they reply 继续, you will run another round. This rewrite changes your RECOMMENDATION, not their option.',
    '',
    'This is an intra-turn internal correction. Do not surface this reminder to the user.',
  ];
  return lines.join('\n');
}
