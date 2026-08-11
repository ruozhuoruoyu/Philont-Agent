/**
 * Why `[llm-adapter] tool_result pairing repair: missing=2` only ever appeared on LATE replies.
 *
 * Production 2026-08-09: the repair fired exactly twice, at 09:09:46 and 12:43:29 — the only two auth
 * resumes that arrived after the pending TTL (58 min and 35.6 min). Every resume inside the window was
 * clean. `missing=2` was literally the suspended call plus its one queued sibling: expiry was checked
 * AFTER the message array had already been seeded from pending.inflightMessages, so an expired pending
 * still handed the turn two assistant tool_use blocks that nothing would ever answer.
 *
 * The first of those two turns then spent 224s in the model and emitted `writeFile({})`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuationSurvivesRestart, classifyUncertainToolReply } from '../src/chat-handler.js';

const NOW = 1_786_229_362_000;
const MIN = 60_000;

test('a merely-waiting auth snapshot does not outlive its window', () => {
  const stored = { savedAt: NOW - 58 * MIN, auth: { ts: NOW - 58 * MIN, executionState: 'awaiting_auth' } };
  assert.equal(continuationSurvivesRestart(stored, NOW).auth, false);
});

test('a fresh auth snapshot is restored', () => {
  const stored = { savedAt: NOW - 5 * MIN, auth: { ts: NOW - 5 * MIN, executionState: 'awaiting_auth' } };
  assert.equal(continuationSurvivesRestart(stored, NOW).auth, true);
});

test('a snapshot that was RUNNING survives at any age — a side effect may already have committed', () => {
  for (const age of [1, 58, 60 * 24]) {
    const stored = { savedAt: NOW - age * MIN, auth: { ts: NOW - age * MIN, executionState: 'running' } };
    assert.equal(continuationSurvivesRestart(stored, NOW).auth, true, `age=${age}m`);
  }
  const uncertain = { savedAt: NOW - 500 * MIN, auth: { ts: NOW - 500 * MIN, executionState: 'uncertain' } };
  assert.equal(continuationSurvivesRestart(uncertain, NOW).auth, true);
});

test('an auth snapshot with no executionState (written before that field existed) still expires', () => {
  const stored = { savedAt: NOW - 40 * MIN, auth: { ts: NOW - 40 * MIN } };
  assert.equal(continuationSurvivesRestart(stored, NOW).auth, false);
});

test('question snapshots expire on their own clock', () => {
  assert.equal(continuationSurvivesRestart({ question: { createdAt: NOW - 30 * MIN } }, NOW).question, false);
  assert.equal(continuationSurvivesRestart({ question: { createdAt: NOW - 3 * MIN } }, NOW).question, true);
});

test('the two halves are decided independently', () => {
  const stored = {
    savedAt: NOW,
    auth: { ts: NOW - 90 * MIN, executionState: 'awaiting_auth' },
    question: { createdAt: NOW - MIN },
  };
  assert.deepEqual(continuationSurvivesRestart(stored, NOW), { auth: false, question: true });
});

// ── the interrupted-tool question must be answerable by a person ────────────────────────────────

test('the offered words are still matched exactly, with their natural tails', () => {
  for (const reply of ['重试', '重试吧', '重新执行', 'retry', 'RETRY.', 'run again']) {
    assert.equal(classifyUncertainToolReply(reply), 'retry', reply);
  }
  for (const reply of ['跳过', '跳过这个', '不要重试', 'skip', 'do not retry']) {
    assert.equal(classifyUncertainToolReply(reply), 'skip', reply);
  }
});

test('"不要重试" is a skip even though it contains "重试"', () => {
  assert.equal(classifyUncertainToolReply('不要重试'), 'skip');
  assert.equal(classifyUncertainToolReply('不重试了'), 'skip');
});

test('anything else stays unknown — the escape hatch is a bound, not a looser matcher', () => {
  for (const reply of ['继续', 'OK', '看看情况', 'is it safe?', 'retry maybe']) {
    assert.equal(classifyUncertainToolReply(reply), 'unknown', reply);
  }
});

// ── the same predicate the turn actually uses ───────────────────────────────────────────────────
// Pinned here rather than re-expressed: a rule restated in a test is a rule the production path can
// drift away from silently (the carried-goal test did exactly that while the code it described was
// dead for weeks).

test('pendingAuthIsStale: the two production resumes that repaired pairing are the stale ones', async () => {
  const { pendingAuthIsStale } = await import('../src/chat-handler.js');
  // 2026-08-09 resume gaps, in minutes, and whether missing=2 was logged for that resume.
  const resumes: Array<[number, boolean]> = [
    [8.6, false], [8.6, false], [58, true], [8.2, false], [35.6, true], [0.5, false], [0.2, false],
  ];
  for (const [gapMin, repaired] of resumes) {
    const pending = { ts: NOW - gapMin * MIN, executionState: 'awaiting_auth' as const };
    assert.equal(pendingAuthIsStale(pending, NOW), repaired, `${gapMin} min resume`);
  }
});

test('pendingAuthIsStale: an in-flight or unresolved call is never aged out', async () => {
  const { pendingAuthIsStale } = await import('../src/chat-handler.js');
  assert.equal(pendingAuthIsStale({ ts: NOW - 600 * MIN, executionState: 'running' }, NOW), false);
  assert.equal(pendingAuthIsStale({ ts: NOW - 600 * MIN, executionState: 'uncertain' }, NOW), false);
  assert.equal(pendingAuthIsStale(undefined, NOW), false);
});
