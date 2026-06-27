/**
 * S1 P1 — generation-time execution-ledger contract (anti-fabrication, structural prevention).
 *
 * Verifies the pure builders and that injecting the contract into messages[0] (the system prefix) does NOT
 * blind extractRecentToolResults — i.e. the prevention layer never disarms the post-hoc honesty gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  turnLedgerContractEnabled,
  buildTurnLedgerContract,
  refreshTurnLedgerContract,
  extractRecentToolResults,
} from '../src/chat-handler.js';
import type { NativeMessage } from '../src/llm-adapter.js';
import type { InTurnToolRecord } from '../src/in_turn_reflection.js';

const rec = (toolName: string, success = true, resultText = 'ok'): InTurnToolRecord => ({ toolName, success, resultText });

test('turnLedgerContractEnabled: default ON, =0/off disables', () => {
  const prev = process.env.PHILONT_TURN_LEDGER_CONTRACT;
  try {
    delete process.env.PHILONT_TURN_LEDGER_CONTRACT;
    assert.equal(turnLedgerContractEnabled(), true, 'default ON');
    process.env.PHILONT_TURN_LEDGER_CONTRACT = '0';
    assert.equal(turnLedgerContractEnabled(), false);
    process.env.PHILONT_TURN_LEDGER_CONTRACT = 'off';
    assert.equal(turnLedgerContractEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_TURN_LEDGER_CONTRACT;
    else process.env.PHILONT_TURN_LEDGER_CONTRACT = prev;
  }
});

test('buildTurnLedgerContract: no records → empty (nothing to contract about)', () => {
  assert.equal(buildTurnLedgerContract([]), '');
});

test('buildTurnLedgerContract: research-only turn (webSearch/webFetch) → contract + "did NOT compile/run" note', () => {
  const out = buildTurnLedgerContract([rec('webSearch'), rec('webFetch')]);
  assert.match(out, /CONTRACT/);
  assert.match(out, /webSearch/);
  assert.match(out, /webFetch/);
  assert.match(out, /have NOT compiled, run, tested/, 'no executor ran → explicit "you have not built/run anything"');
  assert.match(out, /53\/53 pass/, 'names the exact fabrication shape as the thing to not invent');
});

test('buildTurnLedgerContract: contract tells the model to STILL answer (anti over-correction / no meta-talk)', () => {
  // The over-correction regression: after being caught fabricating, the model spent its reply re-confessing
  // and narrating "my research is all from webSearch" instead of answering. Contract 2/2 must redirect it.
  const out = buildTurnLedgerContract([rec('webSearch')]);
  assert.match(out, /still ANSWER/i, 'has the "but still answer" half');
  assert.match(out, /Do NOT quote it/i, 'tells the model the ledger is internal, not to surface');
  assert.match(out, /directly and\s+concretely/i, 'pushes a direct concrete answer');
  assert.match(out, /not a pre-emptive disclaimer/i, 'do not open with a defensive disclaimer');
});

test('buildTurnLedgerContract: a real executor ran (shell) → contract WITHOUT the "did not run" note', () => {
  const out = buildTurnLedgerContract([rec('shell', true, '53 passed')]);
  assert.match(out, /CONTRACT/);
  assert.doesNotMatch(out, /have NOT compiled, run, tested/, 'shell IS an executor → do not assert nothing ran');
});

test('refreshTurnLedgerContract: injects into messages[0], replaces (never doubles) on repeat', () => {
  const messages: NativeMessage[] = [
    { role: 'user', content: 'SYSTEM PREFIX' } as any, // messages[0] = system context slot
    { role: 'user', content: '帮我复现 TileRT' },
  ];
  refreshTurnLedgerContract(messages, [rec('webSearch')]);
  const c1 = messages[0].content as string;
  assert.match(c1, /^SYSTEM PREFIX/, 'base prefix preserved');
  assert.match(c1, /THIS-TURN EXECUTION LEDGER/);
  assert.equal((c1.match(/<<TURN_EXECUTION_LEDGER>>/g) ?? []).length, 1);

  // Second refresh (e.g. after another tool) must REPLACE, not accumulate.
  refreshTurnLedgerContract(messages, [rec('webSearch'), rec('webFetch')]);
  const c2 = messages[0].content as string;
  assert.equal((c2.match(/<<TURN_EXECUTION_LEDGER>>/g) ?? []).length, 1, 'still exactly one block');
  assert.match(c2, /webFetch/, 'reflects the latest records');
});

test('refreshTurnLedgerContract: flag off → messages byte-identical', () => {
  const prev = process.env.PHILONT_TURN_LEDGER_CONTRACT;
  process.env.PHILONT_TURN_LEDGER_CONTRACT = '0';
  try {
    const messages: NativeMessage[] = [{ role: 'user', content: 'SYSTEM PREFIX' } as any];
    refreshTurnLedgerContract(messages, [rec('webSearch')]);
    assert.equal(messages[0].content, 'SYSTEM PREFIX', 'off → no mutation');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_TURN_LEDGER_CONTRACT;
    else process.env.PHILONT_TURN_LEDGER_CONTRACT = prev;
  }
});

test('refreshTurnLedgerContract does NOT blind extractRecentToolResults (gate stays armed)', () => {
  // Full turn shape: system prefix, real user message (the turn boundary), tool_use, tool_result.
  const messages: NativeMessage[] = [
    { role: 'user', content: 'SYSTEM PREFIX' } as any,
    { role: 'user', content: '帮我复现 TileRT' }, // ← turnStart boundary (most-recent string-content user)
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'webSearch', input: {} }] } as any,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '✓ TOOL OK\n...' }] } as any,
  ];
  refreshTurnLedgerContract(messages, [rec('webSearch')]); // mutates messages[0] only
  const out = extractRecentToolResults(messages);
  assert.equal(out.length, 1, 'the tool result is still seen — the injected block is invisible to the boundary scan');
  assert.equal(out[0].toolName, 'webSearch');
});
