/**
 * What the agent tells its owner about its own health — as RATIOS, once a day, unprompted.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────────────
 *
 * philont computes every number needed to detect its own broken subsystems, and reports all of them to a
 * console. In one production night: 45 autonomous findings and 0 reaching the owner; the learning judge
 * returning could_not_verify on 100% of turns; 1094 routing rules stored and 3 validated; a declared focus
 * area advanced zero times in a week; one active push subscription and zero deliverable. Every one of those
 * is a division where both sides already exist in the DB.
 *
 * None of them was noticed by the agent. All of them were found by the owner pasting a log into a chat
 * with a different AI — a detection path whose latency is measured in months and whose trigger is chance.
 *
 * The failure mode is specific and worth naming: philont's entire thesis is that a MECHANISM beats a
 * PROMPT because a mechanism cannot be ignored. Instrumentation that writes to a log breaks that thesis,
 * because a log CAN be ignored — and was. So the design property that matters here is not "report health";
 * it is WHERE the report goes:
 *
 *   > Route the health signal to the party who suffers when it is bad.
 *
 * The owner is the only recipient who cannot silently drop it. That is the whole reason this reports to a
 * person rather than to a metrics table.
 *
 * ── What it deliberately is not ──────────────────────────────────────────────────────────────────────
 *
 * Not an alert system with thresholds to tune — a threshold is another thing that can be wrong in silence.
 * It states the ratios plainly and lets the owner see a zero. Not a dashboard, for the same reason the
 * console failed. And it says the honest reading of a low number rather than presenting it as an alarm:
 * "0 of 45 reached you" is CORRECT behaviour for a quiet night of low-value findings, and the report says
 * so — otherwise a true statement gets read as a false alarm and the whole report starts being ignored,
 * which is the failure it exists to prevent.
 */

export interface HealthRatio {
  /** Short label, e.g. "autonomy". */
  key: string;
  /** How many of the denominator got through. */
  numerator: number;
  denominator: number;
  /** One line the owner can act on, stated in consequence terms. */
  line: string;
  /**
   * True when a zero (or near-zero) here is the EXPECTED, healthy outcome rather than a defect. Keeps the
   * report from crying wolf, which is what makes an honest report get ignored.
   */
  zeroIsNormal?: boolean;
}

