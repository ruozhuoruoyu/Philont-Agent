/**
 * Per-turn wall-clock hard deadline, shared by chat-handler (the Promise.race backstop + wrap-up
 * headroom) and deep_explore (its per-round ceiling is derived from it). One module so the two can
 * never drift apart again: deep_explore used to carry a "must stay in sync" mirror literal.
 *
 * Default 20 min (the production value since 2026-05-24). Env `PHILONT_TURN_HARD_DEADLINE_MS`
 * overrides it for long-task benchmarks whose protocol grants more (HANDBOOK.md: 1 h / 200 tool
 * calls per task). Range 5 min – 6 h; anything else logs and keeps the default, like the other
 * `[config]` knobs.
 */
export const TURN_HARD_DEADLINE_DEFAULT_MS = 20 * 60_000;
export const TURN_HARD_DEADLINE_MIN_MS = 5 * 60_000;
export const TURN_HARD_DEADLINE_MAX_MS = 6 * 60 * 60_000;

export function resolveTurnHardDeadlineMs(raw: string | undefined): number {
  if (!raw) return TURN_HARD_DEADLINE_DEFAULT_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < TURN_HARD_DEADLINE_MIN_MS || n > TURN_HARD_DEADLINE_MAX_MS) {
    console.warn(
      `[config] PHILONT_TURN_HARD_DEADLINE_MS="${raw}" out of range (allowed ${TURN_HARD_DEADLINE_MIN_MS}-${TURN_HARD_DEADLINE_MAX_MS}), using default ${TURN_HARD_DEADLINE_DEFAULT_MS}`,
    );
    return TURN_HARD_DEADLINE_DEFAULT_MS;
  }
  return n;
}

export const TURN_HARD_DEADLINE_MS: number = resolveTurnHardDeadlineMs(process.env.PHILONT_TURN_HARD_DEADLINE_MS);
