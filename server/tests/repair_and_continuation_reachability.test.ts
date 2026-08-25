import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRunningAuthState } from '../src/chat-handler.js';
import { repairLedgerRows } from '../src/mechanical_repair.js';
import { classifyMcpBootStatus } from '../src/mcp_boot_status.js';

test('a returned authorized call is completed, removed, and persisted', () => {
  const pending = {
    toolCallId: 'call-1',
    executionState: 'running',
    callLedger: [
      { id: 'done', state: 'completed' },
      { id: 'call-1', state: 'running' },
      { id: 'later', state: 'queued' },
    ],
  };
  const entries = new Map([['session-1', pending]]);
  let persisted = 0;
  const settled = settleRunningAuthState(entries, 'session-1', 'call-1', () => { persisted++; });
  assert.equal(settled, pending);
  assert.equal(entries.has('session-1'), false);
  assert.equal(persisted, 1);
  assert.equal(settled?.callLedger?.find((entry) => entry.id === 'call-1')?.state, 'completed');
  assert.equal(settled?.callLedger?.find((entry) => entry.id === 'later')?.state, 'queued');
});

test('a non-running or different authorization is left untouched', () => {
  const pending = { toolCallId: 'call-1', executionState: 'awaiting_auth', callLedger: [] };
  const entries = new Map([['session-1', pending]]);
  let persisted = 0;
  assert.equal(settleRunningAuthState(entries, 'session-1', 'call-1', () => { persisted++; }), null);
  assert.equal(settleRunningAuthState(entries, 'session-1', 'other', () => { persisted++; }), null);
  assert.equal(entries.get('session-1'), pending);
  assert.equal(persisted, 0);
});

test('repair accounting emits the original failure and corrected success as separate executions', () => {
  const bad = { command: 'lake build Bad' };
  const good = { command: 'lake build Good' };
  assert.deepEqual(repairLedgerRows({
    originalInput: bad,
    originalFailure: { error: 'unknown target Bad' },
    repairedInput: good,
    finalResult: { success: true, output: 'Built Good' },
  }), [
    { params: bad, result: 'unknown target Bad', success: false },
    { params: good, result: 'Built Good', success: true },
  ]);
});

test('without automatic repair accounting emits exactly the execution that occurred', () => {
  const input = { path: 'missing' };
  assert.deepEqual(
    repairLedgerRows({ originalInput: input, finalResult: { success: false, error: 'ENOENT' } }),
    [{ params: input, result: 'ENOENT', success: false }],
  );
});

test('MCP boot policy waits for connecting servers, then reports unresolved ones', () => {
  const servers = [
    { name: 'ready', state: 'connected' },
    { name: 'slow', state: 'connecting' },
    { name: 'bad-config', state: 'failed', lastError: 'invalid configuration' },
  ];
  const early = classifyMcpBootStatus(servers, false);
  assert.equal(early.shouldWait, true);
  assert.deepEqual(early.unavailable.map((server) => server.name), ['bad-config']);
  const final = classifyMcpBootStatus(servers, true);
  assert.equal(final.shouldWait, false);
  assert.deepEqual(final.unavailable.map((server) => server.name), ['bad-config', 'slow']);
});
