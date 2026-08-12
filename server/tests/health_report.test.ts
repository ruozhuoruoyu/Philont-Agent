/**
 * The owner-facing self-check. See health_report.ts for the design property that matters: the health
 * signal goes to the party who suffers when it is bad, because the console — which had all of these
 * numbers — is a channel that can be, and was, ignored for months.
 *
 * The night that produced these tests: 45 findings / 0 reaching the owner, judge 0/12, rules 3/1094,
 * focus 0/1, push 0/1 deliverable. Every one a division whose both sides already existed in the DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHealthRatios,
  degenerateRatios,
  renderHealthReport,
  shouldSendHealthReport,
} from '../src/health_report.js';

/** The production night, as numbers. */
const THAT_NIGHT = {
  autonomy: { found: 45, eligible: 0 },
  judge: { verified: 0, total: 12 },
  routingRules: { validated: 3, active: 140, retired: 954 },
  focus: { advanced: 0, declared: 1 },
  push: { deliverable: 0, active: 1 },
};

test('the ratios that were invisible that night all appear in the report', () => {
  const ratios = computeHealthRatios(THAT_NIGHT, 'en');
  const keys = ratios.map((r) => r.key).sort();
  assert.deepEqual(keys, ['autonomy', 'focus', 'judge', 'push', 'rules']);
});

test('a zero that is EXPECTED does not raise an alarm; the others do', () => {
  const ratios = computeHealthRatios(THAT_NIGHT, 'en');
  const bad = degenerateRatios(ratios).map((r) => r.key).sort();
  // autonomy 0/45 is correct behaviour for a quiet night — crying wolf about it is what makes an honest
  // report get skipped, which is the failure this whole file exists to prevent.
  assert.deepEqual(bad, ['focus', 'judge', 'push']);
});

test('the report is sent when something is wrong, and NOT on a clean day', () => {
  assert.equal(shouldSendHealthReport(computeHealthRatios(THAT_NIGHT, 'en')), true);

  const healthy = computeHealthRatios(
    {
      autonomy: { found: 4, eligible: 1 },
      judge: { verified: 6, total: 12 },
      routingRules: { validated: 40, active: 200 },
      focus: { advanced: 1, declared: 1 },
      push: { deliverable: 1, active: 1 },
    },
    'en',
  );
  // A report that arrives every day is one a person learns to skip.
  assert.equal(shouldSendHealthReport(healthy), false);
});

test('a broken reference alone is enough to send it', () => {
  assert.equal(
    shouldSendHealthReport([], [{ check: 'push', ref: 'wechat:p', consequence: 'every message dropped' }]),
    true,
  );
});

test('the text states consequences, not just numbers', () => {
  const text = renderHealthReport(
    computeHealthRatios(THAT_NIGHT, 'en'),
    [{ check: 'push-subscription→channel', ref: 'wechat:o9cq', consequence: 'every proactive message is dropped' }],
    'en',
  );
  assert.match(text, /learning nothing/, 'judge 0/12 must say what it costs');
  assert.match(text, /None of what you told me to care about moved/, 'focus 0/1 must be stated in the owner\'s terms');
  assert.match(text, /discarding is working/, 'the retired count must read as decay working, not as failure');
  assert.match(text, /silently doing nothing/, 'a broken reference must name the consequence');
  // The closing line used to read "the zeros above are the ones worth asking me about" — the same
  // sentence every day, and it handed the owner homework. 2026-07-26: "每次都说这个，最后一句话感觉不太好".
  // A second brain that ends every report by asking to be interrogated has moved the work the wrong way.
  assert.doesNotMatch(text, /worth asking me about/, 'no standing homework for the owner');
  assert.match(text, /treating this as broken/, 'name the one item and what I will do about it');
});

test('a subsystem with no activity is omitted rather than reported as 0/0', () => {
  const ratios = computeHealthRatios({ autonomy: { found: 0, eligible: 0 }, judge: { verified: 0, total: 0 } }, 'en');
  assert.equal(ratios.length, 0, '0/0 is not a signal — reporting it as one manufactures noise');
});

test('Chinese rendering carries the same interpretations', () => {
  const text = renderHealthReport(computeHealthRatios(THAT_NIGHT, 'zh'), [], 'zh');
  assert.match(text, /每日自检/);
  assert.match(text, /一件都没动/);
  assert.match(text, /淘汰机制在工作/);
});

// ── The stamp records the outcome, not the intent ───────────────────────────
//
// Production 2026-07-23 16:53: the boot-time send raced the WeChat gateway warmup and failed with
// "prepare failed" 8 seconds after start — and the stamp-before-dispatch design then swallowed the
// report for the entire day. A mechanism claiming "sent today" while the owner received nothing is the
// push bug in miniature.

import {
  shouldSkipHealthSend,
  nextHealthSendStamp,
  HEALTH_SEND_MAX_ATTEMPTS_PER_DAY,
  dayCount,
} from '../src/health_report.js';

test('a delivered report is final for the day; a failed one may retry', () => {
  const failed = nextHealthSendStamp(null, '20260723', false);
  assert.equal(shouldSkipHealthSend(failed, '20260723'), false, 'the production case: failure must be retryable');

  const ok = nextHealthSendStamp(failed, '20260723', true);
  assert.equal(shouldSkipHealthSend(ok, '20260723'), true);
});

test('a durably deferred report waits for next inbound instead of blind retrying', () => {
  const stamp = nextHealthSendStamp(null, '20260723', false, true);
  assert.deepEqual(stamp, { ymd: '20260723', delivered: false, deferred: true, attempts: 1 });
  assert.equal(shouldSkipHealthSend(stamp, '20260723'), true);
});

