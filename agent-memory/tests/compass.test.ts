import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompass, clampTraitsToCompass, compassBaselineTraits, renderCompassForPrompt } from '../src/compass.js';

const SAMPLE = `---
# drives
curiosity: 0.70 [0.45, 0.85]
competitiveness: 0.55 [0.30, 0.70]
conscientiousness: 0.80 [0.65, 0.95]

# focus
focus: 9 active philont itself
focus: 7 survey AI agent field & rivals
focus: 5 survey number theory & open problems
---
You are my second mind. Honesty is the foundation.
`;

test('parseCompass: reads drives, focus, and prose', () => {
  const c = parseCompass(SAMPLE)!;
  assert.equal(c.drives.curiosity!.baseline, 0.70);
  assert.deepEqual(c.drives.curiosity!.bounds, [0.45, 0.85]);
  assert.equal(c.drives.conscientiousness!.bounds[1], 0.95);
  assert.equal(c.focus.length, 3);
  assert.deepEqual(c.focus[0], { stake: 9, mode: 'active', name: 'philont itself' });
  assert.equal(c.focus[1].mode, 'survey');
  assert.match(c.prose, /second mind/);
});

test('parseCompass: lenient — empty → null, garbage lines ignored, values clamped', () => {
  assert.equal(parseCompass(''), null);
  assert.equal(parseCompass('   '), null);
  const c = parseCompass(`---
curiosity: 1.5 [0.9, 0.2]
random nonsense line
focus: 99 active over-staked
focus: 3 weird-mode not-a-real-focus
---
prose`)!;
  assert.equal(c.drives.curiosity!.baseline, 0.9, 'baseline clamped into the (reversed→fixed) bounds');
  assert.deepEqual(c.drives.curiosity!.bounds, [0.2, 0.9], 'reversed bounds tolerated');
  assert.equal(c.focus[0].stake, 10, 'stake clamped to <=10');
  assert.equal(c.focus.length, 1, 'the invalid-mode focus line is ignored');
});

test('clampTraitsToCompass: live traits move inside the leash, never across it', () => {
  const c = parseCompass(SAMPLE);
  // curiosity bound [0.45,0.85]: a live 0.95 is pulled to 0.85; a live 0.60 is left alone.
  assert.equal(clampTraitsToCompass({ curiosity: 0.95, competitiveness: 0.5, conscientiousness: 0.5 }, c).curiosity, 0.85);
  assert.equal(clampTraitsToCompass({ curiosity: 0.60, competitiveness: 0.5, conscientiousness: 0.5 }, c).curiosity, 0.60);
  // competitiveness bound max 0.70: a live 0.90 (very driven) is capped — winning can't run past the leash.
  assert.equal(clampTraitsToCompass({ curiosity: 0.5, competitiveness: 0.90, conscientiousness: 0.5 }, c).competitiveness, 0.70);
  // no compass → untouched.
  assert.equal(clampTraitsToCompass({ curiosity: 0.99, competitiveness: 0.5, conscientiousness: 0.5 }, null).curiosity, 0.99);
});

test('compassBaselineTraits: compass baselines, 0.5 fallback', () => {
  assert.deepEqual(compassBaselineTraits(parseCompass(SAMPLE)), { curiosity: 0.70, competitiveness: 0.55, conscientiousness: 0.80 });
  assert.deepEqual(compassBaselineTraits(null), { curiosity: 0.5, competitiveness: 0.5, conscientiousness: 0.5 });
});

test('renderCompassForPrompt: prose + focus with survey/active tags', () => {
  const out = renderCompassForPrompt(parseCompass(SAMPLE));
  assert.match(out, /second mind/);
  assert.match(out, /pursue\] philont itself/);
  assert.match(out, /survey only — track, do not try to solve\] number theory/);
  assert.equal(renderCompassForPrompt(null), '');
});
