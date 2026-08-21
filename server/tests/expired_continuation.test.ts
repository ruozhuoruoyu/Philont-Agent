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

test('a delayed inbound cannot approve an authorization card delivered after it was sent', async () => {
  const { inboundPredatesAuthDelivery } = await import('../src/chat-handler.js');
  const deliveredAt = Date.UTC(2026, 7, 21, 7, 4, 36);
  assert.equal(inboundPredatesAuthDelivery({ deliveredAt }, deliveredAt - 10 * 60_000), true);
  assert.equal(inboundPredatesAuthDelivery({ deliveredAt }, deliveredAt), false);
  assert.equal(inboundPredatesAuthDelivery({ deliveredAt }, deliveredAt + 1), false);
  assert.equal(inboundPredatesAuthDelivery({}, deliveredAt - 1), false, 'no delivery receipt means no timestamp claim');
});

test('failed delivery or a pre-card inbound bypasses auth without dropping the pending card', async () => {
  const { pendingAuthInboundDisposition, selectTurnContextSource } = await import('../src/chat-handler.js');
  const auth = { ts: NOW - MIN, executionState: 'awaiting_auth' as const };

  const failed = pendingAuthInboundDisposition({ deliveryState: 'failed' }, NOW);
  assert.equal(failed, 'bypass_undelivered');
  assert.deepEqual(selectTurnContextSource(auth, undefined, NOW, failed !== 'resume'), {
    source: 'fresh', dropAuth: false,
  });

  const delayed = pendingAuthInboundDisposition({ deliveryState: 'delivered', deliveredAt: NOW }, NOW - 1);
  assert.equal(delayed, 'bypass_predelivery');
  assert.deepEqual(selectTurnContextSource(auth, undefined, NOW, delayed !== 'resume'), {
    source: 'fresh', dropAuth: false,
  });
});

test('a message sent before askUserQuestion uses fresh context without deleting the question', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  assert.deepEqual(
    selectTurnContextSource(undefined, { createdAt: NOW }, NOW, false, true),
    { source: 'fresh', dropAuth: false },
  );
});

test('production orders delivery disposition before context selection and auth intent classification', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const dispositionAt = source.indexOf('const authInboundDisposition = pendingAuthInboundDisposition(');
  const contextAt = source.indexOf('const turnContext = selectTurnContextSource(', dispositionAt);
  const authBlockAt = source.indexOf('pendingAuthBlock:', contextAt);
  const classifierAt = source.indexOf('await classifyAuthIntent(userMessage, context)', authBlockAt);
  assert.ok(dispositionAt >= 0 && dispositionAt < contextAt, 'bypass is decided before message context is built');
  assert.ok(contextAt < authBlockAt && authBlockAt < classifierAt, 'bypassed inbound cannot reach auth classifier first');
});

// ── the ORDERING, not just the predicate ────────────────────────────────────────────────────────
// The earlier version of this file proved pendingAuthIsStale() computed the right answer and stopped
// there — which would stay green if someone moved the drop back below the message build, i.e. if the
// actual defect were reintroduced. selectTurnContextSource is what the message array is built from,
// and it re-derives staleness itself, so this pins the property rather than the arithmetic.

test('an expired pending is never the source of a turn context, whatever else moves', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  const expired = { ts: NOW - 58 * MIN, executionState: 'awaiting_auth' as const };
  assert.deepEqual(selectTurnContextSource(expired, undefined, NOW), { source: 'fresh', dropAuth: true });
});

test('a live pending still resumes into its own inflight messages', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  const live = { ts: NOW - 5 * MIN, executionState: 'awaiting_auth' as const };
  assert.deepEqual(selectTurnContextSource(live, undefined, NOW), { source: 'auth-inflight', dropAuth: false });
});

test('an interrupted call keeps its context at any age — that is what retry/skip resumes into', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  const stuck = { ts: NOW - 600 * MIN, executionState: 'uncertain' as const };
  assert.deepEqual(selectTurnContextSource(stuck, undefined, NOW), { source: 'auth-inflight', dropAuth: false });
});

test('dropping an expired auth does not steal a live question its context', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  const expired = { ts: NOW - 58 * MIN, executionState: 'awaiting_auth' as const };
  assert.deepEqual(
    selectTurnContextSource(expired, { createdAt: NOW - MIN }, NOW),
    { source: 'question-inflight', dropAuth: true },
  );
});

test('no suspended state at all → fresh', async () => {
  const { selectTurnContextSource } = await import('../src/chat-handler.js');
  assert.deepEqual(selectTurnContextSource(undefined, undefined, NOW), { source: 'fresh', dropAuth: false });
});

// ── an unresolved call is not a decision ────────────────────────────────────────────────────────

test('closing a chain answers every suspended tool_use exactly once', async () => {
  const { closeSuspendedToolChain } = await import('../src/chat-handler.js');
  const pending = {
    toolCallId: 'call-a',
    remainingCalls: [{ id: 'call-b' }, { id: 'call-c' }],
    collectedResults: [{ type: 'tool_result' as const, tool_use_id: 'call-earlier', content: '✓' }],
  };
  for (const reason of ['declined', 'unresolved'] as const) {
    const results = closeSuspendedToolChain(pending, reason);
    const ids = results.map((r) => r.tool_use_id);
    assert.deepEqual(ids, ['call-earlier', 'call-a', 'call-b', 'call-c'], reason);
    assert.equal(new Set(ids).size, ids.length, `${reason}: no duplicate tool_result`);
  }
});

test('running out the recovery bound must not be reported as the user declining', async () => {
  const { closeSuspendedToolChain } = await import('../src/chat-handler.js');
  const pending = { toolCallId: 'call-a', remainingCalls: [], collectedResults: [] };

  const unresolved = closeSuspendedToolChain(pending, 'unresolved')[0]!.content;
  // The whole point: three "继续"s are not a refusal, and the model must not be told they were.
  // (The text may TELL the model not to say it — what it must never do is assert it.)
  assert.doesNotMatch(unresolved, /user (?:explicitly )?(?:chose|declined|decided)\b(?! it)/i);
  assert.match(unresolved, /do not say that the user declined it/i);
  assert.match(unresolved, /NO explicit .*decision was ever received/i);
  assert.match(unresolved, /nobody decided/i);
  assert.match(unresolved, /will not be replayed/i);

  const declined = closeSuspendedToolChain(pending, 'declined')[0]!.content;
  assert.match(declined, /user\s+explicitly chose not to retry/i);

  assert.notEqual(unresolved, declined);
});
