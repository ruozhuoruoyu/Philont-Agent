/**
 * S4 — trait-tuned contracts + drives→goals promotion (pure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traitTunedContract, shouldPromoteToGoal, DEFAULT_TRAITS } from '../src/drives_to_goals.js';
import { DEFAULT_LOOP_CONTRACT } from '../src/goal_loop.js';

test('traitTunedContract: 好胜 → more rounds + higher stuck threshold (but stuck > switch)', () => {
  const low = traitTunedContract({ ...DEFAULT_TRAITS, competitiveness: 0 });
  const high = traitTunedContract({ ...DEFAULT_TRAITS, competitiveness: 1 });
  assert.ok((high.budget.rounds ?? 0) > (low.budget.rounds ?? 0), 'more competitive → more rounds');
  assert.ok(high.stuckAfter > low.stuckAfter, 'more competitive → tries longer before stuck');
  // switch-engine must still fire before "stuck" at every competitiveness level.
  for (const c of [0, 0.5, 1]) {
    const k = traitTunedContract({ ...DEFAULT_TRAITS, competitiveness: c });
    assert.ok(k.stuckAfter > DEFAULT_LOOP_CONTRACT.switchAfter, `stuck(${k.stuckAfter}) > switch at comp=${c}`);
  }
});

test('traitTunedContract: 尽责 → louder REPORT', () => {
  assert.equal(traitTunedContract({ ...DEFAULT_TRAITS, conscientiousness: 0.9 }).reportEvery, 'milestone');
  assert.equal(traitTunedContract({ ...DEFAULT_TRAITS, conscientiousness: 0.1 }).reportEvery, 'stuck-only');
});

test('traitTunedContract: clamps out-of-range / NaN trait values', () => {
  const k = traitTunedContract({ competitiveness: 99, curiosity: -5, conscientiousness: NaN });
  assert.ok((k.budget.rounds ?? 0) >= 1);
  assert.equal(k.reportEvery, 'stuck-only'); // NaN → 0 → < 0.5
});

test('shouldPromoteToGoal: only sustained, high-stake, OPEN-ENDED interest becomes a goal', () => {
  const open = (over = {}) => ({ stake: 0.8, recurrence: 3, openEnded: true, ...over });
  assert.equal(shouldPromoteToGoal(open()), true);
  assert.equal(shouldPromoteToGoal(open({ openEnded: false })), false, 'a single lookup is not a goal');
  assert.equal(shouldPromoteToGoal(open({ stake: 0.3 })), false, 'low stake → no');
  assert.equal(shouldPromoteToGoal(open({ recurrence: 1 })), false, 'one-off (default curiosity) → no');
});

test('shouldPromoteToGoal: 好奇 lowers the recurrence bar (commit to a theme sooner)', () => {
  const fire = { stake: 0.8, recurrence: 1, openEnded: true };
  assert.equal(shouldPromoteToGoal(fire, { ...DEFAULT_TRAITS, curiosity: 1 }), true, 'very curious → commits at recurrence 1');
  assert.equal(shouldPromoteToGoal(fire, { ...DEFAULT_TRAITS, curiosity: 0 }), false, 'incurious → needs more recurrence');
});
