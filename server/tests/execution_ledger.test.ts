/**
 * S1 — execution-ledger anchor (docs/design/execution_ledger_anchor.md). The active deep_explore session
 * is rendered into buildMemoryPrefix as an authoritative read-only snapshot + a generation contract, so
 * the model answers from the tree state instead of reciting a stale narrative.
 *
 * chat-handler opens a DB at import time → MEMORY_DB_PATH=':memory:' first; run with --test-force-exit.
 * The test creates an active reasoning session on the shared `memory` singleton and ABANDONS it in a
 * finally so it never leaks into other chat-handler-importing tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MEMORY_DB_PATH = ':memory:';
process.env.LLM_PROVIDER = '';

const { buildMemoryPrefix, memory } = await import('../src/chat-handler.js');

function withSession<T>(goal: string, fn: () => T): T {
  const { session } = memory.reasoning.createSession({ goal, ownerSessionId: 'test:owner' });
  try {
    return fn();
  } finally {
    memory.reasoning.setSessionStatus(session.id, 'abandoned'); // un-active → no leak to other suites
  }
}

test('S1: flag default ON → active session surfaces the GROUND TRUTH snapshot + contract', () => {
  const prev = process.env.PHILONT_EXECUTION_LEDGER;
  delete process.env.PHILONT_EXECUTION_LEDGER; // default
  try {
    withSession('explore P vs NP barriers and how to push the proof further', () => {
      const p = buildMemoryPrefix('');
      assert.match(p, /Active reasoning — GROUND TRUTH/);
      assert.match(p, /tree: \d+ open · \d+ proved · \d+ dead-end/);
      assert.match(p, /CONTRACT: any claim of a deep_explore round/);
      assert.match(p, /P vs NP barriers/, 'the active goal is shown');
      // The contract explicitly distinguishes the stored snapshot from this-turn progress (anti-recite).
      assert.match(p, /stored snapshot/);
    });
  } finally {
    if (prev === undefined) delete process.env.PHILONT_EXECUTION_LEDGER;
    else process.env.PHILONT_EXECUTION_LEDGER = prev;
  }
});

test('S1: flag OFF ("0") → no anchor block (kill-switch, byte-identical to no-ledger)', () => {
  const prev = process.env.PHILONT_EXECUTION_LEDGER;
  process.env.PHILONT_EXECUTION_LEDGER = '0';
  try {
    withSession('some active goal', () => {
      const p = buildMemoryPrefix('');
      assert.doesNotMatch(p, /GROUND TRUTH/, 'flag off → anchor absent');
    });
  } finally {
    if (prev === undefined) delete process.env.PHILONT_EXECUTION_LEDGER;
    else process.env.PHILONT_EXECUTION_LEDGER = prev;
  }
});

test('S1: no active session → no anchor block (and flag-on is a no-op)', () => {
  const prev = process.env.PHILONT_EXECUTION_LEDGER;
  delete process.env.PHILONT_EXECUTION_LEDGER; // on
  try {
    // No session created → getMostRecentActiveSession returns null → empty ledger.
    const p = buildMemoryPrefix('');
    assert.doesNotMatch(p, /GROUND TRUTH/);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_EXECUTION_LEDGER;
    else process.env.PHILONT_EXECUTION_LEDGER = prev;
  }
});
