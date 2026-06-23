/**
 * Per-session honesty state for the say-do-gap latch (2026-06-24).
 *
 * evaluateHonesty is otherwise stateless per turn. This carries two facts across the turns of a session
 * so the honesty gate can escalate REPEATED dishonesty that a single-turn view cannot see:
 *   - a repeated unkept run-promise (the prod loop: the agent said "现在跑" three turns running and never
 *     issued a tool call) escalates from a soft nudge to a hard block;
 *   - once the session has had a fabrication fire, later reminders can harden.
 *
 * In-memory, one copy per server process — mirrors InMemoryTaskModeStore. NOT persisted: defaults clean
 * after restart (this is an intra-session signal only). Kill-switch is at the caller (PHILONT_HONESTY_SESSION=0).
 */
export interface HonestySessionState {
  /** Last turn announced a run ("现在跑") but issued no execution tool — promise still unkept. */
  unkeptRunPromise: boolean;
  /** Honesty fires so far this session (drives reminder hardening). */
  violationCount: number;
}

const EMPTY: HonestySessionState = { unkeptRunPromise: false, violationCount: 0 };

export class HonestySessionStore {
  private readonly map = new Map<string, HonestySessionState>();

  get(sessionId: string): HonestySessionState {
    return this.map.get(sessionId) ?? EMPTY;
  }

  /**
   * Fold this turn's outcome into the session state.
   *   - didExecute → the latch is cleared (the agent actually ran something this turn);
   *   - else a fresh promisedRun arms the latch, and a prior unkept promise persists until executed;
   *   - fired increments the violation counter.
   */
  update(
    sessionId: string,
    outcome: { promisedRun: boolean; didExecute: boolean; fired: boolean },
  ): void {
    const cur = this.get(sessionId);
    this.map.set(sessionId, {
      unkeptRunPromise: outcome.didExecute
        ? false
        : outcome.promisedRun || cur.unkeptRunPromise,
      violationCount: cur.violationCount + (outcome.fired ? 1 : 0),
    });
  }
}

/** Process-wide singleton (mirrors the module-level per-session maps elsewhere in server/src). */
export const honestySessionStore = new HonestySessionStore();
