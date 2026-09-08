/**
 * Forced-continue decision (#2): shouldForceDeepExploreAdvance — pure truth table.
 *
 * The mechanism that guarantees a real deep_explore(action=continue) when the model recites round
 * results without running a round. Only the decision is unit-tested here; the synthetic-tool-call
 * injection itself is exercised by the full turn loop. chat-handler opens a DB at import time, so
 * MEMORY_DB_PATH=':memory:' must be set first and the file run with --test-force-exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEMORY_DB_PATH = ':memory:';
process.env.LLM_PROVIDER = '';

const { shouldForceDeepExploreAdvance, userAsksExploreStatus } = await import('../src/chat-handler.js');

test('forced controller respects exhausted budget and tool block before injecting calls', async () => {
  const { memory, decideForcedDeepExploreCall } = await import('../src/chat-handler.js');
  const owner = 'forced-budget-regression';
  const { session } = memory.reasoning.createSession({ goal: 'test', ownerSessionId: owner });
  const bus = {
    intentDecision: { route: 'deep_explore' as const, confidence: 0.9, reason: 'continue', continuous: true },
    userMessage: '继续',
  };
  memory.reasoning.addBudgetSpent(session.id, 1_000_000_000);
  for (let i = 0; i < 5; i++) {
    assert.equal(await decideForcedDeepExploreCall(owner, '', bus, i), null);
  }
  const blockedOwner = 'forced-blocked-regression';
  memory.reasoning.createSession({ goal: 'test', ownerSessionId: blockedOwner });
  assert.equal(await decideForcedDeepExploreCall(blockedOwner, '', {
    ...bus, blockedTools: new Set(['deep_explore']),
  }, 6), null);
});

test('failed forced auto_on is attempted once even after records are compacted away', async () => {
  const { memory, decideForcedDeepExploreCall } = await import('../src/chat-handler.js');
  const owner = 'forced-auto-on-once';
  memory.reasoning.createSession({ goal: 'test', ownerSessionId: owner });
  const bus = {
    intentDecision: { route: 'deep_explore' as const, confidence: 0.9, reason: 'continue', continuous: true },
    forcedDeepExploreContinue: true,
    inTurnRecords: [{ toolName: 'deep_explore', toolInput: { action: 'continue' }, success: true, resultText: 'round finished' }],
  };
  assert.equal((await decideForcedDeepExploreCall(owner, '', bus, 1))?.input.action, 'auto_on');
  assert.equal(await decideForcedDeepExploreCall(owner, '', bus, 2), null);
  bus.inTurnRecords = [];
  assert.equal(await decideForcedDeepExploreCall(owner, '', bus, 3), null);
});

// Recite: deep_explore round jargon ("第 N 轮", "x 开→y 开") narrated as if just produced.
const RECITE = '## For User\n第 3 轮完成，已 settled Meta-complexity 分支；当前 5 开→4 开，剩 4 个开放节点。';
// Ordinary substantive answer — no round/session jargon.
const NORMAL = '## For User\nP vs NP 的核心障碍在元数学层面（相对化/自然证明/代数化三大屏障）。';

const base = { alreadyForced: false, deepExploreRanThisTurn: false, hasActiveSession: true, advanceRequested: true };

test('a status report or complaint cannot authorize execution through its generated answer', () => {
  assert.equal(shouldForceDeepExploreAdvance(RECITE, { ...base, advanceRequested: false }), false);
  assert.equal(shouldForceDeepExploreAdvance(RECITE, {
    alreadyForced: false, deepExploreRanThisTurn: false, hasActiveSession: true,
  }), false);
});

test('forces on recite: round jargon + no deep_explore call this turn + active session', () => {
  assert.equal(shouldForceDeepExploreAdvance(RECITE, base), true);
});

test('does NOT force when deep_explore actually ran this turn (a real round legitimately reports 第N轮)', () => {
  assert.equal(shouldForceDeepExploreAdvance(RECITE, { ...base, deepExploreRanThisTurn: true }), false);
});

test('does NOT force when already forced this turn (anti-reentry)', () => {
  assert.equal(shouldForceDeepExploreAdvance(RECITE, { ...base, alreadyForced: true }), false);
});

test('does NOT force when there is no active session to continue', () => {
  assert.equal(shouldForceDeepExploreAdvance(RECITE, { ...base, hasActiveSession: false }), false);
});

test('does NOT force on ordinary text without round/session jargon (no false positive)', () => {
  assert.equal(shouldForceDeepExploreAdvance(NORMAL, base), false);
});

// English recite (the v4-pro stall observed in prod: tools=0, narrates "advanced" without running).
test('forces on ENGLISH recite: "session advanced" / "advanced one more round" / "Proved=3" / "N open"', () => {
  for (const t of [
    '## Work Log\nDeep explore action=continue → session advanced. After this, status.',
    '## Work Log\nContinue advanced one more round. Let me check status. Proved=3, open=8.',
    '## For User\nAdvanced one round; current 1 proved / 14 open / 0 dead ends.',
    '## Work Log\nFollowing the skill template: first check status, then advance.',
    '## Work Log\nLet me check the status, then advance the deep_explore session.',
  ]) {
    assert.equal(shouldForceDeepExploreAdvance(t, base), true, `should force on: ${t.slice(0, 40)}`);
  }
});

test('English: no false positive on an ordinary research answer', () => {
  assert.equal(
    shouldForceDeepExploreAdvance('## For User\nSGLang + FP8 + EAGLE MTP is the best inference stack; here is why.', base),
    false,
  );
});

// ── B: userAsksExploreStatus — a status/count question must not be hijacked into a 6-min advance ──────
test('userAsksExploreStatus: count question about deep_explore → true', () => {
  assert.equal(userAsksExploreStatus('现在有多少未结束的deep explore？'), true);
  assert.equal(userAsksExploreStatus('deep explore 进度如何？'), true);
  assert.equal(userAsksExploreStatus('还有哪些探索挂着没推进'), true);
  assert.equal(userAsksExploreStatus('how many deep explores are still running?'), true);
  assert.equal(userAsksExploreStatus('list the open explorations'), true);
});

test('userAsksExploreStatus: a request to ADVANCE is not a status query → false', () => {
  assert.equal(userAsksExploreStatus('继续'), false);
  assert.equal(userAsksExploreStatus('继续推进 deep explore'), false); // wants to advance, no status cue
  assert.equal(userAsksExploreStatus('深入研究一下 GLM 架构'), false);  // start, not status
  assert.equal(userAsksExploreStatus('ok'), false);
});

test('userAsksExploreStatus: status cue WITHOUT an explore reference → false (not about exploration)', () => {
  assert.equal(userAsksExploreStatus('现在有多少未读消息？'), false);
  assert.equal(userAsksExploreStatus('进度怎么样了'), false);
});
