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

const { shouldForceDeepExploreAdvance } = await import('../src/chat-handler.js');

// Recite: deep_explore round jargon ("第 N 轮", "x 开→y 开") narrated as if just produced.
const RECITE = '## For User\n第 3 轮完成，已 settled Meta-complexity 分支；当前 5 开→4 开，剩 4 个开放节点。';
// Ordinary substantive answer — no round/session jargon.
const NORMAL = '## For User\nP vs NP 的核心障碍在元数学层面（相对化/自然证明/代数化三大屏障）。';

const base = { alreadyForced: false, deepExploreRanThisTurn: false, hasActiveSession: true };

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
