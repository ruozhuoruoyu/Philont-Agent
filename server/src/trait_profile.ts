/**
 * Live trait profile (WS1, docs/design/selfhood_closure.md).
 *
 * Derives the agent's competitiveness / curiosity / conscientiousness from its own persisted
 * history instead of DEFAULT_TRAITS constants — the "experience → parameters → behavior" hop
 * that was severed (deriveTraitProfile had zero call sites; every instance had the identical,
 * immutable personality).
 *
 * Signal sources (all persisted; a source with no history yields undefined → neutral 0.5):
 *   - competitiveness ← EWMA of the task-commitment kernel drive's effectiveness scores
 *     (SessionDriveReflector back-fills them): how well pushing myself harder has worked.
 *   - curiosity ← shrunk success ratio of settled curiosity-driver initiatives (trailing 30d):
 *     how well my autonomous lookups have paid off.
 *   - conscientiousness ← neutral until WS4 lands; its self-observation aggregates (honesty
 *     conversions, commitment follow-through) are the intended source. Do not fake it earlier.
 *
 * Kill switch: PHILONT_TRAITS_LIVE=0/off/false/no → DEFAULT_TRAITS (frozen personality).
 */

import {
  DEFAULT_TRAITS,
  deriveTraitProfile,
  ewma01FromScores,
  ratioWithShrinkage,
  type DriveOutcomeStore,
  type InitiativeStore,
  type TraitProfile,
} from '@agent/memory';

/** driveId of the kernel task-commitment drive as registered in chat-handler. */
export const TASK_COMMITMENT_DRIVE_ID = 'task-commitment';

const CURIOSITY_WINDOW_MS = 30 * 86_400_000;

export function traitsLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PHILONT_TRAITS_LIVE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export interface TraitProfileDeps {
  driveOutcomes: DriveOutcomeStore;
  /** The autonomous loop's initiative store; optional because the loop starts after the drivers are built. */
  initiatives?: InitiativeStore;
}

/**
 * Compute the current trait profile from lived history. Cheap (two indexed reads); intended to
 * be called through a provider callback once per autonomous tick / goal-loop decision, never
 * cached across restarts. Falls back to DEFAULT_TRAITS on kill switch or any store error —
 * a broken trait read must never take the autonomous loop down.
 */
export function currentTraitProfile(
  deps: TraitProfileDeps,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): TraitProfile {
  if (!traitsLiveEnabled(env)) return DEFAULT_TRAITS;
  try {
    // listByDrive returns fired_at DESC; EWMA wants chronological order.
    const scores = deps.driveOutcomes
      .listByDrive(TASK_COMMITMENT_DRIVE_ID, 50)
      .reverse()
      .map((o) => o.effectivenessScore)
      .filter((s): s is number => typeof s === 'number');
    const competitiveness = ewma01FromScores(scores);

    let curiosity: number | undefined;
    if (deps.initiatives) {
      const c = deps.initiatives.countSettledByDriverSince('curiosity', now - CURIOSITY_WINDOW_MS);
      curiosity = ratioWithShrinkage(c.done, c.failed);
    }

    return deriveTraitProfile({ competitiveness, curiosity });
  } catch (e) {
    console.warn('[traits] currentTraitProfile failed, falling back to defaults', e);
    return DEFAULT_TRAITS;
  }
}
