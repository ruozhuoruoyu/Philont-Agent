/**
 * findRefutableGoal — which goals get a machine-checkable node seeded next to them.
 *
 * The failure this exists for is a tree on which nothing is decidable, so no round yields a signal. The
 * detector reads STRUCTURE (a quantifier, or conjecture-shaped phrasing), never a list of famous problem
 * names — a curated vocabulary would fail on the first problem nobody thought to list, and this repo has
 * been bitten by hard-coded tables before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefutableGoal, renderRefutationClaim, renderRefutationNote } from '../src/index.js';

// ── Fires: the goal has a refutation direction ────────────────────────────────────────────────

test('explicit quantifier, English', () => {
  assert.equal(findRefutableGoal('Show that for every even n > 2 the property holds')?.reason, 'quantifier');
});

test('explicit quantifier, Chinese', () => {
  assert.equal(findRefutableGoal('证明该性质对所有偶数成立')?.reason, 'quantifier');
});

test('the quantifier symbol alone', () => {
  assert.equal(findRefutableGoal('Prove ∀x. f(x) > 0 on the given domain')?.reason, 'quantifier');
});

test('a negative existence claim is universal in disguise', () => {
  assert.equal(findRefutableGoal('Show there is no polynomial map with that property')?.reason, 'quantifier');
});

test('conjecture-shaped without an explicit quantifier', () => {
  assert.equal(findRefutableGoal('Attack the Jacobian conjecture in dimension 3')?.reason, 'conjecture');
});

test('猜想 counts, and no problem name is hard-coded — an invented one works too', () => {
  assert.equal(findRefutableGoal('攻克 Zhuoyu 猜想的三维情形')?.reason, 'conjecture');
  assert.equal(findRefutableGoal('Work on the Nonexistent-Person conjecture of 2031')?.reason, 'conjecture');
});

// ── Silent: nothing to refute ─────────────────────────────────────────────────────────────────

test('a decision goal has no refutation direction', () => {
  assert.equal(findRefutableGoal('Which database should we adopt for the audit log?'), null);
});

test('a decision goal is screened even when it contains a universal word', () => {
  assert.equal(findRefutableGoal('该不该给所有渠道都开推送?'), null);
});

test('a preference goal in Chinese', () => {
  assert.equal(findRefutableGoal('帮我看看这两个方案哪个更适合我'), null);
});

test('an open research question with no claim to refute', () => {
  assert.equal(findRefutableGoal('What happened in the July release?'), null);
});

test('too short', () => {
  assert.equal(findRefutableGoal('P=NP'), null);
  assert.equal(findRefutableGoal(''), null);
});

// ── The seeded node must be a CLAIM, not a task ───────────────────────────────────────────────

test('the seeded claim has a truth value and names what settling requires', () => {
  const claim = renderRefutationClaim('the property holds for every even n');
  // "Search for a counterexample" is a task — one can be busy with it forever and never be checkable.
  assert.doesNotMatch(claim, /^Search\b/);
  assert.match(claim, /No counterexample/);
  assert.match(claim, /bounded region/);
  assert.match(claim, /pariGp|shell/, 'it must name what would check it');
  assert.match(claim, /is not a result/, 'and rule out the unfalsifiable settle');
});

test('the owner-facing note explains the asymmetry it exploits', () => {
  assert.match(renderRefutationNote('quantifier'), /witness/);
  assert.match(renderRefutationNote('conjecture'), /conjecture-shaped/);
});

// 2026-07-28. The `i` flag was missing from UNIVERSAL_RE while both of its siblings had one, so the
// detector matched "for all n" and missed "For all n" — every goal that OPENS with its quantifier, which
// is how a mathematical proposition is normally written.
//
// The LRC session's root was `Prove: For any set S of k positive integers whose residues modulo (k+1)
// are a permutation of {1,...,k}, if S ≠ {1,...,k}, then there exists t with min distance > 1/(k+1)`.
// Capital F → no pairing → the tree never held a node a machine could decide → six consecutive sessions
// ground on the proof side and concluded "structural mismatch between the tool and the problem".
//
// The proposition is false: S = {1,3,4,7} satisfies the hypothesis and its best t achieves exactly 1/5.
// The node this function creates is the counterexample search that would have found it.
test('a goal that OPENS with its quantifier is paired — the normal way to write a proposition', () => {
  const lrc =
    'Prove: For any set S of k positive integers whose residues modulo (k+1) are a permutation of ' +
    '{1,...,k}, if S ≠ {1,2,...,k}, then there exists t with min distance > 1/(k+1)';
  assert.equal(findRefutableGoal(lrc)?.reason, 'quantifier');
});

test('capitalisation never decides whether a quantifier is one', () => {
  for (const [cap, low] of [
    ['For all n, P(n) holds', 'for all n, P(n) holds'],
    ['For every prime p, Q(p)', 'for every prime p, Q(p)'],
    ['For each n > 2, R(n)', 'for each n > 2, R(n)'],
    ['Always true for n odd', 'always true for n odd'],
    ['Never zero on the strip', 'never zero on the strip'],
  ]) {
    const hi = findRefutableGoal(cap);
    const lo = findRefutableGoal(low);
    assert.ok(hi, `"${cap}" should pair`);
    assert.ok(lo, `"${low}" should pair`);
    // `cue` echoes the matched text verbatim for the log, so it differs by case; the VERDICT must not.
    assert.equal(hi!.reason, lo!.reason, `"${cap}" and "${low}" must pair for the same reason`);
    assert.equal(hi!.cue.toLowerCase(), lo!.cue.toLowerCase());
  }
});

test('a capitalised DECISION goal is still screened out — the fix must not widen the net', () => {
  assert.equal(findRefutableGoal('Should we always pick the cheaper vendor for every region?'), null);
});
