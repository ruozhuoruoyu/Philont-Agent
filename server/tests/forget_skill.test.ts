/**
 * forget_skill selection logic — unit tests for selectSkillsToForget.
 *
 * Verifies:
 *   1. Bulk delete of self-learned skills by case-insensitive substring (name/desc/keywords).
 *   2. File-backed skills (name on disk) are NEVER selected — they belong to uninstallSkill.
 *   3. Exact name match deletes only that skill (and is still disk-protected).
 *   4. name wins over contains; empty query / no-match select nothing.
 *
 * Motivation: self-learned (reflection/plan-distilled) skills are DB-only, so uninstallSkill
 * (which removes a directory) could not reach them — "delete the mycox skills" left them behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSkillsToForget, type ForgettableSkill } from '../src/forget_skill.js';

const S = (name: string, description = '', triggerKeywords: string[] = []): ForgettableSkill => ({
  name,
  description,
  triggerKeywords,
});

const SKILLS: ForgettableSkill[] = [
  S('mycox-daily-checkin-routine', 'fetch hot posts with fallback if v1 feed fails', ['mycox', 'checkin']),
  S('mycox-register-and-onboard', 'register a new mycox account', ['mycox', 'register']),
  S('playbook-auto-slow-dbbec789-fail-p3fakw', 'plan protocol inappropriate for simple check-ins', ['MyCox', 'checkin']),
  S('thermo-landauer', 'thermodynamics of computation', ['entropy']),
  S('clawhub-weather', 'bundled weather skill mentioning mycox in passing', []),
];

const names = (xs: ForgettableSkill[]) => xs.map((s) => s.name);

test('forget_skill: bulk-deletes self-learned skills by case-insensitive substring across name/desc/keywords', () => {
  const got = names(selectSkillsToForget(SKILLS, new Set(), { contains: 'mycox' }));
  // matches two mycox-* (name), the fail playbook (keyword "MyCox"), and clawhub-weather (desc mentions mycox)
  assert.deepEqual(got, [
    'mycox-daily-checkin-routine',
    'mycox-register-and-onboard',
    'playbook-auto-slow-dbbec789-fail-p3fakw',
    'clawhub-weather',
  ]);
});

test('forget_skill: NEVER deletes a file-backed skill (name on disk), even if it matches', () => {
  const onDisk = new Set(['clawhub-weather']);
  const got = names(selectSkillsToForget(SKILLS, onDisk, { contains: 'mycox' }));
  assert.ok(!got.includes('clawhub-weather'));
  assert.deepEqual(got, [
    'mycox-daily-checkin-routine',
    'mycox-register-and-onboard',
    'playbook-auto-slow-dbbec789-fail-p3fakw',
  ]);
});

test('forget_skill: exact name match deletes only that skill', () => {
  const got = names(selectSkillsToForget(SKILLS, new Set(), { name: 'mycox-register-and-onboard' }));
  assert.deepEqual(got, ['mycox-register-and-onboard']);
});

test('forget_skill: exact name match is protected if the skill is file-backed (on disk)', () => {
  const got = selectSkillsToForget(SKILLS, new Set(['mycox-register-and-onboard']), {
    name: 'mycox-register-and-onboard',
  });
  assert.deepEqual(got, []);
});

test('forget_skill: name wins over contains when both are present', () => {
  const got = names(selectSkillsToForget(SKILLS, new Set(), { name: 'thermo-landauer', contains: 'mycox' }));
  assert.deepEqual(got, ['thermo-landauer']);
});

test('forget_skill: empty query selects nothing (caller rejects)', () => {
  assert.deepEqual(selectSkillsToForget(SKILLS, new Set(), {}), []);
  assert.deepEqual(selectSkillsToForget(SKILLS, new Set(), { name: '  ', contains: '   ' }), []);
});

test('forget_skill: no match returns empty', () => {
  assert.deepEqual(selectSkillsToForget(SKILLS, new Set(), { contains: 'nonexistent-topic' }), []);
});

// ── max_use_count criterion (bulk "delete unused" — prod: 26 one-by-one calls + 7 file-backed fails) ──
const U = (name: string, useCount: number): ForgettableSkill => ({ name, description: '', triggerKeywords: [], useCount });

test('forget_skill: max_use_count=0 selects only never-used self-learned skills, skips file-backed', () => {
  const skills = [U('never-a', 0), U('used', 5), U('never-b', 0), U('never-file', 0)];
  const got = names(selectSkillsToForget(skills, new Set(['never-file']), { maxUseCount: 0 }));
  assert.deepEqual(got, ['never-a', 'never-b']); // used(5) filtered out, never-file protected
});

test('forget_skill: max_use_count=2 includes 0..2 uses, excludes higher', () => {
  const skills = [U('a', 0), U('b', 2), U('c', 3)];
  const got = names(selectSkillsToForget(skills, new Set(), { maxUseCount: 2 }));
  assert.deepEqual(got, ['a', 'b']);
});

test('forget_skill: contains + max_use_count combine as AND', () => {
  const skills = [
    { name: 'mycox-a', description: '', triggerKeywords: ['mycox'], useCount: 0 },
    { name: 'mycox-b', description: '', triggerKeywords: ['mycox'], useCount: 9 },
    { name: 'other', description: '', triggerKeywords: [], useCount: 0 },
  ];
  const got = names(selectSkillsToForget(skills, new Set(), { contains: 'mycox', maxUseCount: 0 }));
  assert.deepEqual(got, ['mycox-a']); // mycox AND useCount<=0
});

test('forget_skill: missing useCount treated as 0 (never used)', () => {
  const got = names(selectSkillsToForget([{ name: 'no-count', description: '', triggerKeywords: [] }], new Set(), { maxUseCount: 0 }));
  assert.deepEqual(got, ['no-count']);
});

test('forget_skill: empty query (no name/contains/maxUseCount) still selects nothing', () => {
  assert.deepEqual(selectSkillsToForget([U('a', 0)], new Set(), {}), []);
});
