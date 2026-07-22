/**
 * Whether anything the agent found on its own reached the owner — as a number the owner can ask for.
 *
 * Production 2026-07-22: seventeen findings in one hour, every one dropped at gate 1, every drop logged to
 * the console. The owner's report remained "I don't perceive the autonomy at all", because the console is
 * not where they look. The gates are correct and untouched; what was missing is the aggregate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordAutonomyReach,
  autonomyReachSummary,
  renderAutonomyReach,
  _resetAutonomyReachForTest,
} from '../src/autonomy_reach.js';

test('counts findings and how many were eligible to reach the owner', () => {
  _resetAutonomyReachForTest();
  const t = 1_000_000;
  for (let i = 0; i < 17; i++) recordAutonomyReach('curiosity', false, t + i);
  recordAutonomyReach('pursuit', true, t + 100);

  const s = autonomyReachSummary(t + 200);
  assert.equal(s.found, 18);
  assert.equal(s.eligible, 1);
  assert.deepEqual(s.byDriver, { curiosity: 17, pursuit: 1 });
  _resetAutonomyReachForTest();
});

test('events older than 24h fall out of the window', () => {
  _resetAutonomyReachForTest();
  const now = 100 * 24 * 3600_000;
  recordAutonomyReach('curiosity', false, now - 25 * 3600_000);
  recordAutonomyReach('curiosity', false, now - 1000);
  assert.equal(autonomyReachSummary(now).found, 1);
  _resetAutonomyReachForTest();
});

test('a zero-reach hour reads as intended behaviour, not as breakage', () => {
  const line = renderAutonomyReach({ found: 17, eligible: 0, byDriver: { curiosity: 17 } }, 'en');
  assert.match(line, /17/);
  assert.match(line, /0 were important enough/);
  assert.match(line, /intended default/, 'the honest reading must be stated, or the number reads as failure');
  assert.match(line, /tell me what you found/, 'and there must be a way to see them anyway');
});

test('when something did reach them, the reassurance clause is dropped', () => {
  const line = renderAutonomyReach({ found: 4, eligible: 2, byDriver: { pursuit: 4 } }, 'en');
  assert.doesNotMatch(line, /intended default/);
});

test('no findings at all says so plainly', () => {
  assert.match(renderAutonomyReach({ found: 0, eligible: 0, byDriver: {} }, 'zh'), /暂无/);
});
