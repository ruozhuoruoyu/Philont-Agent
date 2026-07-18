import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlanId } from '../src/plan_tools.js';

const A = 'f8eb654a-55fa-408f-8955-c9fb736efab4';
const B = '2d3fb4ac-8c51-4d30-929d-604ff2717c2c';

test('exact id wins', () => {
  assert.equal(resolvePlanId(A, [A, B]), A);
});

test('the single open plan resolves an id the model invented (prod cases, verbatim)', () => {
  // Every one of these appeared in ONE production run and cost a wasted round trip.
  for (const bogus of [
    'plan_01',
    'placeholder-missing-id',
    'plan_7c3f2a1b',
    'f813c956-c08b-4143-b79c-5a92f11ae2e0',                                  // plausible but wrong UUID
    'aeb69a88-059a-4f49-832e-3d7b9fca3aced4f2881b-3c28-4562-9a02-19a1e4c0f5ed', // two UUIDs concatenated
  ]) {
    assert.equal(resolvePlanId(bogus, [A]), A, `should resolve "${bogus}" to the only open plan`);
  }
});

test('a unique long prefix resolves (truncated transcription)', () => {
  assert.equal(resolvePlanId('f8eb654a-55fa', [A, B]), A);
});

test('REFUSES to guess when genuinely ambiguous', () => {
  // Two open plans and no id match → there is a real choice to make; do not make it.
  assert.equal(resolvePlanId('plan_01', [A, B]), null);
  // No open plans at all → nothing to resolve to.
  assert.equal(resolvePlanId('plan_01', []), null);
  // A short prefix could match either → ambiguous.
  assert.equal(resolvePlanId('f', [A, B]), null);
});

test('a too-short prefix does not trigger prefix matching even with one open plan-set entry', () => {
  // Falls through to the single-open-plan rule rather than a 1-char "prefix match".
  assert.equal(resolvePlanId('f', [A]), A);
});
