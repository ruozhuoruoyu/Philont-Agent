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
  /**
   * True when the denominator is a SAMPLE (turns observed) rather than a count of declared things. A zero
   * over a sample needs enough observations to mean anything; a zero over "the 1 focus area you declared"
   * or "the 1 channel you subscribed" is meaningful at a denominator of one.
   */
  sampleBased?: boolean;
}

export interface HealthInput {
  /** 24h autonomous findings vs how many reached the owner. */
  autonomy?: { found: number; eligible: number };
  /** Learning-judge verdicts in the window. */
  judge?: { verified: number; total: number };
  /**
   * Routing rules that earned confidence, out of the ACTIVE set — retired rules are excluded from the
   * denominator and reported separately. The first version divided by everything ever stored, and the
   * owner's report read "6 of 1139 — a store that grows but does not learn" while 997 of those 1139 had
   * already been tried and RETIRED by decay. That machinery discarding what failed is the system working;
   * counting its output as evidence of failure overstates the problem, and a report that overstates is a
   * report that gets discounted — the exact rot this file's header warns about.
   */
  routingRules?: { validated: number; active: number; retired?: number };
  /** Skills that were offered to the model, out of the untested draft pool. */
  skills?: { offered: number; drafts: number };
  /** Owner-declared focus areas advanced in the window. */
  focus?: { advanced: number; declared: number };
  /**
   * Push subscriptions that can actually receive a message. "Deliverable" consults BOTH facts: the channel
   * name resolves, AND today's real sends have not all failed. The first version checked only resolution —
   * and reported "1/1 真的能收到消息" in the same breath as the report itself failing to deliver for the
   * third time in twelve hours. A reachability claim that does not consult the delivery path is the
   * original push bug restated, on the line that was built because of it.
   */
  push?: { deliverable: number; active: number; failingToday?: number };
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
    // The doom clause is earned only by a real sample. At 0/1 the honest reading is "one turn", and
    // saying "I am learning nothing" about it is the overstatement that teaches the owner to skim.
    const thin = total < MIN_EVIDENCE_DENOMINATOR;
    out.push({
      key: 'judge',
      numerator: verified,
      denominator: total,
      sampleBased: true,
      line: en
        ? `Verified outcomes: ${verified}/${total} (${pct(verified, total)}) of my turns ended with proof that the goal was met. ` +
          (verified === 0 ? (thin ? 'Too few turns to read anything into it.' : 'At zero I am learning nothing from any of them.') : '')
        : `可验证成果:${total} 轮里有 ${verified} 轮(${pct(verified, total)})拿到了"目标达成"的证据。` +
          (verified === 0 ? (thin ? '轮次太少,读不出什么。' : '为 0 时,我从这些轮次里什么也学不到。') : ''),
    });
  }

  if (input.routingRules && input.routingRules.active > 0) {
    const { validated, active, retired } = input.routingRules;
    const retiredNote = retired
      ? en
        ? ` (${retired} more were tried and retired — discarding is working)`
        : `(另有 ${retired} 条已试过并被淘汰 —— 淘汰机制在工作)`
      : '';
    out.push({
      key: 'rules',
      numerator: validated,
      denominator: active,
      line: en
        ? `Learned rules: ${validated}/${active} active rules have earned confidence${retiredNote}. ` +
          (validated / active < 0.02 ? 'That is a store that grows but does not learn.' : '')
        : `学到的规则:活跃 ${active} 条里 ${validated} 条挣到了置信度${retiredNote}。` +
          (validated / active < 0.02 ? '这是一个只增不学的库。' : ''),
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
    const { deliverable, active, failingToday } = input.push;
    const failNote = failingToday
      ? en
        ? ` ${failingToday} channel(s) are registered but every send today has FAILED — a WeChat channel in this state usually needs a fresh scan-login (npm run wechat:login).`
        : ` 其中 ${failingToday} 条渠道注册正常但今天的发送全部失败 —— 微信渠道出现这种状态,通常需要重新扫码登录(npm run wechat:login)。`
      : '';
    out.push({
      key: 'push',
      numerator: deliverable,
      denominator: active,
      line: en
        ? `Reachability: ${deliverable}/${active} of the channels I am subscribed to can actually receive a message.${failNote}`
        : `可达性:我订阅的 ${active} 条渠道里,${deliverable} 条真的能收到消息。${failNote}`,
    });
  }

  return out;
}

/**
 * Below this many observations a zero is not a finding. 0 of 1 is not "produced nothing" — it is one
 * sample, and a report that treats it as a broken subsystem is crying wolf on arithmetic.
 *
 * Production 2026-07-26: the day's only degenerate item was the learning judge at 0/1, so the report
 * interrupted the owner to say a subsystem was probably broken on the strength of a single turn. The
 * owner's reaction — 每次都说这个 — is the exact rot this file's header warns about: a report that
 * overstates gets discounted, and then the true findings go with it.
 */
export const MIN_EVIDENCE_DENOMINATOR = 5;

/**
 * The ratios that warrant the owner's attention: a zero where zero is not the expected outcome AND there
 * were enough observations for the zero to mean something. Still not a tunable alarm threshold — the
 * judgement is "this subsystem produced nothing across a real sample", which needs no calibration.
 */
export function degenerateRatios(ratios: readonly HealthRatio[]): HealthRatio[] {
  return ratios.filter(
    (r) =>
      !r.zeroIsNormal &&
      r.numerator === 0 &&
      (r.sampleBased ? r.denominator >= MIN_EVIDENCE_DENOMINATOR : r.denominator > 0),
  );
}

/** Sample-based ratios reported for completeness but too thin to conclude anything from. */
export function thinEvidenceRatios(ratios: readonly HealthRatio[]): HealthRatio[] {
  return ratios.filter(
    (r) => !!r.sampleBased && r.denominator > 0 && r.denominator < MIN_EVIDENCE_DENOMINATOR,
  );
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

  // The closing line used to be the same sentence every time, and it handed the owner homework: "the
  // zeros above are the ones worth asking me about". A second brain that ends each report by telling the
  // person to interrogate it has moved the work in the wrong direction — and repeated verbatim daily, it
  // is the first thing a reader learns to skip. Name the ONE item and what I will do about it, or say
  // nothing.
  const bad = degenerateRatios(ratios);
  if (bad.length > 0) {
    const worst = bad[0];
    lines.push(
      en
        ? `\n→ ${worst.key}: ${worst.numerator} of ${worst.denominator}. I am treating this as broken rather ` +
          `than idle and will look at it before adding anything new.`
        : `\n→ ${worst.key}:${worst.denominator} 次里 ${worst.numerator} 次。我按"坏了"而不是"闲着"处理,` +
          `在加新东西之前先查它。`,
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

/**
 * Read a day-keyed counter out of a metrics snapshot.
 *
 * Why day-keyed counters exist at all: the judge tally and the autonomy-reach counter above are in-memory,
 * and the boot-time health check runs eight seconds after start — so at every boot-time check those two
 * ratios are EMPTY, the corresponding lines are omitted for lack of data, and a report that fired at 16:53
 * with two degenerate items can honestly say "nothing degenerate" at 20:21 after a restart. With an owner
 * who restarts several times a day, the two highest-signal ratios were structurally invisible to the very
 * check meant to surface them. Day-keyed rows in the metrics store survive restarts; the in-memory
 * versions stay for the /autonomy display, which wants a rolling window and a per-driver breakdown.
 */
export function dayCount(snapshot: ReadonlyArray<{ key: string; count: number }>, prefix: string, ymd: string): number {
  return snapshot.find((r) => r.key === `${prefix}.${ymd}`)?.count ?? 0;
}
