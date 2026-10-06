/** Acceptance–repair primitives: the check runner (exit code, timeout, output tail) and the repair prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAcceptance, repairPrompt, tail, splitClauses, diagnoseAcceptance } from '../src/acceptance_check.js';

test('runAcceptance: exit 0 passes, non-zero fails with captured output', async () => {
  const ok = await runAcceptance('echo fine', 5000, '/bin/bash');
  assert.equal(ok.passed, true); assert.equal(ok.exitCode, 0); assert.match(ok.output, /fine/);
  const bad = await runAcceptance('echo "FAIL: /x missing" >&2; exit 3', 5000, '/bin/bash');
  assert.equal(bad.passed, false); assert.equal(bad.exitCode, 3); assert.match(bad.output, /FAIL: \/x missing/); assert.equal(bad.timedOut, false);
});

test('runAcceptance: timeout is reported, never thrown', async () => {
  const r = await runAcceptance('sleep 5', 300, '/bin/bash');
  assert.equal(r.passed, false); assert.equal(r.timedOut, true); assert.ok(r.durationMs < 4000);
});

test('runAcceptance: a missing shell is a failed result, not an exception', async () => {
  const r = await runAcceptance('true', 2000, '/nonexistent/shell');
  assert.equal(r.passed, false); assert.match(r.output, /spawn error/);
});

test('repairPrompt names the failed check verbatim and the attempt count; tail trims long output', () => {
  const p = repairPrompt('Create /target with links', { passed: false, exitCode: 1, output: 'FAIL: /target missing', timedOut: false, durationMs: 10 }, 1, 2);
  assert.match(p, /验收未通过 1\/2/); assert.match(p, /exited with code 1/); assert.match(p, /FAIL: \/target missing/); assert.match(p, /Create \/target with links/);
  assert.equal(tail('a'.repeat(5000), 100).length, 101);
});

test('splitClauses + diagnoseAcceptance: a silent && chain is explained by its failing clauses', async () => {
  const cmd = "test -d /tmp && test -f /definitely/missing/file && [ 1 -eq 1 ] && exit 0 || exit 1";
  assert.deepEqual(splitClauses(cmd), ['test -d /tmp', 'test -f /definitely/missing/file', '[ 1 -eq 1 ]']);
  const r = await runAcceptance(cmd, 5000, '/bin/bash');
  assert.equal(r.passed, false); assert.equal(r.output, '');
  const failing = await diagnoseAcceptance(cmd, r, 5000, '/bin/bash');
  assert.deepEqual(failing, ['test -f /definitely/missing/file']);
  const p = repairPrompt('t', r, 1, 1, failing);
  assert.match(p, /FAILED/); assert.match(p, /test -f \/definitely\/missing\/file/);
  // a check that already explains itself is not re-split
  assert.deepEqual(await diagnoseAcceptance('echo "FAIL: x" && exit 1', { passed: false, exitCode: 1, output: 'FAIL: x', timedOut: false, durationMs: 1 }, 5000, '/bin/bash'), []);
  assert.deepEqual(splitClauses('single command'), []);
});
