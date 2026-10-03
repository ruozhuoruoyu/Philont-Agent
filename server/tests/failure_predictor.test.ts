/**
 * failure_predictor unit tests.
 *
 *  (a) mode flag: default shadow, explicit off values
 *  (b) streak features follow the offline definition (fails in last 5 / last 20, last same-tool failed)
 *  (c) learning: on a synthetic ledger where failures cluster (a tool fails in streaks), the predictor's
 *      AUROC on the second half beats the per-tool base rate, and p_fail rises inside a streak
 *  (d) observe() records a shadow pair to the sink and advances state; predict() does not advance state
 *  (e) a cold tool is flagged and gets a finite probability
 *  (f) auroc(): perfect ranking → 1, inverted → 0, one class → null
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FailurePredictor, auroc, failurePredictorMode, type ShadowRecord } from '../src/failure_predictor.js';

function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

test('mode: default shadow; 0/off/false/no → off', () => {
  withEnv('PHILONT_FAILURE_PREDICTOR', undefined, () => assert.equal(failurePredictorMode(), 'shadow'));
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withEnv('PHILONT_FAILURE_PREDICTOR', v, () => assert.equal(failurePredictorMode(), 'off'));
  }
  withEnv('PHILONT_FAILURE_PREDICTOR', 'shadow', () => assert.equal(failurePredictorMode(), 'shadow'));
});

test('streak features: fails in last 5 / last 20, last same-tool failed', () => {
  const p = new FailurePredictor();
  // 20 outcomes: tool A fails on the last 3, tool B always succeeds
  for (let i = 0; i < 17; i++) p.observe('B', true);
  p.observe('A', false);
  p.observe('A', false);
  p.observe('A', false);
  assert.deepEqual(p.streak('A'), { fails5: 3, fails20: 3, lastSameToolFailed: true });
  assert.deepEqual(p.streak('B'), { fails5: 3, fails20: 3, lastSameToolFailed: false });
  assert.equal(p.examples, 20);
});

/** Synthetic ledger: failures come in streaks (a tool enters a failing regime for a while). */
function syntheticLedger(n: number, seed = 7): { toolName: string; success: boolean }[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const tools = ['shell', 'http', 'readFile', 'pariGp'];
  const rows: { toolName: string; success: boolean }[] = [];
  let failing = false;
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.05) failing = !failing; // regime flips rarely
    const tool = tools[Math.floor(rnd() * tools.length)];
    const pFail = failing ? 0.6 : 0.05;
    rows.push({ toolName: tool, success: rnd() >= pFail });
  }
  return rows;
}

test('learning: AUROC on the second half beats the per-tool base rate; p_fail rises inside a streak', () => {
  const rows = syntheticLedger(3000);
  const half = Math.floor(rows.length / 2);
  const p = new FailurePredictor();
  p.warmStart(rows.slice(0, half));
  // Base-rate comparator: P(fail | tool) from the first half.
  const base = new Map<string, { f: number; n: number }>();
  for (const r of rows.slice(0, half)) {
    const b = base.get(r.toolName) ?? { f: 0, n: 0 };
    b.f += r.success ? 0 : 1;
    b.n++;
    base.set(r.toolName, b);
  }
  const predRecords: { pFail: number; failed: boolean }[] = [];
  const baseRecords: { pFail: number; failed: boolean }[] = [];
  for (const r of rows.slice(half)) {
    const pr = p.predict(r.toolName);
    predRecords.push({ pFail: pr.pFail, failed: !r.success });
    const b = base.get(r.toolName) ?? { f: 1, n: 2 };
    baseRecords.push({ pFail: b.f / b.n, failed: !r.success });
    p.observe(r.toolName, r.success, pr);
  }
  const a = auroc(predRecords)!;
  const b = auroc(baseRecords)!;
  assert.ok(a > 0.7, `predictor AUROC ${a.toFixed(3)} should exceed 0.7 (synthetic regimes flip every ~20 calls, so streak information is partial)`);
  assert.ok(a > b + 0.1, `predictor ${a.toFixed(3)} should beat base rate ${b.toFixed(3)} by > 0.1`);

  // Inside a streak p_fail is higher than after a clean run, for the same tool.
  const q = new FailurePredictor();
  q.warmStart(rows);
  for (let i = 0; i < 20; i++) q.observe('shell', true);
  const calm = q.predict('shell').pFail;
  for (let i = 0; i < 5; i++) q.observe('shell', false);
  const streak = q.predict('shell').pFail;
  assert.ok(streak > calm, `p_fail in a streak (${streak.toFixed(3)}) should exceed calm (${calm.toFixed(3)})`);
});

test('observe records a shadow pair and advances; predict does not advance', () => {
  const got: ShadowRecord[] = [];
  const p = new FailurePredictor({ sink: (r) => got.push(r) });
  const before = p.predict('shell');
  const again = p.predict('shell');
  assert.deepEqual(before.features, again.features, 'predict() must be pure w.r.t. streak state');
  assert.equal(p.examples, 0);
  p.observe('shell', false, before, 'sess-1');
  assert.equal(got.length, 1);
  assert.equal(got[0].toolName, 'shell');
  assert.equal(got[0].failed, true);
  assert.equal(got[0].sessionId, 'sess-1');
  assert.ok(got[0].pFail > 0 && got[0].pFail < 1);
  assert.equal(p.examples, 1);
  assert.equal(p.streak('shell').lastSameToolFailed, true);
});

test('cold tool: flagged, finite probability, then learns a slot', () => {
  const p = new FailurePredictor();
  const first = p.predict('neverSeenTool');
  assert.equal(first.coldTool, true);
  assert.ok(Number.isFinite(first.pFail) && first.pFail > 0 && first.pFail < 1);
  const second = p.predict('neverSeenTool');
  assert.equal(second.coldTool, false);
});

test('auroc: perfect → 1, inverted → 0, single class → null, ties averaged', () => {
  assert.equal(auroc([{ pFail: 0.9, failed: true }, { pFail: 0.1, failed: false }]), 1);
  assert.equal(auroc([{ pFail: 0.1, failed: true }, { pFail: 0.9, failed: false }]), 0);
  assert.equal(auroc([{ pFail: 0.5, failed: true }, { pFail: 0.5, failed: true }]), null);
  assert.equal(auroc([{ pFail: 0.5, failed: true }, { pFail: 0.5, failed: false }]), 0.5);
});
