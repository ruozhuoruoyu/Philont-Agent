/**
 * Trait signals from lived history (WS1, docs/design/selfhood_closure.md).
 *
 * Pure helpers that turn persisted records into the 0..1 DriveSignals consumed by
 * deriveTraitProfile (drives_to_goals.ts). Kept in agent-memory so they are unit-testable
 * against the stores' shapes; the server composes them in server/src/trait_profile.ts.
 *
 * Design rule: a signal that has NO history returns undefined — deriveTraitProfile then
 * falls back to the neutral 0.5. Traits move away from neutral only on real evidence.
 */

/**
 * EWMA over drive-outcome effectiveness scores (each in [-1, 1], chronological order),
 * mapped to [0, 1]. This is the "competitiveness" signal: how effective pushing myself
 * harder has historically been (SessionDriveReflector back-fills the scores).
 * Returns undefined when there are no scored samples.
 */
export function ewma01FromScores(
  scoresChronological: readonly number[],
  alpha = 0.3,
): number | undefined {
  let ewma: number | undefined;
  for (const s of scoresChronological) {
    if (!Number.isFinite(s)) continue;
    const clamped = Math.max(-1, Math.min(1, s));
    const as01 = (clamped + 1) / 2;
    ewma = ewma === undefined ? as01 : ewma + alpha * (as01 - ewma);
  }
  return ewma;
}

/**
 * Success ratio shrunk toward 0.5 for small samples (w = n / (n + k)) — the "curiosity"
 * signal: how well my autonomous curiosity lookups have actually paid off. One lucky hit
 * must not produce a 1.0 trait, hence the shrinkage prior.
 * Returns undefined when there are no settled samples at all.
 */
export function ratioWithShrinkage(
  done: number,
  failed: number,
  k = 5,
): number | undefined {
  const d = Math.max(0, done | 0);
  const f = Math.max(0, failed | 0);
  const n = d + f;
  if (n === 0) return undefined;
  const p = d / n;
  const w = n / (n + k);
  return 0.5 * (1 - w) + p * w;
}
