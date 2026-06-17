/**
 * localWorkflowGrants — one approval of any LOCAL write/execute tool grants the whole local research
 * loop across BOTH capabilities; network/destructive/external stay per-call (2026-06-17 WS5 fix for the
 * "继续→授权→ok" treadmill, prod showed ~6 "ok"s for one research push).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localWorkflowGrants, LOCAL_RESEARCH_WORKFLOW } from '../src/research_grant.js';

const names = (gs: { tool: string }[]) => gs.map((g) => g.tool).sort();

test('approving write/local writeFile grants the rest of the local loop (incl. execute tools)', () => {
  const g = localWorkflowGrants('write', 'local', 'writeFile');
  assert.deepEqual(names(g), ['moveFile', 'pariGp', 'patch', 'shell', 'z3Verify']);
  // crosses capability: a write approval grants execute tools
  assert.ok(g.some((x) => x.tool === 'shell' && x.capability === 'execute'));
});

test('approving execute/local shell grants write tools AND pariGp/z3Verify (the old gap)', () => {
  const g = localWorkflowGrants('execute', 'local', 'shell');
  assert.deepEqual(names(g), ['moveFile', 'pariGp', 'patch', 'writeFile', 'z3Verify']);
  // pariGp + z3Verify were entirely missing from the old per-capability sibling list
  assert.ok(g.some((x) => x.tool === 'pariGp'));
  assert.ok(g.some((x) => x.tool === 'z3Verify'));
});

test('the approved tool itself is excluded from the sibling grants', () => {
  assert.ok(!localWorkflowGrants('execute', 'local', 'pariGp').some((x) => x.tool === 'pariGp'));
});

test('downloadFile (write/network) is NOT batched — network stays per-call', () => {
  assert.deepEqual(localWorkflowGrants('write', 'network', 'downloadFile'), []);
});

test('read/local (readFile) is NOT batched — only write/execute trigger the workflow grant', () => {
  assert.deepEqual(localWorkflowGrants('read', 'local', 'readFile'), []);
});

test('external/untrusted execution (execute/system) is NOT batched', () => {
  assert.deepEqual(localWorkflowGrants('execute', 'system', 'someRemoteExec'), []);
});

test('every entry in the set is local + write|execute (no network/destructive leaked in)', () => {
  for (const g of LOCAL_RESEARCH_WORKFLOW) {
    assert.equal(g.domain, 'local');
    assert.ok(g.capability === 'write' || g.capability === 'execute');
    assert.notEqual(g.tool, 'deleteFile');
    assert.notEqual(g.tool, 'downloadFile');
  }
});
