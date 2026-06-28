/**
 * Background auto-advance for deep_explore (opt-in per session, default-off globally).
 *
 * When a reasoning session is opted in (deep_explore action=auto_on → reasoning_sessions.auto_advance=1)
 * AND the server flag PHILONT_DEEP_EXPLORE_AUTO_ADVANCE is on, this loop advances that session one round
 * at a time on its own — no user typing "继续" — and proactively reports progress. It stops a session's
 * auto-advance when the session is solved/closed or has been stuck for too long (cross-round
 * no_progress_rounds counter), escalating to the user instead of grinding forever.
 *
 * Rounds run sequentially (a `running` guard + a recursive timer), so there is no overlap and a single
 * 15-min background round never stacks. The round runs inside a `system:auto-advance:<id>` ALS context
 * so effectiveRoundDeadlineMs() picks the longer background cap. The round is invoked directly via
 * advanceSession (not the tool dispatch), so it does not go through the interactive auth gate — the
 * per-session opt-in IS the authorization.
 */
import type { ReasoningStore, ReasoningSession } from '@agent/memory';
import type { ToolResult } from '@agent/policy';
import { scoreTrajectory, DEFAULT_LOOP_CONTRACT, type TickOutcome } from '@agent/memory';

/**
 * Per-loop ROUNDS budget (S2 consent model): pause + ask after this many advanced rounds — a cost
 * checkpoint, NOT a silent kill (the user re-commits to add another batch). The real $ ceiling is the
 * per-session token budget (PHILONT_DEEP_EXPLORE_TOKEN_BUDGET, default 300k, enforced via budget_spent).
 */
const MAX_ROUNDS = (() => {
  const n = Number(process.env.PHILONT_GOAL_LOOP_MAX_ROUNDS);
  return Number.isInteger(n) && n >= 1 ? n : 20;
})();

/** Stuck threshold (consecutive no-progress rounds → escalate). Overrides scoreTrajectory's stuckAfter. */
const STUCK_STOP = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_AUTO_STUCK_STOP);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LOOP_CONTRACT.stuckAfter;
})();

/**
 * Global gate. DEFAULT ON: the real gate is the per-session commit (auto_advance=1 via deep_explore
 * auto_on) — listAutoAdvanceSessions only returns committed sessions, so nothing runs until the user (or
 * an approved drive) commits a session. PHILONT_DEEP_EXPLORE_AUTO_ADVANCE=0/off/false/no disables the
 * whole driver.
 */
export function autoAdvanceEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export interface AutoAdvanceDeps {
  reasoning: ReasoningStore;
  /** Advance a specific session by one round (deep_explore's advanceSession). */
  advanceSession: (session: ReasoningSession) => Promise<ToolResult>;
  /** Wrap the round in a turn ALS context (server's runInTurnContext) so it gets the background cap. */
  runInContext: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;
  /** Proactively notify the user. `important` events (stuck/solved) also push to messaging channels. */
  notify: (text: string, opts?: { important?: boolean }) => void;
  /** ms between ticks. Rounds run sequentially regardless; this is the idle poll cadence. Default 30s. */
  intervalMs?: number;
}

export interface AutoAdvanceLoop {
  start: () => void;
  stop: () => void;
  /** Exposed for tests: run one tick synchronously. */
  tickOnce: () => Promise<void>;
}

