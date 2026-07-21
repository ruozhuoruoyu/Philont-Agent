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

import { reconcileCompassPursuits, compassPursuitId } from '../src/compass.js';

test('reconcileCompassPursuits: create missing, update drifted stake, archive removed', () => {
  const compass = parseCompass(`---
focus: 8 active philont itself
focus: 6 survey AI agent field
---
p`)!;
  // existing: one matching compass pursuit (stake drifted), one compass pursuit no longer in focus, one non-compass.
  const existing = [
    { id: compassPursuitId('philont itself'), origin: 'compass', stakeWeight: 5 }, // drifted 5 → 8
    { id: 'compass-old-removed-abc12345', origin: 'compass', stakeWeight: 7 }, // removed from compass → archive
    { id: 'some-user-pursuit', origin: 'user', stakeWeight: 9 }, // not compass → untouched
  ];
  const r = reconcileCompassPursuits(compass, existing);

  // create: the survey focus has no pursuit yet
  assert.equal(r.create.length, 1);
  assert.equal(r.create[0].id, compassPursuitId('AI agent field'));
  assert.equal(r.create[0].mode, 'survey');
  assert.match(r.create[0].intent, /SURVEY-ONLY/);
  assert.equal(r.create[0].stakeWeight, 6);
  // active focus intent frames it to advance, not survey
  // updateStake: philont-itself drifted 5 → 8
  assert.deepEqual(r.updateStake, [{ id: compassPursuitId('philont itself'), stakeWeight: 8 }]);
  // archive: the removed compass pursuit (never the user pursuit)
  assert.deepEqual(r.archive, ['compass-old-removed-abc12345']);
});

test('reconcileCompassPursuits: no compass → archive all previously-seeded compass pursuits', () => {
  const existing = [
    { id: 'compass-a-deadbeef', origin: 'compass', stakeWeight: 8 },
    { id: 'keep-me', origin: 'user', stakeWeight: 5 },
  ];
  const r = reconcileCompassPursuits(null, existing);
  assert.deepEqual(r.archive, ['compass-a-deadbeef']);
  assert.equal(r.create.length, 0);
});

test('reconcileCompassPursuits: active focus intent says advance, survey says do-not-solve', () => {
  const c = parseCompass(`---
focus: 9 active build the thing
focus: 4 survey some field
---
p`)!;
  const r = reconcileCompassPursuits(c, []);
  const active = r.create.find((d) => d.id === compassPursuitId('build the thing'))!;
  const survey = r.create.find((d) => d.id === compassPursuitId('some field'))!;
  assert.match(active.intent, /Advance it/);
  assert.doesNotMatch(active.intent, /do NOT attempt/);
  assert.match(survey.intent, /do NOT attempt to solve/);
});

import { openMemoryDb } from '../src/index.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from '../src/schema.js';

test('compass focus → real seeded pursuits, idempotent + reconciled against a live store', () => {
  const { pursuits } = openMemoryDb(':memory:');
  const apply = (compass: ReturnType<typeof parseCompass>) => {
    const existing = pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).map((p) => ({ id: p.id, origin: p.origin, stakeWeight: p.stakeWeight }));
    const plan = reconcileCompassPursuits(compass, existing);
    for (const d of plan.create) pursuits.createChild({ parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID, id: d.id, title: d.title, intent: d.intent, stakeWeight: d.stakeWeight, origin: 'compass', status: 'active' });
    for (const u of plan.updateStake) pursuits.setStakeWeight(u.id, u.stakeWeight);
    for (const id of plan.archive) pursuits.updateStatus(id, 'archived');
  };
  const compassPursuits = () => pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).filter((p) => p.origin === 'compass');

  // First load: two focus areas → two active compass pursuits the drivers' listActive can see.
  apply(parseCompass(`---
focus: 8 active philont itself
focus: 6 survey the field
---
p`));
  let seeded = compassPursuits();
  assert.equal(seeded.length, 2);
  assert.equal(seeded.find((p) => p.id === compassPursuitId('philont itself'))!.stakeWeight, 8);

  // Re-apply the SAME compass (a restart): idempotent — still exactly two, no duplicates.
  apply(parseCompass(`---
focus: 8 active philont itself
focus: 6 survey the field
---
p`));
  assert.equal(compassPursuits().length, 2, 'idempotent across restarts — no duplicate seeding');

  // Owner edits: drops "the field", bumps philont stake to 9. → one archived, one stake-synced.
  apply(parseCompass(`---
focus: 9 active philont itself
---
p`));
  const after = compassPursuits();
  assert.equal(after.length, 1, 'removed focus is archived out of active');
  assert.equal(after[0].id, compassPursuitId('philont itself'));
  assert.equal(after[0].stakeWeight, 9, 'stake edit synced');
});

test('compassPursuitId: a Chinese focus name still yields a valid, stable id', () => {
  const id = compassPursuitId('自演进 agent 研究');
  assert.match(id, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'must satisfy the pursuit id grammar');
  assert.equal(compassPursuitId('自演进 agent 研究'), id, 'deterministic — same name → same id');
  assert.notEqual(compassPursuitId('自演进 agent 研究'), compassPursuitId('another topic'), 'distinct names → distinct ids');
});

test('a seeded focus arrives ACTIONABLE — with an opening question a driver can advance', () => {
  // Without one the pursuit is inert: PursuitDriver can only advance a pursuit that has an open question or
  // resolutionCriteria, and nothing ever wrote either for a compass focus. Prod 2026-07-21: the owner's
  // focus area sat in the table while every autonomous tick went to free curiosity instead.
  const compass = parseCompass(`---
focus: 9 active philont itself
focus: 6 survey AI agent field
---
prose`);
  const r = reconcileCompassPursuits(compass, []);
  assert.equal(r.create.length, 2);
  for (const d of r.create) {
    assert.ok(d.openingQuestion && d.openingQuestion.trim().length > 0, `${d.title} must arrive with a question`);
    assert.ok(d.openingQuestion.includes(d.title), 'the question must be about THIS focus, not a generic stub');
  }
  // Mode is carried into the phrasing: a survey focus must not be told to advance/solve anything.
  const active = r.create.find((d) => d.mode === 'active')!;
  const survey = r.create.find((d) => d.mode === 'survey')!;
  assert.match(active.openingQuestion, /advance/i);
  assert.match(survey.openingQuestion, /summarize|track/i);
  assert.match(survey.openingQuestion, /do not attempt to solve/i, 'survey mode must stay observational');
});
