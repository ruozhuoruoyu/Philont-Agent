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
import type { PhraseLang } from './channel_phrases.js';
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

/**
 * Auto-archive escalation (2026-07-01, user choice "ask once, then auto-archive if ignored"). A stale
 * reasoning session that was ASKED about once, never re-engaged, and is genuinely stuck should not sit open
 * forever — it stays as getMostRecentActiveSession fodder that keeps the ViabilityGate primed on unrelated
 * turns. After a long grace it is set to 'abandoned' + the user is notified. Re-openable, so it never blocks
 * the user while still keeping state tidy. Risky (closes user state) → gated by
 * PHILONT_DEEP_EXPLORE_AUTOARCHIVE (default on).
 */
export function autoArchiveEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_AUTOARCHIVE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** Grace AFTER the one follow-up ask before a still-quiet, still-stuck session is auto-archived. */
const AUTO_ARCHIVE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface AutoAbandonCandidate {
  openFrontierCount: number;
  /** last activity (session.updatedAt). */
  updatedAt: number;
  /** when the one follow-up ask was sent (undefined = not asked yet this process). */
  askedAt: number | undefined;
  /** proved nodes — > 0 means real progress, so NOT a hopeless stall. */
  provedCount: number;
}

/**
 * Pure decision: auto-archive ONLY after the session was asked about once, the user did not re-engage
 * (updatedAt has not advanced past the ask), it is still open, still has zero proofs (genuinely stuck), and
 * a long grace period has elapsed since the ask. Re-engagement (updatedAt > askedAt) is handled by the
 * caller (clears the ask); a proved node vetoes archival — real progress is never discarded.
 */
export function shouldAutoAbandon(
  c: AutoAbandonCandidate,
  ctx: { now: number; graceMs: number },
): boolean {
  if (c.openFrontierCount <= 0) return false; // already resolved — nothing to archive
  if (c.askedAt === undefined) return false; // must ask before archiving
  if (c.updatedAt > c.askedAt) return false; // user re-engaged after the ask → keep
  if (c.provedCount > 0) return false; // made real progress → not a hopeless stall
  return ctx.now - c.askedAt >= ctx.graceMs; // asked long ago, still quiet + unproven
}

export interface FollowUpDeps {
  reasoning: ReasoningStore;
  /** Proactively notify the user (same shape as deep_explore_autoadvance). */
  /** Proactively notify the user. `ownerSessionId` lets the caller route the ask to the channel the
   * session was started in (e.g. WeChat), instead of blasting every surface. */
  notify: (text: string, opts?: { important?: boolean; ownerSessionId?: string }) => void;
  /**
   * Language for the cards. These are the agent speaking FIRST (a follow-up on a session the owner has gone
   * quiet on), so there is no user message to mirror — the language must be told. Resolved by the caller.
   */
  lang?: () => PhraseLang;
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
  // id → askedAt (ms). Map (not Set) so the auto-archive pass knows WHEN we asked, and can tell a
  // re-engagement (updatedAt advanced past askedAt) from prolonged silence.
  const asked = new Map<string, number>();
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
    const nowMs = now();

    // ── Pass 1: auto-archive escalation ──────────────────────────────────────────────────────────
    // For a session we already asked about: if the user re-engaged (updatedAt advanced), clear the ask;
    // else if it stayed quiet + stuck past the grace period, set it 'abandoned' and notify once (re-openable).
    // `sessions` is a single snapshot fetched above, so a session archived here is still present in it for
    // Pass 2 — track archived ids so Pass 2 does not re-ask a session we just closed.
    const archivedThisTick = new Set<string>();
    if (autoArchiveEnabled()) {
      for (const s of sessions) {
        const askedAt = asked.get(s.id);
        if (askedAt === undefined) continue;
        if (s.updatedAt > askedAt) { asked.delete(s.id); continue; } // re-engaged → leave it alone
        let snap;
        try { snap = deps.reasoning.summarizeSession(s.id); } catch { continue; }
        if (!snap) continue;
        if (
          shouldAutoAbandon(
            { openFrontierCount: snap.openFrontierCount, updatedAt: s.updatedAt, askedAt, provedCount: snap.provedCount },
            { now: nowMs, graceMs: AUTO_ARCHIVE_GRACE_MS },
          )
        ) {
          try { deps.reasoning.setSessionStatus(s.id, 'abandoned'); } catch { continue; }
          asked.delete(s.id);
          archivedThisTick.add(s.id);
          const g = s.goal.length > 50 ? s.goal.slice(0, 50) + '…' : s.goal;
          console.log(`[deep-explore-followup] auto-archived stale stuck session ${s.id} ("${g}")`);
          deps.notify(
            (deps.lang?.() ?? 'zh') === 'en'
              ? `🗂️ I archived the stalled exploration "${g}" — I asked once, it did not advance, and it never proved anything. Say the word and I will reopen it.`
              : `🗂️ 卡住的探索「${g}」我先归档了——问过一次没推进、也一直没证出结果。要的话随时说一声,我给你重开。`,
            { important: false, ownerSessionId: s.ownerSessionId ?? undefined },
          );
        }
      }
    }

