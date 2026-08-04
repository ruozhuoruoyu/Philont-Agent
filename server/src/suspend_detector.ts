/**
 * Did the whole process stop running for a while?
 *
 * ## The day this cost
 *
 * 2026-08-04. The owner sent 继续 at 11:35, 继续 at 13:42, and 怎么样了？at 15:35. Each turn ended in
 * `TypeError: terminated` and a 19-character "抱歉，刚才出错了". Five hours, three dead ends, no
 * explanation — and from the outside it reads as philont hanging.
 *
 * The timestamps say otherwise. Every clock in the process stops together and restarts together:
 *
 *   11:35:35  [timeline] retrieved …          12:35:21  [turn] start        (60 min inside one setup)
 *   13:42:11  [turn] start …                  14:35:24  [drive] evaluated   (53 min between two lines)
 *   15:35:22  [turn] start …                  16:35:32  [drive] evaluated   (60 min)
 *   [autonomous] tick: ran=1 … 4202284ms                                     (a 70-minute "tick")
 *   [wechat] getUpdates exception: fetch failed   at 11:35:27 / 13:35:31 / 15:35:23
 *
 * A 300-second autonomous tick cannot take 70 minutes while still reporting ran=1. The process was
 * SUSPENDED — the host slept, or the console was frozen (see the QuickEdit note in start.ps1) — and the
 * network stack failed on first use after each wake, which is what `terminated` and `fetch failed` are.
 *
 * ## Why a mechanism and not just a note
 *
 * Nothing inside a suspended process can fire: the 20-minute turn deadline is not late, it simply never
 * ran. The one thing that IS possible is noticing afterwards — a wall-clock gap between two consecutive
 * ticks that vastly exceeds the interval can only mean the process was not running in between.
 *
 * So this measures it and says so, and a turn that spanned a suspension can tell the owner "the machine
 * was asleep for 53 minutes, your message was never processed — send it again" instead of "出错了".
 * That sentence is the entire point: it is the difference between a broken agent and a sleeping laptop,
 * and the owner currently has no way to tell them apart.
 *
 * PHILONT_SUSPEND_DETECT=0 disables it.
 */

/** How often we take the clock. Short enough that a real gap is unambiguous, cheap enough to ignore. */
const TICK_MS = 30_000;

/**
 * A gap this large means the process was not running. Deliberately far above the tick interval: a
 * blocked event loop (better-sqlite3 is synchronous) can swallow a handful of ticks, and telling the
 * owner "your machine was asleep" when it was merely busy is a worse error than saying nothing. Every
 * real outage measured on 2026-08-04 was 53-70 minutes, so there is no need to run this close.
 */
const SUSPENSION_MS = 5 * 60_000;

export interface Suspension {
  /** Wall-clock when the process was last known to be running. */
  from: number;
  /** Wall-clock when it was seen running again. */
  to: number;
}

const suspensions: Suspension[] = [];
/** Keep the recent past only — this is for explaining the turn that just failed, not an audit log. */
const MAX_KEPT = 50;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeen = 0;

export function suspendDetectEnabled(): boolean {
  return process.env.PHILONT_SUSPEND_DETECT !== '0';
}

/**
 * Compare the clock against the last observation. Exported so tests can drive it without timers.
 * Returns the suspension it recorded, or null.
 */
export function observeClock(now: number, thresholdMs: number = SUSPENSION_MS): Suspension | null {
  const prev = lastSeen;
  lastSeen = now;
  if (prev === 0) return null; // first observation has nothing to compare against
  const gap = now - prev;
  if (gap < thresholdMs) return null;
  const s: Suspension = { from: prev, to: now };
  suspensions.push(s);
  if (suspensions.length > MAX_KEPT) suspensions.shift();
  console.warn(
    `[suspend] the process did not run for ${Math.round(gap / 60_000)} min ` +
      `(${new Date(prev).toISOString()} → ${new Date(now).toISOString()}) — host sleep or a frozen ` +
      `console. Timers did not fire and in-flight turns were not processed during this window.`,
  );
  return s;
}

/** Milliseconds of detected suspension overlapping [startedAt, endedAt]. */
export function suspensionDuring(startedAt: number, endedAt: number): number {
  let total = 0;
  for (const s of suspensions) {
    const overlap = Math.min(endedAt, s.to) - Math.max(startedAt, s.from);
    if (overlap > 0) total += overlap;
  }
  return total;
}

/**
 * The sentence the owner gets instead of a bare error, or null when this turn ran on a live process.
 * Bilingual for the same reason every other owner-facing string here is.
 */
export function explainSuspension(startedAt: number, endedAt: number, en: boolean): string | null {
  const ms = suspensionDuring(startedAt, endedAt);
  if (ms < SUSPENSION_MS) return null;
  const min = Math.round(ms / 60_000);
  return en
    ? `\n\nThis was not a philont fault: the machine was suspended (asleep or a frozen console) for about ` +
        `${min} minutes while your message was in flight, so nothing ran. Send it again.`
    : `\n\n这不是 philont 的故障:你的消息在处理中时,这台机器被挂起了大约 ${min} 分钟(休眠或控制台冻结),` +
        `期间没有任何代码在跑。重发一次即可。`;
}

export function startSuspendDetector(): void {
  if (!suspendDetectEnabled() || timer) return;
  lastSeen = Date.now();
  timer = setInterval(() => observeClock(Date.now()), TICK_MS);
  // Never hold the process open for this.
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function _resetSuspendDetectorForTest(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastSeen = 0;
  suspensions.length = 0;
}
