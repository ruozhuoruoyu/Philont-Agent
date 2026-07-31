/**
 * 2026-07-31, the only skill the agent chose all day:
 *
 *   11:11:00  [tool] use_skill({"name":"verify-lrc-by-enumeration"})
 *   11:11:00  [skill-funnel] ACCEPTED use_skill('verify-lrc-by-enumeration') — subsequent actions
 *             will be credited to it
 *   13:06:24  [skill-funnel] pruned draft 'verify-lrc-by-enumeration' (score 0.548)
 *
 * Two hours. And the eviction reason is the `useCount > 0` branch of the log string, so the store knew it
 * had been used as it deleted it.
 *
 * The sort key above the filter already encoded the right idea — "declined" is `offeredCount >= 3 AND
 * useCount === 0`, because being CHOSEN is not being declined. The eligibility filter, which is the one
 * that decides who can actually die, tested only the offer count. Being chosen is the strongest positive
 * evidence this funnel can collect, and the cap was eating precisely that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

const draft = (name: string) => ({
  name,
  description: `d-${name}`,
  triggerKeywords: [name],
  actionTemplate: `do ${name}`,
  maturity: 'draft' as const,
});

/** Show a skill to the model `times` times, as the funnel does one turn at a time. */
function offer(skills: any, name: string, times: number) {
  for (let i = 0; i < times; i++) skills.recordSkillsOffered([name]);
}

/** Fill past the cap with drafts that have all been offered and none chosen. */
function seedDeclined(skills: any, n: number, offers = 5) {
  for (let i = 0; i < n; i++) {
    skills.createSkill(draft(`declined-${i}`));
    offer(skills, `declined-${i}`, offers);
  }
}

test('a draft the agent actually used is never evicted by the cap', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill(draft('verify-lrc-by-enumeration'));
  offer(skills, 'verify-lrc-by-enumeration', 13);
  skills.recordUsage('verify-lrc-by-enumeration');
  seedDeclined(skills, 12);

  skills.pruneDraftsToCap(5);

  assert.ok(
    skills.getByName('verify-lrc-by-enumeration'),
    'the one skill with positive evidence must survive the cap',
  );
});

test('declined drafts are still evicted, most-declined first', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill(draft('shown-a-lot'));
  offer(skills, 'shown-a-lot', 20);
  skills.createSkill(draft('shown-a-little'));
  offer(skills, 'shown-a-little', 3);

  const deleted = skills.pruneDraftsToCap(1);

  assert.equal(deleted, 1);
  assert.equal(skills.getByName('shown-a-lot'), null, 'strongest evidence of uselessness goes first');
  assert.ok(skills.getByName('shown-a-little'));
});

test('a never-offered draft is not evicted for losing a race it never entered', () => {
  const { skills } = openMemoryDb(':memory:');
  skills.createSkill(draft('never-shown'));
  skills.createSkill(draft('never-shown-2'));

  assert.equal(skills.pruneDraftsToCap(1), 0);
  assert.ok(skills.getByName('never-shown'));
  assert.ok(skills.getByName('never-shown-2'));
});

// Used drafts stay out of the eviction pool entirely — if every over-cap draft has been used, the cap
// deletes nothing and says so, rather than reaching for the one thing that worked.
test('a cap made entirely of used drafts deletes nothing', () => {
  const { skills } = openMemoryDb(':memory:');
  for (const n of ['used-a', 'used-b', 'used-c']) {
    skills.createSkill(draft(n));
    offer(skills, n, 9);
    skills.recordUsage(n);
  }
  assert.equal(skills.pruneDraftsToCap(1), 0);
  for (const n of ['used-a', 'used-b', 'used-c']) assert.ok(skills.getByName(n));
});
