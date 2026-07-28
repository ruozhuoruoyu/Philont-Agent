/**
 * Why the learning judge kept saying `skipped (auth resume, original goal not recoverable)`.
 *
 * carriedIntent is the only surviving record of what a session is working on once an authorization card
 * splits a task across turns. It was overwritten by EVERY fresh turn, including the one-word ones — and
 * a WeChat conversation is mostly one-word turns: 同意 / ok / 继续 / B.
 *
 * Prod 2026-07-28: "同意" at 14:49:42 replaced the real goal. The two turns that followed did 65s and
 * 453s of real work — 19 tool calls, pariGp, z3Verify, a completed k=4 enumeration — and both were logged
 * `skipped (original goal not recoverable)`. resolveJudgeGoal was doing its job: it refuses a 2-character
 * goal, because judging "did this turn achieve 同意?" is how the judge ended up writing 'The goal "ok" is
 * too vague to determine what constitutes success'. The floor was right; the thing it was reading had
 * already been destroyed upstream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJudgeGoal } from '../src/chat-handler.js';
import { messageIsSelfContainedGoal } from '../src/intent_router.js';

const REAL_GOAL = '继续推进 LRC 的阈值速度集分类，先把 k=5 跑完';

test('the continuation words a WeChat conversation is made of are not goals', () => {
  for (const word of ['同意', 'ok', 'OK', '继续', 'B', '执行', '换个角度']) {
    assert.equal(messageIsSelfContainedGoal(word), false, `"${word}" must not overwrite the goal`);
  }
});

test('a real instruction still counts as a goal and does overwrite', () => {
  assert.equal(messageIsSelfContainedGoal(REAL_GOAL), true);
});

// The carry rule itself, as applied at the write site: substantive messages replace the goal, everything
// else inherits it. Expressed here so the rule is pinned even though the map lives inside the handler.
const carryGoal = (incoming: string, prior?: string): string =>
  messageIsSelfContainedGoal(incoming) ? incoming : (prior ?? incoming);

test('a one-word approval inherits the goal instead of erasing it', () => {
  assert.equal(carryGoal('同意', REAL_GOAL), REAL_GOAL);
  assert.equal(carryGoal('ok', REAL_GOAL), REAL_GOAL);
  assert.equal(carryGoal('B', REAL_GOAL), REAL_GOAL);
});

test('with the goal preserved, the auth-resume turn is judged instead of skipped', () => {
  const carried = carryGoal('同意', REAL_GOAL);
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, carried), REAL_GOAL);
});

test('the pre-fix sequence is exactly what produced the skip', () => {
  // "同意" overwrote the goal, so the resume had a 2-character goal to work with …
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, '同意'), null);
  // … and refusing it was correct: the 12-char floor is what stops "did this turn achieve ok?".
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, 'ok'), null);
});

test('a session with no prior goal at all still keeps today’s behaviour', () => {
  assert.equal(carryGoal('同意', undefined), '同意');
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, '同意'), null);
});
