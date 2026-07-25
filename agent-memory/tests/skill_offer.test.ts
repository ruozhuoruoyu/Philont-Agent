/**
 * The wording of the skill index — the one funnel rung made purely of prompt text.
 *
 * 7 days, 689 turns, 94 skills, six offered every turn, use_skill called ZERO times. See skill_offer.ts
 * for why the old block ("Available skills (use use_skill(name) to get details)") could not have worked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSkillOffer, skillEvidenceTag, hasUntried } from '../src/skill_offer.js';
import type { OfferableSkill } from '../src/skill_offer.js';

const skill = (o: Partial<OfferableSkill> & { name: string }): OfferableSkill => ({
  description: 'does a thing',
  maturity: 'draft',
  useCount: 0,
  successCount: 0,
  failureCount: 0,
  ...o,
});

test('the evidence tag states the record, not a grade', () => {
  assert.equal(skillEvidenceTag(skill({ name: 'a', useCount: 6, successCount: 6, failureCount: 0 })), '✓ worked 6/6');
  // A bad record is stated too — the model is right to skip that one.
  assert.equal(skillEvidenceTag(skill({ name: 'b', useCount: 5, successCount: 2, failureCount: 3 })), '2/5 worked');
  assert.equal(skillEvidenceTag(skill({ name: 'c', useCount: 3 })), 'used 3×, outcome unrecorded');
  assert.equal(skillEvidenceTag(skill({ name: 'd' })), '⚑ never tried');
});

test('the header sells the value, not the mechanism', () => {
  const [header] = renderSkillOffer([skill({ name: 'x', useCount: 2, successCount: 2 })]);
  assert.match(header, /use_skill\(name\)/, 'it must still name the call');
  assert.match(header, /BEFORE improvising/, 'the reason to spend the call');
  assert.doesNotMatch(header, /get details/, 'a lookup returning "details" is not worth a round-trip');
});

test("every offered skill carries its record where the model reads the name", () => {
  const lines = renderSkillOffer([
    skill({ name: 'send-wechat-files-and-verify-size', useCount: 6, successCount: 6, description: 'send + verify' }),
    skill({ name: 'test-mycielski-construction-on-graph', description: 'try Mycielski' }),
  ]).join('\n');
  assert.match(lines, /send-wechat-files-and-verify-size — ✓ worked 6\/6/);
  assert.match(lines, /test-mycielski-construction-on-graph — ⚑ never tried/);
});

test('an untried entry gets a reason to be picked, not just a label', () => {
  const withDraft = renderSkillOffer([skill({ name: 'proven', useCount: 4, successCount: 4 }), skill({ name: 'fresh' })]);
  const closing = withDraft[withDraft.length - 1];
  assert.match(closing, /⚑/);
  assert.match(closing, /earn or lose its place/, 'trying it is the only way the ladder turns');

  // …and no such line when everything on offer has a record — no manufactured noise.
  const allProven = renderSkillOffer([skill({ name: 'proven', useCount: 4, successCount: 4 })]);
  assert.doesNotMatch(allProven.join('\n'), /earn or lose its place/);
});

test('hasUntried is about evidence, not the maturity label', () => {
  // A row can sit at maturity 'draft' and still have been run (disk skills, refined recipes).
  assert.equal(hasUntried([skill({ name: 'a', maturity: 'draft', useCount: 2, successCount: 2 })]), false);
  assert.equal(hasUntried([skill({ name: 'b', maturity: 'stable' })]), true, 'stable but never actually run');
});

test('provenance and when-to-use survive; a long when-to-use is truncated', () => {
  const lines = renderSkillOffer([
    skill({ name: 'x', source: 'clawhub:foo@1.0.0', whenToUse: 'w'.repeat(200) }),
  ]).join('\n');
  assert.match(lines, /\[clawhub\]/);
  assert.match(lines, /Use when: w+…/);
});

test('an empty offer renders nothing at all', () => {
  assert.deepEqual(renderSkillOffer([]), []);
});
