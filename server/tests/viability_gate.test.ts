/**
 * computeViability unit tests (Phase 18 ViabilityGate — the actuator).
 *
 * Verifies the verdict math: multi-signal accumulation, the progress veto, barrier-needs-stall,
 * and the no-active-session inert path. Pure function, no DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeViability,
  CONTINUATION_PITCH_RE,
  buildViabilityDirective,
  type ViabilityInput,
} from '../src/viability_gate.js';

function base(overrides: Partial<ViabilityInput> = {}): ViabilityInput {
  return {
    hasActiveSession: true,
    barrierApplies: false,
    noProgressRounds: 0,
    status: 'active',
    provedCount: 0,
    openFrontierCount: 3,
    sameRootCause: 0,
    turnCount: 2,
    recommendStop: false,
    madeProgressThisTurn: false,
    ...overrides,
  };
}

test('no active reasoning session → inert (continue)', () => {
  const v = computeViability(base({ hasActiveSession: false, barrierApplies: true, noProgressRounds: 9 }));
  assert.equal(v.verdict, 'continue');
  assert.deepEqual(v.reasons, ['no_active_session']);
});

test('barrier applies but NOT stalled → does not stop (barrier alone is not enough)', () => {
  const v = computeViability(base({ barrierApplies: true, noProgressRounds: 0 }));
  assert.equal(v.verdict, 'continue');
});

test('barrier applies AND stalled ≥3 rounds → stop_and_report (score 3+1=4)', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 3, barrierTitle: 'Parity problem', barrierCircumvention: 'weaken target' }),
  );
  assert.equal(v.verdict, 'stop_and_report');
  assert.ok(v.reasons.includes('barrier_applies_and_stalled'));
  assert.ok(v.reasons.includes('no_progress_rounds'));
  assert.equal(v.recommendedReframe, 'weaken target');
  assert.match(v.evidence, /Parity problem/);
});

test('empty frontier with 0 proved → stop (frontier_empty_no_proof, score 3) needs one more for stop; pivot at 3', () => {
  // status stuck + 0 proved = +3 → that is >= PIVOT(2) but < STOP(4) → pivot
  const v = computeViability(base({ status: 'stuck', provedCount: 0, openFrontierCount: 0 }));
  assert.equal(v.verdict, 'pivot');
  assert.ok(v.reasons.includes('frontier_empty_no_proof'));
});

test('stuck + same_root_cause cluster → stop (3+2=5)', () => {
  const v = computeViability(base({ status: 'stuck', provedCount: 0, sameRootCause: 4 }));
  assert.equal(v.verdict, 'stop_and_report');
});

test('progress this turn vetoes everything → continue', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 5, sameRootCause: 9, recommendStop: true, madeProgressThisTurn: true }),
  );
  assert.equal(v.verdict, 'continue');
  assert.deepEqual(v.reasons, ['progress_this_turn']);
});

test('reflection recommend_stop alone → pivot (score 3), with any stall → stop', () => {
  assert.equal(computeViability(base({ recommendStop: true })).verdict, 'pivot');
  assert.equal(
    computeViability(base({ recommendStop: true, noProgressRounds: 3 })).verdict,
    'stop_and_report',
  );
});

test('healthy long task (proved nodes, advancing) → continue', () => {
  const v = computeViability(base({ turnCount: 30, provedCount: 5, noProgressRounds: 0 }));
  assert.equal(v.verdict, 'continue');
});

test('continuation-pitch regex matches the pitch, not the bare instruction', () => {
  assert.match('要我继续吗？', CONTINUATION_PITCH_RE);
  assert.match('要不要我继续推进第2轮', CONTINUATION_PITCH_RE);
  assert.match('Shall I continue?', CONTINUATION_PITCH_RE);
  assert.match('要我开始吗', CONTINUATION_PITCH_RE);
  // bare instruction "reply 继续 to keep going" must NOT match
  assert.doesNotMatch('回复"继续"我会再跑一轮', CONTINUATION_PITCH_RE);
  assert.doesNotMatch('this round saved the tree', CONTINUATION_PITCH_RE);
});

test('directive forbids the pitch and credits banked lemmas', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 4, barrierTitle: 'Jacobi barrier', barrierCircumvention: 'inject non-sieve input' }),
  );
  const d = buildViabilityDirective(v, { provedCount: 3 });
  assert.match(d, /要我继续吗/);
  assert.match(d, /3 proved lemma/);
  assert.match(d, /inject non-sieve input/);
});
