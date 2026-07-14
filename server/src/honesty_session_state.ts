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
  /**
   * STICKY (2026-07-14): this session has already claimed an execution/computation RESULT on a turn that
   * ran zero execution tools — i.e. it did not overstate a failure, it narrated an experiment that never
   * happened, results included.
   *
   * Prod (07-14): it did this TWICE in one session. The gate caught both, the model apologised both times,
   * and fabricated again immediately. The mechanism made that inevitable: the fabricated_execution_claim
   * branch never read this store, and the correction it pushed offered a free exit ("just tell the user you
   * haven't run it") that costs nothing, satisfies the gate, and changes no behaviour — so apologise-and-
   * move-on was the cheapest winning strategy. Meanwhile the pressure that produced the fabrication (the
   * user still wants a verified answer; nothing has been run) was untouched, so the next turn reproduced it.
   *
   * Sticky for the life of the session and NEVER cleared: it is a trust state, not a counter. It costs
   * nothing when the agent behaves — a turn that really executes never reaches the branch at all. It only
   * bites on a REPEAT fabrication, where it removes the free exit.
   */
  fabricatedExecClaim: boolean;
}

const EMPTY: HonestySessionState = {
  unkeptRunPromise: false,
  violationCount: 0,
  fabricatedExecClaim: false,
};

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
    outcome: {
      promisedRun: boolean;
      didExecute: boolean;
      fired: boolean;
      /** This turn's fire was a fabricated_execution_claim — arms the sticky latch. */
      fabricatedExec?: boolean;
    },
  ): void {
    const cur = this.get(sessionId);
    this.map.set(sessionId, {
      unkeptRunPromise: outcome.didExecute
        ? false
        : outcome.promisedRun || cur.unkeptRunPromise,
      violationCount: cur.violationCount + (outcome.fired ? 1 : 0),
      // Sticky: once armed, stays armed for the session.
      fabricatedExecClaim: cur.fabricatedExecClaim || outcome.fabricatedExec === true,
    });
  }
}

/** Process-wide singleton (mirrors the module-level per-session maps elsewhere in server/src). */
export const honestySessionStore = new HonestySessionStore();
