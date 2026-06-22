/**
 * leanCheck classifier — the false-success trap (sorry/admit elaborate with exit 0 yet prove nothing)
 * must be caught; clean proofs pass; real errors and timeouts classify correctly. Pure function, no
 * lean binary required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLeanOutput } from '../src/runtime/lean.js';

test('sorry → NOT verified even with exit 0 (the false-success trap)', () => {
  const v = classifyLeanOutput("warning: declaration uses 'sorry'", '', 0, false);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-sorry');
});

test('admit → NOT verified even with exit 0', () => {
  const v = classifyLeanOutput('', "uses 'sorry'", 0, false); // admit lowers to sorry-axiom too
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-sorry');
});

test('clean elaboration, exit 0, no output → verified', () => {
  const v = classifyLeanOutput('', '', 0, false);
  assert.equal(v.success, true);
  assert.equal(v.errorClass, undefined);
});

test('unsolved goals → lean-unsolved', () => {
  const v = classifyLeanOutput('foo.lean:3:0: error: unsolved goals\n⊢ a + b = b + a', '', 1, false);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-unsolved');
});

test('unknown identifier → lean-unknown', () => {
  const v = classifyLeanOutput('foo.lean:1:0: error: unknown identifier \'Nat.foo\'', '', 1, false);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-unknown');
});

test('generic error / non-zero exit → lean-error', () => {
  const v = classifyLeanOutput('foo.lean:2:5: error: type mismatch', '', 1, false);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-error');
});

test('non-zero exit with no parseable error line still fails', () => {
  const v = classifyLeanOutput('', '', 1, false);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-error');
});

test('timeout → lean-timeout (checked before everything)', () => {
  const v = classifyLeanOutput('', '', null, true);
  assert.equal(v.success, false);
  assert.equal(v.errorClass, 'lean-timeout');
});

test('sorry takes precedence over a co-occurring error', () => {
  const v = classifyLeanOutput("error: foo\ndeclaration uses 'sorry'", '', 1, false);
  assert.equal(v.errorClass, 'lean-sorry');
});
