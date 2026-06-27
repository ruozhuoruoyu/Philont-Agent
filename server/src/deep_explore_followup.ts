/**
 * Proactive follow-up on quiet OPEN deep_explore sessions — the S2 REPORT slice
 * (`docs/design/goal_loop_runtime.md` §3.2; `motivation_loop_architecture.md`).
 *
 * The autonomous/curiosity layer is BLIND to reasoning_sessions, and a deep_explore the user stopped
 * advancing (open frontier, no "继续" for hours) just sits there — nobody continues it OR asks. This loop
 * closes that gap: it scans active reasoning sessions and, for one that still has OPEN frontier nodes and
 * has gone quiet past a silence threshold, proactively ASKS the user ONCE — the charter's "主动 / 连续".
 *
 * It deliberately does NOT run the round unsupervised (deep_explore is walled off from the background
 * whitelist by design) — it surfaces the open thread and asks; on "继续" the normal turn advances it.
 * Reuses the same notify path as deep_explore_autoadvance. Default ON;
 * PHILONT_DEEP_EXPLORE_FOLLOWUP=0/off/false/no disables. In-memory "asked" dedup (ask once per session per
 * process — re-asking once after a restart is acceptable). Silence threshold
 * PHILONT_DEEP_EXPLORE_FOLLOWUP_SILENCE_HOURS (default 6).
 */
import type { ReasoningStore } from '@agent/memory';

export function followUpEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

function silenceMsFromEnv(): number {
  const h = Number(process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP_SILENCE_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 6) * 60 * 60 * 1000;
}

export interface FollowUpCandidate {
  id: string;
  goal: string;
  /** last activity (session.updatedAt) — bumped when the session is advanced/touched. */
  updatedAt: number;
  openFrontierCount: number;
}

/**
 * Pure decision: ask once, only for a session that still has OPEN frontier nodes AND has gone quiet past
 * the silence threshold AND has not been asked yet this process.
 */
export function shouldAskFollowUp(
  c: FollowUpCandidate,
  ctx: { now: number; silenceMs: number; alreadyAsked: ReadonlySet<string> },
): boolean {
  if (c.openFrontierCount <= 0) return false; // nothing open to continue
  if (ctx.alreadyAsked.has(c.id)) return false; // ask once
  return ctx.now - c.updatedAt >= ctx.silenceMs; // gone quiet long enough
}

export interface FollowUpDeps {
  reasoning: ReasoningStore;
  /** Proactively notify the user (same shape as deep_explore_autoadvance). */
  notify: (text: string, opts?: { important?: boolean }) => void;
  /** ms between scans (silence is in hours, so a coarse cadence is fine). Default 10 min. */
  intervalMs?: number;
  /** Silence threshold ms. Default from env (6 h). */
  silenceMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface FollowUpLoop {
  start: () => void;
  stop: () => void;
  /** Exposed for tests: run one scan synchronously. */
  tickOnce: () => void;
}

export function createFollowUpLoop(deps: FollowUpDeps): FollowUpLoop {
  const intervalMs = deps.intervalMs ?? 10 * 60_000;
  const silenceMs = deps.silenceMs ?? silenceMsFromEnv();
  const now = deps.now ?? (() => Date.now());
  const asked = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function tickOnce(): void {
    if (stopped || !followUpEnabled()) return;
    let sessions;
    try {
      sessions = deps.reasoning.listActiveSessions();
    } catch {
      return;
    }
    for (const s of sessions) {
      let snap;
      try {
        snap = deps.reasoning.summarizeSession(s.id);
      } catch {
        continue;
      }
      if (!snap) continue;
      const c: FollowUpCandidate = {
        id: s.id,
        goal: s.goal,
        updatedAt: s.updatedAt,
        openFrontierCount: snap.openFrontierCount,
      };
      if (!shouldAskFollowUp(c, { now: now(), silenceMs, alreadyAsked: asked })) continue;
      asked.add(s.id);
      const goal = s.goal.length > 50 ? s.goal.slice(0, 50) + '…' : s.goal;
      deps.notify(
        `🔬 探索还挂着:"${goal}" 还有 ${snap.openFrontierCount} 个开放节点没推进(你已有一段时间没回"继续")。` +
          `要我接着推进吗?回复"继续",或让我后台自动推进。`,
        { important: true },
      );
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      tickOnce();
      scheduleNext();
    }, intervalMs);
    timer.unref?.(); // don't keep the process alive on this background timer
  }

  return {
    start: () => {
      if (stopped) return;
      if (!followUpEnabled()) {
        console.log('[deep-explore-followup] disabled (set PHILONT_DEEP_EXPLORE_FOLLOWUP=0 to keep off)');
        return;
      }
      if (timer) return;
      scheduleNext();
      console.log(
        `[deep-explore-followup] armed (tick=${intervalMs}ms, silence=${Math.round(silenceMs / 3_600_000)}h)`,
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
