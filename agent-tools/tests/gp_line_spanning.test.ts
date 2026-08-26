/**
 * `pariGp:gp-syntax` has topped the weekly failure chart every week it has been measured — ×71, then ×26.
 *
 * Production 2026-08-04 09:44:35, three failures inside one deep_explore round:
 *
 *   ***   syntax error, unexpected end of file, expecting )-> or ',' or ')':
 *   ***   for(i=1,8,
 *   ***            ^-
 *
 * Those scripts are balanced overall, so checkGpParenBalance passes them. gp reading a script line by
 * line treats each LINE as a complete statement unless it sits inside a `{ }` block, so it hits the end
 * of `for(i=1,8,` and reports end-of-file with the caret on a comma that looks perfectly fine.
 *
 * Both mechanisms aimed at this signature were blind to it. The hand-written cheatsheet says
 * "multi-statement body → wrap in braces", which reads as advice about `;`, not about spanning LINES.
 * And the repair learner twice proposed "PARI/GP forbids bare top-level loops" — false, and correctly
 * rejected by its verifier both times. The rule is mechanical, so it is checked, not prompted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pariGpTool } from '../src/index.js';
import { checkGpLineSpanningParens, checkGpParenBalance } from '../src/runtime/gp.js';

// verbatim shape of the 2026-08-04 failure
const SPANNING = `for(i=1,8,
  for(m=9,80,
    V=vector(8);
    print(V)
  )
)`;

test('the exact script shape that failed in production is caught', () => {
  assert.equal(checkGpParenBalance(SPANNING), null, 'balanced overall — this is why it got through');
  const msg = checkGpLineSpanningParens(SPANNING);
  assert.ok(msg, 'gp cannot parse this');
  assert.match(msg, /unclosed at the end of line 1/);
  assert.match(msg, /one LINE at a time/);
});

test('runtime preserves the spanning class instead of reclassifying it as paren imbalance', async () => {
  const result = await pariGpTool.execute({ script: SPANNING });
  assert.equal(result.success, false);
  assert.match(result.error ?? '', /pre-check \[class=gp-precheck-spanning\]/);
});

test('a one-line construct is fine', () => {
  assert.equal(checkGpLineSpanningParens('for(i=1,8,print(i))'), null);
  assert.equal(checkGpLineSpanningParens('print(factor(2^67-1))\nprint(isprime(7))'), null);
});

test('the brace-block form gp actually accepts is not flagged', () => {
  const braced = `{
  for(i=1,8,
    print(i)
  )
}`;
  assert.equal(checkGpLineSpanningParens(braced), null);
});

test('a brace-bodied helper spanning lines is fine', () => {
  const helper = `f(x) = {
  my(s = 0);
  for(i=1,x,
    s += i
  );
  s
}
print(f(10))`;
  assert.equal(checkGpLineSpanningParens(helper), null);
});

test('parens inside comments and strings do not trigger it', () => {
  assert.equal(checkGpLineSpanningParens('\\\\ for(i=1,8,\nprint(1)'), null);
  assert.equal(checkGpLineSpanningParens('print("for(i=1,8,")\nprint(2)'), null);
  assert.equal(checkGpLineSpanningParens('/* for(i=1,\n8, */\nprint(3)'), null);
});

test("gp's explicit backslash continuation is legal unbraced", () => {
  assert.equal(checkGpLineSpanningParens('print(1 + \\\n  2)'), null);
});

test('the line numbers point at the construct, not at the end of the script', () => {
  const script = `print(1)\nprint(2)\nfor(i=1,3,\n  print(i)\n)`;
  const msg = checkGpLineSpanningParens(script)!;
  assert.match(msg, /line 3 opens/);
  assert.match(msg, /end of line 3/);
});

test('a script with no trailing newline still reports the last line', () => {
  assert.equal(checkGpLineSpanningParens('for(i=1,3,'), null, 'no newline seen — the balance check owns this one');
  assert.match(checkGpParenBalance('for(i=1,3,') ?? '', /unclosed/);
});