    // ── Pass 2: ask ONCE about the most recently-started newly-quiet open session ─────────────────
    // Collect ALL newly-quiet open sessions, ask about exactly ONE (most recently STARTED = current focus,
    // what "继续" targets), and mark the WHOLE batch as asked (anti-spam: no one-message-per-session drip).
    const alreadyAsked = new Set(asked.keys());
    const candidates: Array<{ id: string; goal: string; createdAt: number; owner: string | null; open: number; proved: number }> = [];
    for (const s of sessions) {
      if (archivedThisTick.has(s.id)) continue; // just archived from the stale snapshot — do not re-ask
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
      if (!shouldAskFollowUp(c, { now: nowMs, silenceMs, alreadyAsked })) continue;
      candidates.push({ id: s.id, goal: s.goal, createdAt: s.createdAt, owner: s.ownerSessionId, open: snap.openFrontierCount, proved: snap.provedCount });
    }
    if (candidates.length === 0) return;

    // 2026-07-15: enumerate + card PER OWNER, not globally. The old code counted candidates GLOBALLY
    // (all owners/channels) and sent one card, with that global count, to a single primary owner. So a
    // WeChat user was told "you have 10 explorations" when 9 belonged to other sessions they cannot see —
    // and the offered actions (继续/放弃/全清, handled owner-scoped in chat-handler) only touch their own.
    // The card's count and the count deep_explore(action=list) returns in that channel disagreed, which
    // read to the user as the agent contradicting itself ("你刚才说有10个" / list says none). Each owner
    // now gets a card counting ONLY the sessions they can act on — mirroring listActiveSessions(owner):
    // the owner's own sessions PLUS legacy NULL-owner ones (resumable by any channel).
    const en = (deps.lang?.() ?? 'zh') === 'en';
    const realOwners = [...new Set(candidates.map((c) => c.owner).filter((o): o is string => o != null))];
    for (const owner of realOwners) {
      const ownSet = candidates
        .filter((c) => c.owner === owner || c.owner === null)
        .sort((a, b) => b.createdAt - a.createdAt); // most recently started first = current focus
      if (ownSet.length === 0) continue;
      const primary = ownSet[0];
      for (const c of ownSet) asked.set(c.id, nowMs); // silence this owner's batch — one ask per batch
      const goal = primary.goal.length > 50 ? primary.goal.slice(0, 50) + '…' : primary.goal;
      const others = ownSet.length - 1;
      // A session with ZERO proofs is stuck — lead with "abandon" instead of pitching "continue".
      const stuck = primary.proved === 0;
      // Every word offered below is matched deterministically by classifyExploreControlReply (放弃 / 全清 /
      // abandon / clear all) or by the force-continue path (继续 / continue). Until 2026-07-14 放弃 and 全清
      // were words nobody listened for — do not add an option here without teaching the matcher.
      let text: string;
      if (others > 0) {
        text = en
          ? `🔬 You have ${ownSet.length} deep_explore sessions sitting idle; the latest: "${goal}" (${primary.open} open nodes). ` +
            `Reply "continue" to advance it; "abandon <name>" to drop one, or "clear all".`
          : `🔬 你有 ${ownSet.length} 个 deep_explore 探索挂着没推进,最近的:「${goal}」(${primary.open} 个开放节点)。` +
            `要推进哪个回"继续";要清理某个说"放弃 <它>",或"全清"。`;
      } else if (stuck) {
        text = en
          ? `🔬 The exploration "${goal}" has been idle a while and has proved nothing yet (${primary.open} open nodes). ` +
            `Want me to drop it? Reply "abandon" and I will archive it; reply "continue" to push on from a new angle.`
          : `🔬 探索「${goal}」挂了一阵,还没证出任何结果(${primary.open} 个开放节点还开着)。` +
            `要我放弃它吗?回"放弃"我就归档;想换个角度接着推进就回"继续"。`;
      } else {
        text = en
          ? `🔬 The exploration "${goal}" still has ${primary.open} open nodes (you have not replied "continue" in a while). ` +
            `Shall I push on ("continue"), keep advancing it in the background ("auto advance"), or archive it ("abandon")?`
          : `🔬 探索「${goal}」还有 ${primary.open} 个开放节点没推进(你已有一段时间没回"继续")。` +
            `要我接着推进(回"继续")、后台自动推进(回"自动推进"),还是放弃归档(回"放弃")?`;
      }
      // Route to the owner's channel — its count now matches what deep_explore(list) returns there.
      deps.notify(text, { important: true, ownerSessionId: owner });
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
