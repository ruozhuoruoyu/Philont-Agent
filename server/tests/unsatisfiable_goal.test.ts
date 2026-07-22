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
  JUDGE_GOAL_UNMET_SIGNATURE,
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

// ── The detector had the very defect it was built to fix (2026-07-22) ───────────────────────────
//
// It only ever saw a goal fail through a BLOCKED TOOL CALL. Once appendJournal shipped, the model
// stopped calling writeFile, no `blocked:` signature was produced, and the detector fell silent — while
// the goal ("log to memory/YYYY-MM-DD.md") stayed just as unreachable and the judge said so every run:
// "appended a journal entry but the goal requires logging to memory/YYYY-MM-DD.md, not journal/".
// A model that learns to work AROUND an impossible requirement makes it invisible to a detector that
// watches only for the collision.
const UNMET = JUDGE_GOAL_UNMET_SIGNATURE;

test('a goal the model works AROUND is still detected', () => {
  // No tool was ever blocked; the runs look clean. Only the judge dissents, run after run.
  assert.deepEqual(detectUnsatisfiableGoal([UNMET], [run(UNMET), run(UNMET)]), [UNMET]);
});

test('the two kinds are counted independently', () => {
  // A schedule can be blocked on a tool AND separately failing to satisfy its goal; each has its own clock.
  const crossed = detectUnsatisfiableGoal([WRITE, UNMET], [run(WRITE, UNMET), run(UNMET)]);
  assert.deepEqual(crossed, [UNMET], 'goal-unmet hit 3; the block only 2');
});

test('the threshold is a RATE, not a streak — one confirmed run does not excuse the rest', () => {
  // The carry is cleared on a confirmed run, so that row simply lacks the signature. But "3 of the last
  // 5" is deliberately a rate: a schedule that meets its goal one run in three is still not working, and
  // requiring an unbroken streak would let exactly that hide forever.
  assert.deepEqual(detectUnsatisfiableGoal([UNMET], [run(UNMET), run(), run(UNMET)]), [UNMET]);
});

test('runs the judge confirms DO push it back under the threshold', () => {
  assert.deepEqual(detectUnsatisfiableGoal([UNMET], [run(), run(), run(UNMET)]), []);
  assert.deepEqual(detectUnsatisfiableGoal([UNMET], [run(), run(), run(), run()]), []);
});

test('the judge signature cannot collide with a tool name', () => {
  assert.equal(UNMET, 'judge:goal_unmet');
  assert.notEqual(UNMET, blockedToolSignature('goal_unmet'));
});
