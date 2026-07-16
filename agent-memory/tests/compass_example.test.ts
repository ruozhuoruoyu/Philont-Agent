import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCompass, compassBaselineTraits, clampTraitsToCompass, renderCompassForPrompt } from '../src/compass.js';

// Walk up from this file (src OR dist) until compass.example.md is found — robust to the rootDir layout
// (tsx runs from src/tests, `node --test` runs from dist/tests, and the file lives at the repo root).
function findExample(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, 'compass.example.md');
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error('compass.example.md not found walking up from ' + fileURLToPath(import.meta.url));
}

test('compass.example.md parses correctly through the real parser', () => {
  const text = readFileSync(findExample(), 'utf8');
  const c = parseCompass(text)!;
  assert.ok(c, 'the shipped example must parse');
  assert.deepEqual(c.drives.curiosity, { baseline: 0.60, bounds: [0.40, 0.80] });
  assert.deepEqual(c.drives.competitiveness, { baseline: 0.50, bounds: [0.30, 0.65] });
  assert.deepEqual(c.drives.conscientiousness, { baseline: 0.70, bounds: [0.55, 0.90] });
  assert.equal(c.focus.length, 1, 'exactly the one uncommented focus line (commented examples ignored)');
  assert.deepEqual(c.focus[0], { stake: 8, mode: 'active', name: 'philont itself' });
  // The commented "focus: 7 survey ..." examples must NOT be parsed.
  assert.ok(!c.focus.some((f) => f.name.includes('field I work in')), 'commented examples stay comments');
  assert.match(c.prose, /second mind/);
  // Sanity: the leash actually leashes.
  assert.equal(clampTraitsToCompass({ curiosity: 0.95, competitiveness: 0.5, conscientiousness: 0.5 }, c).curiosity, 0.80);
  assert.deepEqual(compassBaselineTraits(c), { curiosity: 0.60, competitiveness: 0.50, conscientiousness: 0.70 });
  assert.match(renderCompassForPrompt(c), /pursue\] philont itself/);
});
