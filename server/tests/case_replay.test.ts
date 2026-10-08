/**
 * Trajectory replay (2026-10-08): PHILONT_CASE_REPLAY mode parsing and the per-step input excerpt that a
 * replayed case shows. Evidence for the feature: philosophers exp 116 (AppWorld) / 115 (ConvStream) —
 * replaying what similar successful runs actually executed is the one memory form that wins on a weaker
 * model; tool-name-only traces cannot carry it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseReplayMode, caseStepInput } from '../src/chat-handler.js';

test('caseReplayMode: off by default; success for 1/on/true/success; all', () => {
  const prev = process.env.PHILONT_CASE_REPLAY;
  try {
    delete process.env.PHILONT_CASE_REPLAY;
    assert.equal(caseReplayMode(), 'off');
    for (const v of ['1', 'on', 'true', 'success', ' SUCCESS ']) {
      process.env.PHILONT_CASE_REPLAY = v;
      assert.equal(caseReplayMode(), 'success', v);
    }
    process.env.PHILONT_CASE_REPLAY = 'all';
    assert.equal(caseReplayMode(), 'all');
    process.env.PHILONT_CASE_REPLAY = 'nonsense';
    assert.equal(caseReplayMode(), 'off');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_CASE_REPLAY;
    else process.env.PHILONT_CASE_REPLAY = prev;
  }
});

test('caseStepInput: shell command / code / path first, else compact JSON, bounded at 300, whitespace folded', () => {
  assert.equal(caseStepInput('shell', { command: 'ls  -la\n  /tmp' }), 'ls -la /tmp');
  assert.equal(caseStepInput('execute_python', { code: 'print(1)' }), 'print(1)');
  assert.equal(caseStepInput('readFile', { path: '/etc/hosts' }), '/etc/hosts');
  assert.equal(caseStepInput('http', { method: 'GET', url: 'https://x.test/a' }), 'https://x.test/a');
  assert.equal(caseStepInput('other', { a: 1, b: 'two' }), '{"a":1,"b":"two"}');
  assert.equal(caseStepInput('shell', { command: 'x'.repeat(500) })!.length, 300);
  assert.equal(caseStepInput('shell', undefined), undefined);
  assert.equal(caseStepInput('shell', { command: '   ' }), '{"command":"   "}'.replace(/\s+/g, ' '));
});
