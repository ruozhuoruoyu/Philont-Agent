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

// The second half, found in the 2026-07-29 log. Only FRESH turns wrote the carry; a pending-auth resume
// read it and left the clock alone. So a long approval chain aged the carry out WHILE THE TASK WAS STILL
// RUNNING:
//
//   12:18:44  fresh "做"  → carry written (goal inherited from the 11:34:43 instruction), ts = 12:18:44
//   12:43 / 12:47 / 12:49  "ok" resumes → carry read, ts untouched
//   12:48:13  judge verdict=could_not_verify basis=llm on the real goal   ← 29.9 min, inside the window
//   12:50:21  judge `skipped (auth resume, original goal not recoverable)` ← 31.6 min, just outside
//
// The mechanism worked and then timed out mid-task. A resume is not a later task; it is the middle of
// this one, so it resets the clock.
const TTL_MS = 30 * 60_000;

test('a resume inside the window keeps the goal — as it did at 12:48:13', () => {
  const carried = { goal: REAL_GOAL, ts: Date.now() - 29 * 60_000 };
  const fresh = Date.now() - carried.ts <= TTL_MS ? carried.goal : undefined;
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, fresh), REAL_GOAL);
});

test('without a clock reset the same chain expires two minutes later — the 12:50:21 skip', () => {
  const carried = { goal: REAL_GOAL, ts: Date.now() - 31.6 * 60_000 };
  const fresh = Date.now() - carried.ts <= TTL_MS ? carried.goal : undefined;
  assert.equal(fresh, undefined, 'aged out');
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, fresh), null);
});

test('a resume that resets the clock keeps the task alive indefinitely while it is being worked', () => {
  // each resume re-stamps ts, so the window measures silence, not elapsed task time
  let carry = { goal: REAL_GOAL, ts: Date.now() - 29 * 60_000 };
  for (const _ of [1, 2, 3]) {
    assert.ok(Date.now() - carry.ts <= TTL_MS, 'still live');
    carry = { ...carry, ts: Date.now() }; // what the resume branch now does
  }
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, carry.goal), REAL_GOAL);
});
