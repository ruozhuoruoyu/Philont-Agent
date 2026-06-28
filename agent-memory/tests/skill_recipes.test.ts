/**
 * H2 — skill recipes: callable gate + author-from-verified-success + reuse maturity move (pure).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCallableRecipe,
  shouldAuthorRecipe,
  recipeReuseMaturityMove,
  buildRecipeFields,
  type Recipe,
} from '../src/skill_recipes.js';

const recipe = (over: Partial<Recipe> = {}): Recipe => ({
  name: 'r',
  trigger: 'when X',
  steps: 'call toolA then toolB',
  toolPolicy: ['toolA', 'toolB'],
  verification: { kind: 'tool_result_ok', check: 'toolB' },
  ...over,
});

test('isCallableRecipe: callable only with verification + steps + tool policy', () => {
  assert.equal(isCallableRecipe(recipe()), true);
  assert.equal(isCallableRecipe(recipe({ verification: null })), false, 'no verification → advisory lesson, not callable');
  assert.equal(isCallableRecipe(recipe({ steps: '   ' })), false, 'no steps → not callable');
  assert.equal(isCallableRecipe(recipe({ toolPolicy: [] })), false, 'no tool policy → not callable');
});

test('shouldAuthorRecipe: only from a ledger-verified success with a verification', () => {
  const base = { closedSuccessfully: true, ledgerVerified: true, hasVerification: true };
  assert.equal(shouldAuthorRecipe(base), true);
  assert.equal(shouldAuthorRecipe({ ...base, closedSuccessfully: false }), false, 'not a success → no');
  assert.equal(shouldAuthorRecipe({ ...base, ledgerVerified: false }), false, 'narrated (not ledger) success → no');
  assert.equal(shouldAuthorRecipe({ ...base, hasVerification: false }), false, 'no verification to attach → no');
});

test('recipeReuseMaturityMove: pass → promote, fail → demote/revise (SkillClaw evolution)', () => {
  assert.equal(recipeReuseMaturityMove(true), 'promote');
  assert.equal(recipeReuseMaturityMove(false), 'demote_revise');
});

test('buildRecipeFields: verification (assert) from deliverables + tool_policy recovered from step text', () => {
  const r = buildRecipeFields({
    planId: 'p1',
    deliverables: ['register webhook', 'verify heartbeat'],
    stepText: '1. call webSearch for docs\n2. run shell to register\n3. readFile to confirm',
  });
  assert.equal(r.verification.kind, 'assert');
  assert.match(r.verification.check, /2 declared deliverable/);
  assert.deepEqual([...r.toolPolicy].sort(), ['readFile', 'shell', 'webSearch']);
});

test('buildRecipeFields: no deliverables / no known tools → spec-coverage check + empty policy', () => {
  const r = buildRecipeFields({ planId: 'p2', deliverables: [], stepText: 'do the thing manually' });
  assert.match(r.verification.check, /spec-coverage gate passed/);
  assert.deepEqual(r.toolPolicy, []);
});
