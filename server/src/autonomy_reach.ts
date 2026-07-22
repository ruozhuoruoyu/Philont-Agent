/**
 * Did anything the agent found on its own actually REACH the owner?
 *
 * The nine gates between a finding and the owner were each written and reviewed on their own merits, and
 * the console funnel added in 2026-07-14 made their decisions watchable — in the CONSOLE. The owner does
 * not read the console. So the state of affairs on 2026-07-22 was: seventeen findings in one hour, every
 * one dropped at gate 1, each drop dutifully logged, and from the owner's seat the autonomy remained
 * exactly as invisible as before the instrumentation existed.
 *
 * This is the counter that fixes that, and its purpose is narrow: it makes the drop rate a NUMBER the
 * owner can ask for (`/autonomy`). It deliberately does NOT loosen any gate. Gate 1 exists because
 * interrupting someone is a real cost, and "the owner sees nothing" is the correct outcome for a quiet
 * hour of free curiosity — but only if they can find that out by asking, instead of concluding the
 * feature is dead.
 *
 * In-memory and process-scoped, like the sibling funnel counters: this is instrumentation, not a record.
 */

export interface ReachEvent {
  ts: number;
  /** Which driver produced it (curiosity / pursuit / …). */
  driver: string;
  /** Whether it got past gate 1 (severity=high) — i.e. whether it was even eligible to reach the owner. */
  passedGate1: boolean;
}

/** One day of events, hard-capped so a runaway loop cannot grow this without bound. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 2000;

const events: ReachEvent[] = [];

export function recordAutonomyReach(driver: string | undefined, passedGate1: boolean, now = Date.now()): void {
  events.push({ ts: now, driver: driver ?? '?', passedGate1 });
  const cutoff = now - WINDOW_MS;
  while (events.length > 0 && (events[0].ts < cutoff || events.length > MAX_EVENTS)) events.shift();
}

export interface AutonomyReachSummary {
  /** Findings produced in the window. */
  found: number;
  /** How many were eligible to reach the owner (passed gate 1). */
  eligible: number;
  /** Per-driver breakdown of what produced them — which driver is doing the work nobody sees. */
  byDriver: Record<string, number>;
}

export function autonomyReachSummary(now = Date.now()): AutonomyReachSummary {
  const cutoff = now - WINDOW_MS;
  const live = events.filter((e) => e.ts >= cutoff);
  const byDriver: Record<string, number> = {};
  for (const e of live) byDriver[e.driver] = (byDriver[e.driver] ?? 0) + 1;
  return { found: live.length, eligible: live.filter((e) => e.passedGate1).length, byDriver };
}

/**
 * One line for the owner. Says the honest thing in the common case — that working quietly and not
 * interrupting is the system behaving correctly — while making a 0-of-many rate impossible to miss.
 */
export function renderAutonomyReach(s: AutonomyReachSummary, lang: 'zh' | 'en' = 'zh'): string {
  if (s.found === 0) {
    return lang === 'en' ? 'Findings (24h): none yet.' : '自主发现(24h):暂无。';
  }
  const drivers = Object.entries(s.byDriver)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d}×${n}`)
    .join(' ');
  if (lang === 'en') {
    return (
      `Findings (24h): ${s.found}, of which ${s.eligible} were important enough to message you about` +
      ` [${drivers}].` +
      (s.eligible === 0
        ? ' The rest went into my working context instead of interrupting you — that is the intended default,'
          + ' not a failure. Say "tell me what you found" to see them anyway.'
        : '')
    );
  }
  return (
    `自主发现(24h):${s.found} 条,其中 ${s.eligible} 条重要到值得主动打断你 [${drivers}]。` +
    (s.eligible === 0
      ? ' 其余进了我的工作上下文而没有打扰你 —— 这是设计中的默认行为,不是故障。想看的话跟我说"讲讲你都发现了什么"。'
      : '')
  );
}

/** For tests. */
export function _resetAutonomyReachForTest(): void {
  events.length = 0;
}
