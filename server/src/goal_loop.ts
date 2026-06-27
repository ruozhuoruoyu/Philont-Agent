/**
 * Goal-loop runtime types (S2) + trajectory scoring (S3) — pure, dependency-free, like phase_gate.ts /
 * viability_gate.ts. See `docs/design/goal_loop_runtime.md`.
 *
 * P0 = the contract types + the pure scoreTrajectory decision. NO driver wiring, NO persistence yet
 * (zero behavior change). S2 P1 will generalize deep_explore_autoadvance into a driver that builds a
 * GoalLoop, advances one bounded unit per tick, appends a TickOutcome, and acts on scoreTrajectory's
 * decision; S4 will trait-tune the contract.
 */

export type LoopBodyKind = 'deep_explore' | 'plan' | 'research';
export type LoopStatus = 'running' | 'paused' | 'stuck' | 'done';
export type LoopDecision = 'continue' | 'stop' | 'escalate' | 'switch_engine';

/** What one tick of a goal-loop produced — the S3 trajectory is a sequence of these. */
export interface TickOutcome {
  /** Net forward progress this tick (e.g. new proved/settled nodes + evidence − …). ≤ 0 = flat. */
  progress: number;
  /** def-of-done met this tick → the loop is done. */
  done?: boolean;
  /** which body advanced this tick (for switch-engine detection). */
  bodyKind?: LoopBodyKind;
}

/** The loop's contract — the 6-part loop-engineering contract, trait-tuned by S4. */
export interface LoopContract {
  /** TRIGGER cadence (ms): a tick advances one bounded unit. */
  cadenceMs: number;
  /** BUDGET: per-loop ceilings above the per-tick caps. */
  budget: { rounds?: number; tokens?: number };
  /** S3: consecutive flat ticks before "stuck → escalate". */
  stuckAfter: number;
  /** S3: consecutive same-body flat ticks before "switch engine" (must be ≤ stuckAfter). */
  switchAfter: number;
  /** REPORT loudness (trait-tuned: 尽责 → 'milestone', else 'stuck-only'). */
  reportEvery: 'milestone' | 'stuck-only';
}

/** A committed goal running as a loop. goalRef = a pursuit id (def-of-done = resolutionCriteria) or a
 * deep_explore session id. P0 is the shape only; persistence/driver come in P1. */
export interface GoalLoop {
  goalRef: string;
  bodyKind: LoopBodyKind;
  status: LoopStatus;
  contract: LoopContract;
  history: TickOutcome[];
}

export const DEFAULT_LOOP_CONTRACT: LoopContract = {
  cadenceMs: 30 * 60_000,
  budget: { rounds: 20 },
  stuckAfter: 3,
  switchAfter: 2,
  reportEvery: 'milestone',
};

/**
 * S3 — score a goal-loop's trajectory and decide the next meta-action. Pure.
 *
 * Decision order (most specific first), over the TRAILING run of flat (progress ≤ 0) ticks:
 *   - empty history            → continue (just started)
 *   - last tick done           → stop
 *   - last tick progressed     → continue (trailing-flat run is empty)
 *   - trailing flat ≥ stuckAfter                       → escalate (really stuck, ask the user)
 *   - trailing flat spans ≥ 2 body kinds               → escalate (already switched and STILL flat —
 *                                                          don't thrash engines)
 *   - trailing flat ≥ switchAfter (all the same body)  → switch_engine (this body isn't converging —
 *                                                          the P-vs-NP formal+pariGp-settled-0 case)
 *   - otherwise (flat but young)                       → continue (give it room)
 */
export function scoreTrajectory(
  history: ReadonlyArray<TickOutcome>,
  cfg: LoopContract = DEFAULT_LOOP_CONTRACT,
): { score: number; trend: 'progressing' | 'flat'; decision: LoopDecision } {
  const score = history.reduce((a, t) => a + t.progress, 0);
  if (history.length === 0) return { score, trend: 'flat', decision: 'continue' };

  const last = history[history.length - 1];
  if (last.done) return { score, trend: 'progressing', decision: 'stop' };

  // Trailing run of flat ticks.
  let i = history.length - 1;
  while (i >= 0 && history[i].progress <= 0) i--;
  const flatTail = history.slice(i + 1);
  const trend = flatTail.length === 0 ? 'progressing' : 'flat';

  if (flatTail.length === 0) return { score, trend, decision: 'continue' };
  if (flatTail.length >= cfg.stuckAfter) return { score, trend, decision: 'escalate' };

  const distinctBodies = new Set(flatTail.map((t) => t.bodyKind ?? '∅'));
  if (distinctBodies.size >= 2) return { score, trend, decision: 'escalate' }; // switched already, still flat
  if (flatTail.length >= cfg.switchAfter) return { score, trend, decision: 'switch_engine' };

  return { score, trend, decision: 'continue' };
}
