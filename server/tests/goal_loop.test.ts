/**
 * S3 scoreTrajectory — the goal-loop's sense of direction (continue/stop/escalate/switch_engine).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrajectory, DEFAULT_LOOP_CONTRACT, type LoopBodyKind, type TickOutcome } from '../src/goal_loop.js';

const t = (progress: number, bodyKind?: LoopBodyKind, done?: boolean): TickOutcome => ({ progress, bodyKind, done });

test('defaults: switchAfter=2 ≤ stuckAfter=3', () => {
  assert.ok(DEFAULT_LOOP_CONTRACT.switchAfter <= DEFAULT_LOOP_CONTRACT.stuckAfter);
});

test('empty history → continue (just started)', () => {
  assert.equal(scoreTrajectory([]).decision, 'continue');
});

test('last tick done → stop (regardless of flat tail)', () => {
  assert.equal(scoreTrajectory([t(0, 'deep_explore'), t(1, 'deep_explore', true)]).decision, 'stop');
});

test('last tick progressed → continue', () => {
  assert.equal(scoreTrajectory([t(0, 'deep_explore'), t(2, 'deep_explore')]).decision, 'continue');
});

test('1 flat tick after progress → continue (too young to switch)', () => {
  const r = scoreTrajectory([t(2, 'deep_explore'), t(0, 'deep_explore')]);
  assert.equal(r.decision, 'continue');
  assert.equal(r.trend, 'flat');
});

test('2 same-body flat ticks → switch_engine (the P-vs-NP formal+pariGp-settled-0 case)', () => {
  assert.equal(scoreTrajectory([t(0, 'deep_explore'), t(0, 'deep_explore')]).decision, 'switch_engine');
});

test('3 flat ticks → escalate (stuck takes precedence over switch)', () => {
  assert.equal(
    scoreTrajectory([t(0, 'deep_explore'), t(0, 'deep_explore'), t(0, 'deep_explore')]).decision,
    'escalate',
  );
});

test('flat tail spanning 2 body kinds → escalate (already switched, still flat — do not thrash)', () => {
  assert.equal(scoreTrajectory([t(0, 'deep_explore'), t(0, 'research')]).decision, 'escalate');
});

test('score sums net progress; a flat tail after progress is detected', () => {
  const r = scoreTrajectory([t(2, 'deep_explore'), t(-1, 'deep_explore'), t(3, 'deep_explore')]);
  assert.equal(r.score, 4);
  assert.equal(r.decision, 'continue'); // last tick progressed
});
