/**
 * Unsatisfiable scheduled goals (2026-07-21).
 *
 * A schedule was created with the goal "MycoX check-in routine (including logging to
 * memory/YYYY-MM-DD.md)". Unattended turns may not call writeFile, so every run was blocked at the
 * same step and correctly judged a failure — fourteen consecutive runs, and the only trace was one
 * warn line per run. Two halves are pinned here:
 *   - the capability now exists (appendJournal, and it is not blacklisted), so the goal is reachable;
 *   - when a goal is still unreachable, the mechanism says so out loud instead of failing forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTONOMOUS_TURN_BLACKLIST_HARDCODED,
  autonomousBlacklistReason,
  blockedToolSignature,
  detectUnsatisfiableGoal,
} from '../src/chat-handler.js';

const run = (...sigs: string[]) => ({ failureSignatures: sigs });
const WRITE = blockedToolSignature('writeFile');

test('appendJournal is available to unattended turns; writeFile still is not', () => {
  assert.equal(AUTONOMOUS_TURN_BLACKLIST_HARDCODED.has('writeFile'), true, 'the shared filesystem stays closed');
  assert.equal(AUTONOMOUS_TURN_BLACKLIST_HARDCODED.has('shell'), true);
  assert.equal(
    AUTONOMOUS_TURN_BLACKLIST_HARDCODED.has('appendJournal'),
    false,
    'the replacement capability must actually be callable, or nothing changed',
  );
});

test('the rejection message names a tool that exists — the whole point of the fix', () => {
  const msg = autonomousBlacklistReason('writeFile');
  assert.match(msg, /appendJournal/, 'must point at the supported replacement, not just refuse');
  assert.match(msg, /store_note/, 'and still offer the hand-to-user channel');
  assert.match(msg, /writeFile/, 'and name what was blocked');
});

test('both interception sites use the one message — they had already drifted apart', () => {
  // The prod pair was one English and one Chinese, written separately. Same failure shape as the
  // plan-loop defs/runner split: two copies of a rule, only one of which gets maintained.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const uses = src.match(/autonomousBlacklistReason\(call\.name\)/g) ?? [];
  assert.equal(uses.length, 2, 'both blacklist sites must call the shared builder');
});

test('detect: a block that repeats across runs crosses the threshold exactly once', () => {
  // Runs 1 and 2 — same block, but not yet enough to call it structural.
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], []), []);
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], [run(WRITE)]), []);
  // Run 3 — third occurrence in the window: report.
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], [run(WRITE), run(WRITE)]), [WRITE]);
  // Run 4 and beyond — still broken, but a human who has been told once does not need telling again.
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], [run(WRITE), run(WRITE), run(WRITE)]), []);
});

test('detect: an incidental block is not a structural one', () => {
  // Blocked once long ago, clean since → not reported. Only a block that keeps recurring means the
  // goal itself is unreachable, as opposed to the model having reached for the wrong tool once.
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], [run(), run(), run(WRITE)]), []);
  // Not blocked this run → nothing to report even if history is full of it.
  assert.deepEqual(detectUnsatisfiableGoal([], [run(WRITE), run(WRITE), run(WRITE)]), []);
});

test('detect: http failure signatures never masquerade as a blocked tool', () => {
  // failureSignatures is a shared column; the namespace keeps the two kinds apart.
  assert.equal(WRITE, 'blocked:writeFile');
  assert.deepEqual(
    detectUnsatisfiableGoal([WRITE], [run('http:http-401', 'http:other:post'), run('http:http-401')]),
    [],
  );
});

test('detect: each blocked tool is tracked on its own clock', () => {
  const shell = blockedToolSignature('shell');
  const crossed = detectUnsatisfiableGoal([WRITE, shell], [run(WRITE, shell), run(WRITE)]);
  assert.deepEqual(crossed, [WRITE], 'writeFile hit 3; shell only 2');
});

test('detect: the window is bounded — an ancient block does not accumulate forever', () => {
  // Window 5 ⇒ this run plus the previous 4. A 3rd occurrence that falls outside cannot be counted.
  const prior = [run(), run(), run(), run(WRITE), run(WRITE)];
  assert.deepEqual(detectUnsatisfiableGoal([WRITE], prior), []);
});
