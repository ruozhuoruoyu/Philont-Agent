/**
 * Drives→Goals + trait-tuned contracts (S4) — pure mappings. See `docs/design/drives_to_goals.md`.
 *
 * The personality × loop integration: intrinsic traits (好胜/好奇/尽责) tune a goal-loop's contract, and a
 * SUSTAINED drive fire is promoted to a committed goal-loop (vs a one-shot lookup). Pure + dependency-free
 * (mirrors goal_loop.ts / phase_gate.ts). P0 = the mappings; deriving a TraitProfile from the actual
 * drive_config / driveBounds, and wiring promotion into the drivers, is P1.
 */
import { DEFAULT_LOOP_CONTRACT, type LoopContract } from './goal_loop.js';

/** Personality intensities, 0..1 — the abstraction the contract reads (derived from drives in P1). */
export interface TraitProfile {
  /** 好胜 = TaskCommitmentDrive — persistence before giving up. */
  competitiveness: number;
  /** 好奇 = CuriosityDrive — breadth / readiness to commit to a theme. */
  curiosity: number;
  /** 尽责 ≈ commitment_pressure — leave-nothing-hanging / report loudness. */
  conscientiousness: number;
}

export const DEFAULT_TRAITS: TraitProfile = { competitiveness: 0.5, curiosity: 0.5, conscientiousness: 0.5 };

const clamp01 = (x: number): number => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

/** Normalized 0..1 drive intensities the server can read off the real drive_config / driveBounds. */
export interface DriveSignals {
  /** TaskCommitmentDrive intensity → 好胜. */
  competitiveness?: number;
  /** CuriosityDrive intensity → 好奇. */
  curiosity?: number;
  /** commitment_pressure → 尽责. */
  conscientiousness?: number;
}

/**
 * Derive a TraitProfile from real drive intensities (S4 (a)). A missing signal falls back to the neutral
 * default, so a partially-configured agent still gets a sensible profile. Pure; the server feeds it the
 * actual drive_config values, the drivers consume the result.
 */
export function deriveTraitProfile(signals: DriveSignals = {}): TraitProfile {
  return {
    competitiveness: clamp01(signals.competitiveness ?? DEFAULT_TRAITS.competitiveness),
    curiosity: clamp01(signals.curiosity ?? DEFAULT_TRAITS.curiosity),
    conscientiousness: clamp01(signals.conscientiousness ?? DEFAULT_TRAITS.conscientiousness),
  };
}

/**
 * Map a trait profile onto a loop contract. Traits TUNE, never override, the spine:
 *   - 好胜 → more rounds + a higher stuck threshold (try harder before declaring stuck), but stuckAfter
 *     stays > switchAfter so switch-engine still fires first.
 *   - 尽责 → louder REPORT ('milestone' when conscientious, else 'stuck-only').
 *   - 好奇 → affects goal GENERATION (shouldPromoteToGoal), not the per-loop contract; left as-is here.
 */
export function traitTunedContract(traits: TraitProfile, base: LoopContract = DEFAULT_LOOP_CONTRACT): LoopContract {
  const comp = clamp01(traits.competitiveness);
  const consc = clamp01(traits.conscientiousness);
  const baseRounds = base.budget.rounds ?? 20;
  return {
    ...base,
    budget: { ...base.budget, rounds: Math.max(1, Math.round(baseRounds * (0.6 + comp))) }, // ~0.6×..1.6×
    stuckAfter: Math.max(base.switchAfter + 1, Math.round(base.stuckAfter + comp * 2)), // 好胜: 3..5, always > switchAfter
    reportEvery: consc >= 0.5 ? 'milestone' : 'stuck-only',
  };
}

/** An intrinsic drive fire considered for promotion to a goal-loop. */
export interface DriveFire {
  /** 0..1 importance/stake of the theme. */
  stake: number;
  /** how many times this theme has recurred (CuriosityDriver's token-gap recurrence). */
  recurrence: number;
  /** a hard OPEN question (a goal) vs a single fact to look up. */
  openEnded: boolean;
}

/**
 * Whether a drive fire is worth committing as a goal-loop vs handling as a one-shot research initiative.
 * Promote only sustained, high-stake, open-ended interest (the constitution's "don't detach into
 * busywork" guardrail). 好奇 lowers the recurrence bar — a curious agent commits to a theme sooner.
 */
export function shouldPromoteToGoal(
  fire: DriveFire,
  traits: TraitProfile = DEFAULT_TRAITS,
  cfg: { minStake: number; minRecurrence: number } = { minStake: 0.6, minRecurrence: 3 },
): boolean {
  if (!fire.openEnded) return false; // a single lookup is never a goal-loop
  const minRecurrence = Math.max(1, Math.round(cfg.minRecurrence - clamp01(traits.curiosity) * 2));
  return fire.stake >= cfg.minStake && fire.recurrence >= minRecurrence;
}
