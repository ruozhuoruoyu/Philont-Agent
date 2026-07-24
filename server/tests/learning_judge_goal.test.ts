/**
 * What the learning judge scores a turn against.
 *
 * Production 2026-07-22: three verdicts in one session, all could_not_verify, one of them saying why in as
 * many words — 'The goal "ok" is too vague to determine what constitutes success'. "ok" was the reply to an
 * authorization card, not the task. The damage is directional: an execute-class tool is precisely what
 * raises an auth card, so the resumed turns are the ones carrying the most tool evidence — the highest
 * signal in the sample, poisoned wholesale. Phase 2 is gated on this distribution being trustworthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJudgeGoal } from '../src/chat-handler.js';

test('a fresh turn is judged against the user message', () => {
  assert.equal(resolveJudgeGoal(undefined, 'extract page 6-20 of the paper', false), 'extract page 6-20 of the paper');
});

test('an auth resume is judged against the ORIGINAL message, not the approval word', () => {
  assert.equal(resolveJudgeGoal('extract page 6-20 of the paper', 'ok', true), 'extract page 6-20 of the paper');
});

test('an auth resume with no recoverable goal emits no verdict at all', () => {
  // A skipped sample is honest. A could_not_verify about the word "ok" is noise that looks like data —
  // and it lands in the same distribution the Phase 2 decision reads.
  assert.equal(resolveJudgeGoal(undefined, 'ok', true), null);
  assert.equal(resolveJudgeGoal('   ', '同意', true), null);
});

test('a carried goal wins even on a fresh turn — it is the more specific signal', () => {
  assert.equal(resolveJudgeGoal('the original task', 'continue', false), 'the original task');
});

test('a fresh turn with no message at all is still judged (scheduled/proactive turns)', () => {
  assert.equal(resolveJudgeGoal(undefined, undefined, false), '');
});

test('a bare continuation word as a FRESH message inherits the last routed goal', () => {
  // 2026-07-24 16:50: 'The goal "ok" is too vague…' — the second production appearance of that exact
  // sentence. The auth-resume fix did not cover "ok" sent as a NEW message.
  assert.equal(resolveJudgeGoal(undefined, 'ok', false, '攻克 Gyárfás 路径染色问题'), '攻克 Gyárfás 路径染色问题');
  assert.equal(resolveJudgeGoal(undefined, '继续', false, 'find a counterexample'), 'find a counterexample');
});

test('a real short message with no session history stays itself', () => {
  assert.equal(resolveJudgeGoal(undefined, '继续', false, undefined), '继续');
});

test('a substantive fresh message is never overridden by history', () => {
  assert.equal(
    resolveJudgeGoal(undefined, '明天早上7点提醒我吃早饭', false, 'some older goal'),
    '明天早上7点提醒我吃早饭',
  );
});