export function createAutoAdvanceLoop(deps: AutoAdvanceDeps): AutoAdvanceLoop {
  const intervalMs = deps.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;
  /** Rounds this driver has advanced per session (in-memory budget counter; resets on restart). */
  const roundsAdvanced = new Map<string, number>();
  /** S3 contract — DEFAULT_LOOP_CONTRACT with stuckAfter overridden by the env STUCK_STOP. */
  const contract = { ...DEFAULT_LOOP_CONTRACT, stuckAfter: STUCK_STOP };

  async function tickOnce(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      if (!autoAdvanceEnabled()) return;
      const sessions = deps.reasoning.listAutoAdvanceSessions();
      for (const s of sessions) {
        if (stopped) break;

        // 1. Per-loop ROUNDS budget — pause + ask (cost checkpoint, not a silent kill).
        const rounds = roundsAdvanced.get(s.id) ?? 0;
        if (rounds >= MAX_ROUNDS) {
          deps.reasoning.setAutoAdvance(s.id, false);
          roundsAdvanced.delete(s.id);
          deps.notify(
            `⏸ 自动推进已暂停:"${s.goal.slice(0, 50)}" 跑满 ${MAX_ROUNDS} 轮预算。回复"自动推进"再加一批,或"停"。`,
            { important: true },
          );
          continue;
        }

        // 2. Direction (S3): decide BEFORE spending another round. The session's noProgressRounds IS the
        //    trailing flat-tick run → scoreTrajectory turns it into continue / switch_engine / escalate.
        const flatHist: TickOutcome[] = Array.from({ length: s.noProgressRounds }, () => ({
          progress: 0,
          bodyKind: 'deep_explore' as const,
        }));
        const decision = scoreTrajectory(flatHist, contract).decision;
        if (decision === 'escalate' || decision === 'switch_engine') {
          deps.reasoning.setAutoAdvance(s.id, false);
          roundsAdvanced.delete(s.id);
          deps.notify(
            decision === 'switch_engine'
              ? `⏸ 自动推进已暂停:"${s.goal.slice(0, 50)}" 这条路连续 ${s.noProgressRounds} 轮没产出——换个角度/模式可能更有效。回复"继续"原路推进、或换个角度、或"停"。`
              : `⏸ 自动推进已暂停:"${s.goal.slice(0, 50)}" 连续 ${s.noProgressRounds} 轮无进展(卡住)。回复"继续"手动推进,或换个角度重启。`,
            { important: true },
          );
          continue;
        }

        // 3. Advance one round in a background context (system: → longer cap, no user waiting).
        let out: ToolResult | null = null;
        try {
          out = await deps.runInContext(`system:auto-advance:${s.id}`, () => deps.advanceSession(s));
        } catch (e) {
          console.warn(`[auto-advance] round failed for ${s.id}: ${String(e).slice(0, 200)}`);
          continue;
        }
        if (stopped) break;

        const fresh = deps.reasoning.getSession(s.id);
        if (!fresh || fresh.status !== 'active') {
          // Solved / closed → stop and report.
          deps.reasoning.setAutoAdvance(s.id, false);
          roundsAdvanced.delete(s.id);
          deps.notify(
            `✅ 自动推进结束:"${s.goal.slice(0, 50)}" 状态=${fresh?.status ?? 'closed'}。\n${(out?.output ?? '').slice(0, 600)}`,
            { important: true },
          );
        } else {
          roundsAdvanced.set(s.id, rounds + 1);
          if (fresh.noProgressRounds === 0) {
            // The counter reset → this round made progress → milestone (not pushed every round).
            deps.notify(`🔬 自动推进:"${s.goal.slice(0, 40)}"\n${(out?.output ?? '').slice(0, 600)}`);
          }
          // else: no progress this round but not yet stuck → stay quiet (avoid spam).
        }
      }
    } catch (e) {
      console.warn('[auto-advance] tick error', e);
    } finally {
      running = false;
    }
  }

  // The recurring driver — separate from the pure tickOnce() so tests can run one tick without
  // leaving a pending timer that keeps the process alive.
  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tickOnce().finally(scheduleNext);
    }, intervalMs);
    timer.unref?.(); // default-on now → don't let this background timer keep the process alive
  }

  return {
    start: () => {
      if (stopped) return;
      if (!autoAdvanceEnabled()) {
        console.log('[auto-advance] disabled (PHILONT_DEEP_EXPLORE_AUTO_ADVANCE=0)');
        return;
      }
      if (timer) return;
      scheduleNext();
      console.log(
        `[auto-advance] armed, default-on (runs only sessions committed via deep_explore auto_on; ` +
          `tick=${intervalMs}ms, rounds-budget=${MAX_ROUNDS}, stuck-stop=${STUCK_STOP})`,
      );
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tickOnce,
  };
}