export interface HealthInput {
  /** 24h autonomous findings vs how many reached the owner. */
  autonomy?: { found: number; eligible: number };
  /** Learning-judge verdicts in the window. */
  judge?: { verified: number; total: number };
  /** Routing rules that earned confidence, out of everything stored. */
  routingRules?: { validated: number; stored: number };
  /** Skills that were offered to the model, out of the untested draft pool. */
  skills?: { offered: number; drafts: number };
  /** Owner-declared focus areas advanced in the window. */
  focus?: { advanced: number; declared: number };
  /** Push subscriptions that actually resolve to a live channel. */
  push?: { deliverable: number; active: number };
  /** Broken references found by the startup integrity check. */
  brokenRefs?: Array<{ check: string; ref: string; consequence: string }>;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`);

export function computeHealthRatios(input: HealthInput, lang: 'zh' | 'en' = 'zh'): HealthRatio[] {
  const en = lang === 'en';
  const out: HealthRatio[] = [];

  if (input.autonomy && input.autonomy.found > 0) {
    const { found, eligible } = input.autonomy;
    out.push({
      key: 'autonomy',
      numerator: eligible,
      denominator: found,
      zeroIsNormal: true,
      line: en
        ? `Autonomous findings: ${eligible}/${found} were worth interrupting you about. The rest went into my working context.`
        : `自主发现:${found} 条中有 ${eligible} 条值得打断你,其余进了我的工作上下文。`,
    });
  }

  if (input.judge && input.judge.total > 0) {
    const { verified, total } = input.judge;
    out.push({
      key: 'judge',
      numerator: verified,
      denominator: total,
      line: en
        ? `Verified outcomes: ${verified}/${total} (${pct(verified, total)}) of my turns ended with proof that the goal was met. ` +
          (verified === 0 ? 'At zero I am learning nothing from any of them.' : '')
        : `可验证成果:${total} 轮里有 ${verified} 轮(${pct(verified, total)})拿到了"目标达成"的证据。` +
          (verified === 0 ? '为 0 时,我从这些轮次里什么也学不到。' : ''),
    });
  }

  if (input.routingRules && input.routingRules.stored > 0) {
    const { validated, stored } = input.routingRules;
    out.push({
      key: 'rules',
      numerator: validated,
      denominator: stored,
      line: en
        ? `Learned rules: ${validated}/${stored} have earned confidence. ` +
          (validated / stored < 0.02 ? 'That is a store that grows but does not learn.' : '')
        : `学到的规则:${stored} 条里 ${validated} 条挣到了置信度。` +
          (validated / stored < 0.02 ? '这是一个只增不学的库。' : ''),
    });
  }

  if (input.skills && input.skills.drafts > 0) {
    const { offered, drafts } = input.skills;
    out.push({
      key: 'skills',
      numerator: offered,
      denominator: drafts,
      line: en
        ? `Draft skills: ${offered}/${drafts} have ever been offered to me for use. An untried skill cannot be judged.`
        : `草稿技能:${drafts} 条里 ${offered} 条曾被递到我面前。没试过的技能无法被判断好坏。`,
    });
  }

  if (input.focus && input.focus.declared > 0) {
    const { advanced, declared } = input.focus;
    out.push({
      key: 'focus',
      numerator: advanced,
      denominator: declared,
      line: en
        ? `Your compass: ${advanced}/${declared} focus areas advanced. ` +
          (advanced === 0 ? 'None of what you told me to care about moved.' : '')
        : `你的指南针:${declared} 个焦点中推进了 ${advanced} 个。` +
          (advanced === 0 ? '你让我关心的事,一件都没动。' : ''),
    });
  }

  if (input.push && input.push.active > 0) {
    const { deliverable, active } = input.push;
    out.push({
      key: 'push',
      numerator: deliverable,
      denominator: active,
      line: en
        ? `Reachability: ${deliverable}/${active} of the channels I am subscribed to can actually receive a message.`
        : `可达性:我订阅的 ${active} 条渠道里,${deliverable} 条真的能收到消息。`,
    });
  }

  return out;
}

/**
 * The ratios that warrant the owner's attention: a zero (or near-zero) where zero is not the expected
 * outcome. Explicitly NOT a tunable threshold — the only judgement encoded is "this subsystem produced
 * nothing at all", which needs no calibration and cannot drift.
 */
export function degenerateRatios(ratios: readonly HealthRatio[]): HealthRatio[] {
  return ratios.filter((r) => !r.zeroIsNormal && r.denominator > 0 && r.numerator === 0);
}

export function renderHealthReport(
  ratios: readonly HealthRatio[],
  brokenRefs: HealthInput['brokenRefs'] = [],
  lang: 'zh' | 'en' = 'zh',
): string {
  const en = lang === 'en';
  const lines: string[] = [];
  lines.push(en ? '🩺 Daily self-check' : '🩺 每日自检');

  if (ratios.length === 0 && (brokenRefs?.length ?? 0) === 0) {
    lines.push(en ? 'Nothing ran in the last day — no ratios to report.' : '过去一天没有任何活动,没有可报的比值。');
    return lines.join('\n');
  }

  for (const r of ratios) lines.push(`· ${r.line}`);

  if (brokenRefs && brokenRefs.length > 0) {
    lines.push(
      en
        ? `\n⛔ ${brokenRefs.length} broken internal reference(s) — each one is a feature that is silently doing nothing:`
        : `\n⛔ ${brokenRefs.length} 处内部引用断了 —— 每一处都是一个正在静默失效的功能:`,
    );
    for (const b of brokenRefs.slice(0, 5)) lines.push(`· ${b.ref}: ${b.consequence}`);
  }

  const bad = degenerateRatios(ratios);
  if (bad.length > 0) {
    lines.push(
      en
        ? `\nThe zeros above are the ones worth asking me about — a subsystem that produced nothing is usually broken rather than idle.`
        : `\n上面为 0 的那几项值得追问我 —— 一个什么都没产出的子系统,通常是坏了,而不是闲着。`,
    );
  }
  return lines.join('\n');
}

/**
 * Whether today's report should be sent at all.
 *
 * Sent when something is WRONG (a degenerate ratio or a broken reference) — a clean day does not earn an
 * interruption, and a report that arrives every single day is one a person learns to skip, which is
 * exactly how the console instrumentation stopped working.
 */
export function shouldSendHealthReport(
  ratios: readonly HealthRatio[],
  brokenRefs: HealthInput['brokenRefs'] = [],
): boolean {
  return degenerateRatios(ratios).length > 0 || (brokenRefs?.length ?? 0) > 0;
}

// ── The one number nothing was recording ────────────────────────────────────────────────────────────
//
// The learning judge WRITES its verdict to the console and nowhere else, so "0 verified out of 12" was
// not a number anything could read — it had to be counted by hand off a pasted log. A windowed tally
// lives here, next to the consumer, rather than in the metrics store: the health report asks about the
// last 24 hours, and the metrics store is cumulative-since-forever, which cannot answer that.

interface JudgeEvent {
  ts: number;
  verified: boolean;
}
const judgeEvents: JudgeEvent[] = [];
const JUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const JUDGE_MAX = 2000;

export function recordJudgeVerdict(outcome: string, now = Date.now()): void {
  judgeEvents.push({ ts: now, verified: outcome === 'success' });
  const cutoff = now - JUDGE_WINDOW_MS;
  while (judgeEvents.length > 0 && (judgeEvents[0].ts < cutoff || judgeEvents.length > JUDGE_MAX)) {
    judgeEvents.shift();
  }
}

export function judgeWindowTally(now = Date.now()): { verified: number; total: number } {
  const live = judgeEvents.filter((e) => e.ts >= now - JUDGE_WINDOW_MS);
  return { verified: live.filter((e) => e.verified).length, total: live.length };
}

/** For tests. */
export function _resetJudgeTallyForTest(): void {
  judgeEvents.length = 0;
}

// ── When to send, when to retry ─────────────────────────────────────────────────────────────────────
//
// The first stamping design wrote the day-stamp BEFORE dispatch, reasoning that a delivery failure must
// not become a retry on every restart. Production answered within hours: the boot-time send raced the
// WeChat gateway's warmup, failed with "prepare failed" eight seconds after start — and the stamp then
// swallowed the report for the whole day. A report that dies to a transient send error and cannot retry
// is the push bug in miniature: the mechanism claims "sent today" while the owner received nothing.
//
// So the stamp records the OUTCOME, not the intent, and the skip rule reads it: a delivered report is
// final for the day; a failed one may retry (next boot or the 24h tick — the dispatcher's own digest rate
// limiter bounds the pace) up to a small cap, because a channel that failed three times today is down for
// reasons a fourth attempt will not fix, and the webui copy has already been shown.

export interface HealthSendStamp {
  ymd: string;
  delivered: boolean;
  attempts: number;
}

export const HEALTH_SEND_MAX_ATTEMPTS_PER_DAY = 3;

/** Whether today's report should be skipped, given the stored stamp. */
export function shouldSkipHealthSend(stamp: HealthSendStamp | null | undefined, today: string): boolean {
  if (!stamp || stamp.ymd !== today) return false;
  if (stamp.delivered) return true;
  return stamp.attempts >= HEALTH_SEND_MAX_ATTEMPTS_PER_DAY;
}

/** The stamp to store after an attempt. */
export function nextHealthSendStamp(
  prev: HealthSendStamp | null | undefined,
  today: string,
  delivered: boolean,
): HealthSendStamp {
  const attempts = prev && prev.ymd === today ? prev.attempts + 1 : 1;
  return { ymd: today, delivered: delivered || (prev?.ymd === today && prev.delivered === true), attempts };
}
