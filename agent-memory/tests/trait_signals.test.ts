/**
 * WS1 (selfhood_closure): trait signal helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ewma01FromScores, ratioWithShrinkage } from '../src/index.js';

test('ewma01FromScores: empty -> undefined; positive history rises above neutral; negative sinks', () => {
  assert.equal(ewma01FromScores([]), undefined);
  const up = ewma01FromScores([0.5, 0.8, 0.9, 0.7]);
  assert.ok(up !== undefined && up > 0.6, `positive history should exceed 0.6, got ${up}`);
  const down = ewma01FromScores([-0.6, -0.8, -0.5]);
  assert.ok(down !== undefined && down < 0.4, `negative history should fall below 0.4, got ${down}`);
  // Out-of-range scores are clamped, non-finite ignored
  const clamped = ewma01FromScores([5, Number.NaN, -5]);
  assert.ok(clamped !== undefined && clamped >= 0 && clamped <= 1);
});

test('ratioWithShrinkage: no samples -> undefined; small samples stay near neutral; volume earns conviction', () => {
  assert.equal(ratioWithShrinkage(0, 0), undefined);
  // 1/1 success: shrinkage keeps it well under a naive 1.0
  const one = ratioWithShrinkage(1, 0)!;
  assert.ok(one > 0.5 && one < 0.65, `single success should barely move the needle, got ${one}`);
  // 20/20 success: conviction approaches the raw ratio
  const many = ratioWithShrinkage(20, 0)!;
  assert.ok(many > 0.85, `sustained success should approach 1, got ${many}`);
  // Failures pull below neutral symmetrically
  const bad = ratioWithShrinkage(0, 20)!;
  assert.ok(bad < 0.15, `sustained failure should approach 0, got ${bad}`);
});
