/**
 * detectGpScriptError — gp.exe exits 0 even on script syntax errors; a `***` marker in stderr must be
 * treated as failure so the LLM doesn't trust a false "no solutions found" result (2026-06-17 prod).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGpScriptError } from '../src/runtime/shell.js';

const GP_CMD = '"E:\\dev\\Pari64-2-17-3\\gp.exe" -q "E:\\dev\\philont\\server\\output\\search.gp"';

test('gp command + *** syntax error in stderr → flagged (despite exit 0)', () => {
  const stderr = '  ***   syntax error, unexpected invalid token: ...y=-Ymax,Ymax,if(y==0&&x==';
  const stdout = '=== Positive x search ===\nNo solutions found in |x| <= 1000000';
  const e = detectGpScriptError(GP_CMD, stdout, stderr);
  assert.ok(e);
  assert.match(e!, /syntax error/);
});

test('gp command + *** "not a function" → flagged', () => {
  const e = detectGpScriptError(GP_CMD, '', '***   at top-level: search_x(2000)\n*** not a function in function call');
  assert.ok(e);
});

test('gp command, clean run (no ***) → null', () => {
  const e = detectGpScriptError(GP_CMD, 'Search x=1..5000 complete.\nFOUND: x=5 y=3 z=2', '');
  assert.equal(e, null);
});

test('non-gp command with *** in output → null (scoped to gp)', () => {
  const e = detectGpScriptError('echo "*** build complete ***"', '*** build complete ***', '');
  assert.equal(e, null);
});

test('detects the *** marker even when only in stdout', () => {
  const e = detectGpScriptError('pari script.gp', '***   too few arguments: ...print(...);', '');
  assert.ok(e);
});

// 2026-06-22: benign warnings share the *** marker — must NOT be judged failures.
test('gp benign stack-size warning → NOT flagged (the script ran fine)', () => {
  const stderr = '  ***   Warning: increasing stack size to 1000000.';
  const stdout = 'M1 = 91.89\nresult printed';
  assert.equal(detectGpScriptError(GP_CMD, stdout, stderr), null);
});

test('gp warning + a real *** error → flagged (error wins)', () => {
  const stderr = '*** Warning: increasing stack size to 2000000.\n***   syntax error, unexpected )';
  const e = detectGpScriptError(GP_CMD, '', stderr);
  assert.ok(e);
  assert.match(e!, /syntax error/);
});
