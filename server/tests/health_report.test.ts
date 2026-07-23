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
  routingRules: { validated: 3, stored: 1094 },
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
      routingRules: { validated: 40, stored: 200 },
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
  assert.match(text, /grows but does not learn/, '3/1094 must be interpreted, not just printed');
  assert.match(text, /silently doing nothing/, 'a broken reference must name the consequence');
  assert.match(text, /worth asking me about/, 'and it must tell the owner what to do with the zeros');
});

test('a subsystem with no activity is omitted rather than reported as 0/0', () => {
  const ratios = computeHealthRatios({ autonomy: { found: 0, eligible: 0 }, judge: { verified: 0, total: 0 } }, 'en');
  assert.equal(ratios.length, 0, '0/0 is not a signal — reporting it as one manufactures noise');
});

test('Chinese rendering carries the same interpretations', () => {
  const text = renderHealthReport(computeHealthRatios(THAT_NIGHT, 'zh'), [], 'zh');
  assert.match(text, /每日自检/);
  assert.match(text, /一件都没动/);
  assert.match(text, /只增不学/);
});
