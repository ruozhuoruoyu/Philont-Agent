/**
 * findCheckableObject — pinned against the real 2026-07-22 Jacobian session.
 *
 * The positives are the actual strings the deliberate session settled on without computing anything; the
 * negatives are the surrounding prose from the SAME session, which shares its vocabulary (numbers,
 * "counterexample", model names, URLs) and must stay silent. A detector that fires on the narration would
 * refuse every settle in a research session, which is why the negative list is the longer one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCheckableObject, renderCheckableObjectRefusal } from '../src/index.js';

// ── Positives: what a machine could have decided in seconds ───────────────────────────────────

test('determinant: the claim the session never computed', () => {
  const hit = findCheckableObject('The Jacobian determinant is identically -2, so the map satisfies the hypothesis.');
  assert.equal(hit?.kind, 'determinant');
  assert.equal(hit?.tool, 'pariGp');
});

test('determinant: Chinese phrasing from the production report', () => {
  assert.equal(findCheckableObject('雅可比行列式恒等于 -2(非零常数),满足猜想条件')?.kind, 'determinant');
});

test('identity: an explicit polynomial component', () => {
  const hit = findCheckableObject('f1 = (1+xy)^3 z + y^2 (1+xy)(4+3xy)');
  assert.equal(hit?.kind, 'identity');
});

test('identity: unicode superscripts and subscripted name', () => {
  assert.equal(findCheckableObject('f₃ = 2x - 3x²y - x³z')?.kind, 'identity');
});

test('evaluation: three points colliding on one image', () => {
  const hit = findCheckableObject('三个不同点 (0,0,-1/4) 都映射到同一输出 (-1/4,0,0),因此不可逆');
  assert.equal(hit?.kind, 'evaluation');
});

test('evaluation: ascii arrow form', () => {
  assert.equal(findCheckableObject('(1, -3/2, 13/2) -> (-1/4, 0, 0)')?.kind, 'evaluation');
});

test('arithmetic: a primality claim about a concrete number', () => {
  assert.equal(findCheckableObject('2^61 - 1 is prime, which closes the case')?.kind, 'arithmetic');
});

test('the refusal names the object and the tool, and does not order a verdict', () => {
  const hit = findCheckableObject('The Jacobian determinant is identically -2')!;
  const msg = renderCheckableObjectRefusal(hit);
  assert.match(msg, /pariGp/);
  assert.match(msg, /determinant/i);
  // It must leave room for the object to be WRONG — the point is to check, not to confirm.
  assert.match(msg, /wrong, that is the finding/);
});

test('the actual grounding line the session settled on, verbatim', () => {
  // This exact string sat in the session's own "known going in" block. Everything decidable about the
  // counterexample is inside it, and nothing computed it.
  const line =
    'The counterexample is a polynomial map F: C^3 -> C^3: a = (1+xy)^3 z + y^2 (1+xy)(4+3xy), ' +
    'b = y+3x(1+xy)^2 z + 3xy^2 (4+3xy), c = 2x-3x^2 y-x^3 z, with constant Jacobian determinant -2, ' +
    'sending three distinct points to the same target (-1/4,0,0).';
  const hit = findCheckableObject(line);
  assert.ok(hit, 'the object the whole session was about must be detected');
  assert.equal(hit!.tool, 'pariGp');
});

// ── Negatives: the narration around those claims ──────────────────────────────────────────────

test('a character count is not an arithmetic claim', () => {
  assert.equal(findCheckableObject('the counterexample is exceptionally short (216 characters) and easy to verify'), null);
});

test('a cited source is not a checkable object', () => {
  assert.equal(
    findCheckableObject('Mathematicians noted the result is poetic (https://thenextweb.com/news/jacobian-conjecture-disproved)'),
    null,
  );
});

test('a model/version name is not an identity', () => {
  assert.equal(findCheckableObject('Alexis Gallagher claimed to have used GPT-5.6 to extend the counterexample'), null);
});

test('structural prose about degrees and monodromy stays silent', () => {
  assert.equal(
    findCheckableObject('The function-field extension is degree 3 with full S₃ monodromy, explicitly non-Galois'),
    null,
  );
});

test('an env/config line is not an identity', () => {
  assert.equal(findCheckableObject('PHILONT_SPEC_COMPILE=0 disables the compiled contract'), null);
});

test('a sentence containing an equals sign in prose is not an identity', () => {
  assert.equal(findCheckableObject('our conclusion is that the search space = the whole difficulty here'), null);
});

test('a bare assignment with no algebraic structure stays silent', () => {
  assert.equal(findCheckableObject('rounds = 14 and success = 0 across the scheduled runs'), null);
});

test('too short to carry an object', () => {
  assert.equal(findCheckableObject('det = -2'), null);
});

test('empty / null input', () => {
  assert.equal(findCheckableObject(''), null);
  assert.equal(findCheckableObject(null), null);
});
