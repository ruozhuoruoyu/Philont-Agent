/**
 * 2026-08-04 20:39:33, `durationMs=1200011` — a real deadline on a live process, not a suspended host.
 * The owner had said 继续lrc证明 and approved it. After the z3 version check at 20:19:35 the turn ran for
 * twenty minutes, made ZERO further tool calls, and delivered a 46-character error. Everything it had
 * worked out went with it, and there was nothing to continue from.
 *
 * Two independent defects, and fixing either one alone changes nothing:
 *
 *   1. The clock had no graceful exit. Running out of ITERATIONS falls through to a forced summary that
 *      narrates what was tried; running out of TIME threw TurnDeadlineError from a Promise.race at the
 *      top of the turn and discarded the lot. Two ways to run out, one way to end well.
 *
 *   2. The loop can only check its watch at the top of the loop, and control did not come back for
 *      twenty minutes. The per-call timeout is adaptive (30s + 4096 tokens x 100ms = 439.6s) and
 *      sendLlmWithRescue retries once on timeout, so one logical call may occupy 14.6 minutes of a
 *      20-minute turn. Neither number is wrong alone; they were chosen in different files with no
 *      reference to each other, and nothing derived either from what the TURN had left.
 *
 * Honest limit on the diagnosis: the log holds no `[llm] timeout` line for that turn, so nothing actually
 * exceeded the per-call timeout — several calls were each merely slow, and not one of their durations was
 * recorded anywhere. That gap is why `[llm] slow call` now exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmCallBudgetMs, hasRoomForTimeoutRetry, turnRemainingMs } from '../src/chat-handler.js';

const MIN = 60_000;
const CALL_TIMEOUT = 439_600; // the production adaptive value

test('early in a turn the call keeps its full timeout', () => {
  assert.equal(llmCallBudgetMs(18 * MIN, CALL_TIMEOUT), CALL_TIMEOUT);
});

// The point of the whole change: a call started late must END before the hard deadline, so the loop gets
// control back and can spend what is left writing a reply.
test('late in a turn the call is cut to fit what the turn has left', () => {
  const remaining = 5 * MIN;
  const budget = llmCallBudgetMs(remaining, CALL_TIMEOUT);
  assert.ok(budget < CALL_TIMEOUT, 'must not be allowed to outlive the turn');
  assert.ok(budget < remaining, 'must return before the deadline, not exactly on it');
});

test('the budget never collapses to something unanswerable', () => {
  assert.ok(llmCallBudgetMs(1000, CALL_TIMEOUT) >= 45_000, 'a 1-second budget is the same as no call');
  assert.ok(llmCallBudgetMs(-5 * MIN, CALL_TIMEOUT) >= 45_000, 'even past the deadline');
});

test('background callers with no turn are unaffected', () => {
  assert.equal(llmCallBudgetMs(Number.POSITIVE_INFINITY, CALL_TIMEOUT), CALL_TIMEOUT);
  assert.equal(turnRemainingMs('system:scheduled:nope'), Number.POSITIVE_INFINITY);
  assert.equal(hasRoomForTimeoutRetry(Number.POSITIVE_INFINITY), true);
});

// The retry is what turns one slow call into 14.6 minutes. It is the first thing to give up.
test('the timeout retry is refused when the turn cannot afford a full attempt', () => {
  assert.equal(hasRoomForTimeoutRetry(10 * MIN), true);
  assert.equal(hasRoomForTimeoutRetry(60_000), false, 'one minute left is for the reply, not another wait');
  assert.equal(hasRoomForTimeoutRetry(0), false);
  assert.equal(hasRoomForTimeoutRetry(-MIN), false);
});

// The arithmetic that killed the turn, stated as a property: whatever the call timeout is, a call that
// STARTS inside the turn must not be able to finish outside it.
test('no call can outlive the turn, at any elapsed time', () => {
  for (let elapsedMin = 0; elapsedMin <= 20; elapsedMin += 1) {
    const remaining = (20 - elapsedMin) * MIN;
    const budget = llmCallBudgetMs(remaining, CALL_TIMEOUT);
    if (remaining <= 45_000) continue; // the floor deliberately wins here; the hard deadline is the backstop
    assert.ok(
      budget <= remaining,
      `at ${elapsedMin} min elapsed a ${Math.round(budget / 1000)}s call would run past the deadline`,
    );
  }
});

test('a shorter configured call timeout is still respected', () => {
  assert.equal(llmCallBudgetMs(18 * MIN, 60_000), 60_000, 'the budget only ever shrinks a call');
});
