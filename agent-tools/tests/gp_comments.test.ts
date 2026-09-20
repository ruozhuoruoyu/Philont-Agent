import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGpComments, checkGpParenBalance } from '../src/runtime/gp.js';

// Prod 2026-09-20 00:45 → 04:28: eleven scripts died with `syntax error, unexpected '/'` on a `//…`
// line. GP has no `//` comment; it is never valid outside a string, so it is rewritten to `\\`.

test('`//` line comments are rewritten to GP backslash comments', () => {
  const src = '//crude lower bound: each D_s >= floor(2p/j)\nx = 3; // trailing note\nprint(x)\n';
  const { script, rewritten } = normalizeGpComments(src);
  assert.equal(rewritten, 2);
  assert.equal(script, '\\\\crude lower bound: each D_s >= floor(2p/j)\nx = 3; \\\\ trailing note\nprint(x)\n');
});

test('`//` inside strings, block comments and existing backslash comments is left alone', () => {
  const src = 'print("http://example/a//b"); /* keep // here */ \\\\ and // here\ny = 1 // real comment';
  const { script, rewritten } = normalizeGpComments(src);
  assert.equal(rewritten, 1);
  assert.equal(script, 'print("http://example/a//b"); /* keep // here */ \\\\ and // here\ny = 1 \\\\ real comment');
});

test('a script without `//` passes through untouched, and the rewrite happens before the paren check', () => {
  const clean = 'f(n) = { my(s=0); for(i=1,n, s += i); s }\nprint(f(10))';
  assert.deepEqual(normalizeGpComments(clean), { script: clean, rewritten: 0 });
  // A `//` comment containing an unmatched paren must not be counted once rewritten.
  const withParen = '// note (unbalanced\nprint(1)';
  assert.equal(checkGpParenBalance(normalizeGpComments(withParen).script), null);
});

test('an unterminated string or block comment does not loop or throw', () => {
  assert.equal(normalizeGpComments('print("open // string').script, 'print("open // string');
  assert.equal(normalizeGpComments('/* open // block').script, '/* open // block');
  assert.equal(normalizeGpComments('x = 1 // at end without newline').script, 'x = 1 \\\\ at end without newline');
});
