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
  /** Proactively notify the user. `ownerSessionId` lets the caller route the ask to the channel the
   * session was started in (e.g. WeChat), instead of blasting every surface. */
  notify: (text: string, opts?: { important?: boolean; ownerSessionId?: string }) => void;
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
    // Collect ALL newly-quiet open sessions, then ask about exactly ONE (the most recently STARTED — the
    // current focus, = what "继续" targets), and mark the WHOLE batch as asked. This is the anti-spam
    // fix: a chat with dozens of stale open sessions must NOT get one message per session per tick.
    const nowMs = now();
    const candidates: Array<{ id: string; goal: string; createdAt: number; owner: string | null; open: number }> = [];
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
      if (!shouldAskFollowUp(c, { now: nowMs, silenceMs, alreadyAsked: asked })) continue;
      candidates.push({ id: s.id, goal: s.goal, createdAt: s.createdAt, owner: s.ownerSessionId, open: snap.openFrontierCount });
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.createdAt - a.createdAt); // most recently started first = current focus
    const primary = candidates[0];
    for (const c of candidates) asked.add(c.id); // silence the whole batch — no drip, one ask per batch
    const goal = primary.goal.length > 50 ? primary.goal.slice(0, 50) + '…' : primary.goal;
    const others = candidates.length - 1;
    const text =
      others > 0
        ? `🔬 你有 ${candidates.length} 个 deep_explore 探索挂着没推进,最近的:"${goal}"(${primary.open} 个开放节点)。` +
          `继续它回复"继续";其余更早的要挑一个或清理,跟我说就行。`
        : `🔬 探索还挂着:"${goal}" 还有 ${primary.open} 个开放节点没推进(你已有一段时间没回"继续")。` +
          `要我接着推进吗?回复"继续",或让我后台自动推进。`;
    // Route to the channel the session was started in (e.g. WeChat) — don't blast every surface.
    deps.notify(text, { important: true, ownerSessionId: primary.owner ?? undefined });
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