test('retries are capped — a channel that failed three times today is down, not unlucky', () => {
  let stamp = null;
  for (let i = 0; i < HEALTH_SEND_MAX_ATTEMPTS_PER_DAY; i++) stamp = nextHealthSendStamp(stamp, '20260723', false);
  assert.equal(shouldSkipHealthSend(stamp, '20260723'), true, 'the cap holds even though nothing was delivered');
});

test('a new day resets everything', () => {
  let stamp = nextHealthSendStamp(null, '20260723', true);
  assert.equal(shouldSkipHealthSend(stamp, '20260724'), false);
  stamp = nextHealthSendStamp(stamp, '20260724', false);
  assert.deepEqual(stamp, { ymd: '20260724', delivered: false, attempts: 1 });
});

test('a later failed attempt cannot un-deliver the day', () => {
  const ok = nextHealthSendStamp(null, '20260723', true);
  const after = nextHealthSendStamp(ok, '20260723', false);
  assert.equal(after.delivered, true, 'delivered is a ratchet within the day');
});

test('the legacy stamp shape (no attempts field) is treated as unsent, not as a crash', () => {
  // Rows written by the previous version look like { ymd } — reading them must degrade to a resend at
  // worst, never to an exception inside the health path.
  const legacy = { ymd: '20260723' } as never;
  assert.equal(shouldSkipHealthSend(legacy, '20260723'), false);
});

test('retired rules are not evidence of failure — the denominator is the active set', () => {
  // The owner's first real report read "6 of 1139 — a store that grows but does not learn" while 997 of
  // the 1139 had been tried and RETIRED by decay. Discarding what failed is the machinery working.
  const [r] = computeHealthRatios({ routingRules: { validated: 6, active: 142, retired: 997 } }, 'zh');
  assert.equal(r.denominator, 142);
  assert.match(r.line, /淘汰机制在工作/);
  assert.doesNotMatch(r.line, /只增不学/, '6/142 = 4% earns no such verdict');

  // But a genuinely unvalidating ACTIVE set still gets the honest interpretation.
  const [bad] = computeHealthRatios({ routingRules: { validated: 1, active: 200 } }, 'zh');
  assert.match(bad.line, /只增不学/);
});

test('dayCount: the boot-time blind spot — a restart must not erase the day', () => {
  // At 16:53 the report carried two degenerate items; at 20:21, after a restart, the same day read
  // "nothing degenerate" — partly real improvement, partly because the judge and autonomy windows were
  // in-memory and the boot-time check runs 8 seconds in, when they are always empty. Day-keyed metrics
  // rows survive the restart.
  const snap = [
    { key: 'judge.day.total.20260723', count: 12 },
    { key: 'judge.day.verified.20260723', count: 0 },
    { key: 'autonomy.day.found.20260723', count: 45 },
  ];
  assert.equal(dayCount(snap, 'judge.day.total', '20260723'), 12);
  assert.equal(dayCount(snap, 'judge.day.verified', '20260723'), 0);
  assert.equal(dayCount(snap, 'autonomy.day.eligible', '20260723'), 0, 'a key never written reads as zero');
  assert.equal(dayCount(snap, 'judge.day.total', '20260724'), 0, 'yesterday does not leak into today');
});

test('a channel whose every send today failed is not "deliverable", and the line says what to do', () => {
  // Twelve hours of ret=-2 "prepare failed" — boot+8s, +20min, +40min, all dead — while the reachability
  // line reported 1/1 because the name resolved. Resolution is not delivery.
  const [r] = computeHealthRatios({ push: { deliverable: 0, active: 1, failingToday: 1 } }, 'zh');
  assert.equal(r.numerator, 0);
  assert.match(r.line, /发送全部失败/);
  assert.match(r.line, /重新扫码登录/, 'the owner must be told the fix, not just the failure');

  // And a healthy channel keeps the plain line.
  const [ok] = computeHealthRatios({ push: { deliverable: 1, active: 1 } }, 'zh');
  assert.doesNotMatch(ok.line, /失败/);
});

test('a zero over a SAMPLE of one is arithmetic, not a finding', () => {
  // 2026-07-26: the day's only degenerate item was the learning judge at 0/1, so the report interrupted
  // the owner to say a subsystem was probably broken on the strength of a single turn.
  const thin = computeHealthRatios({ judge: { verified: 0, total: 1 } }, 'zh');
  assert.equal(degenerateRatios(thin).length, 0, '0/1 must not raise an alarm');
  assert.equal(shouldSendHealthReport(thin), false, 'and must not earn an interruption');
  assert.match(thin[0].line, /轮次太少/, 'it is still reported, read honestly');
  assert.doesNotMatch(thin[0].line, /什么也学不到/, 'the doom clause is earned by a real sample');

  // A real sample still gets the real verdict.
  const real = computeHealthRatios({ judge: { verified: 0, total: 12 } }, 'zh');
  assert.equal(degenerateRatios(real).length, 1);
  assert.match(real[0].line, /什么也学不到/);
});

test('a declared thing is not a sample — 0 of 1 focus area still counts', () => {
  // "the one thing you told me to care about did not move" and "the one channel you subscribed cannot
  // receive" are meaningful at a denominator of one; they are counts of declared things, not observations.
  const focus = computeHealthRatios({ focus: { advanced: 0, declared: 1 } }, 'zh');
  assert.equal(degenerateRatios(focus).length, 1);
  const push = computeHealthRatios({ push: { deliverable: 0, active: 1 } }, 'zh');
  assert.equal(degenerateRatios(push).length, 1);
});
