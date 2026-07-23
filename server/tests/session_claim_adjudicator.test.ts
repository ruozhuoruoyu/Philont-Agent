/**
 * Deciding what a paragraph ASSERTS belongs to a model, not to a word list.
 *
 * The list written for this on 2026-07-23 mis-read "No deep_explore session is running right now" as a
 * claim that one WAS — the gate would have accused the model of fabricating a session in the very sentence
 * where it correctly said there wasn't one. Same structural limit that made a keyword authorization
 * classifier read three ordinary questions as consent: a list cannot represent negation or hedging.
 *
 * What the list stays good for is being a FLOOR that always runs. These tests pin the ceiling's contract:
 * consulted only inside a window defined by ground truth, and returning `unknown` on every failure path so
 * an absent aux leaves the floor rather than deleting the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSessionClaimVerdict,
  shouldAdjudicateSessionClaim,
  buildSessionClaimPrompt,
} from '../src/session_claim_adjudicator.js';

const LONG = 'x'.repeat(200);

test('consulted only when ground truth says a claim COULD be fabricated', () => {
  const base = { hasActiveSession: false, deepExploreSucceededThisTurn: false, textLength: 200 };
  assert.equal(shouldAdjudicateSessionClaim(base), true);
  // A session really exists → nothing to catch.
  assert.equal(shouldAdjudicateSessionClaim({ ...base, hasActiveSession: true }), false);
  // A deep_explore call succeeded this turn → the claim is true even if the tree snapshot is stale.
  assert.equal(shouldAdjudicateSessionClaim({ ...base, deepExploreSucceededThisTurn: true }), false);
  // A one-liner has no room to narrate a session it did not run.
  assert.equal(shouldAdjudicateSessionClaim({ ...base, textLength: 20 }), false);
});

test('kill switch leaves the pattern floor in place', () => {
  const prev = process.env.PHILONT_HONESTY_SESSION_ADJUDICATOR;
  process.env.PHILONT_HONESTY_SESSION_ADJUDICATOR = '0';
  try {
    assert.equal(
      shouldAdjudicateSessionClaim({ hasActiveSession: false, deepExploreSucceededThisTurn: false, textLength: 999 }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.PHILONT_HONESTY_SESSION_ADJUDICATOR;
    else process.env.PHILONT_HONESTY_SESSION_ADJUDICATOR = prev;
  }
});

test('only an anchored one-word answer is a verdict', () => {
  assert.equal(parseSessionClaimVerdict('YES'), 'asserts');
  assert.equal(parseSessionClaimVerdict(' no\n'), 'does_not_assert');
  // A narrative that merely CONTAINS "yes" is not a verdict — reading it as one is how a judge starts
  // agreeing with whatever it just read.
  assert.equal(parseSessionClaimVerdict('Well, yes and no — it depends'), 'unknown');
  assert.equal(parseSessionClaimVerdict(''), 'unknown');
  assert.equal(parseSessionClaimVerdict('{"answer": "YES"}'), 'unknown');
});

test('the prompt asks what the text STATES, never whether its author lied', () => {
  const p = buildSessionClaimPrompt(LONG);
  // The aux model is currently the same model as the main one; asking it to audit its own honesty is the
  // weakest possible check, so the question is posed as reading comprehension with no stake attached.
  assert.doesNotMatch(p, /fabricat|lie|dishonest|hallucinat/i);
  assert.match(p, /what a piece of text ASSERTS|does the reply state/i);
  // The distinctions the pattern list could not make must be spelled out for the model.
  assert.match(p, /intention or offer to start one/);
  assert.match(p, /that none exists/);
  assert.match(p, /a question/);
});
