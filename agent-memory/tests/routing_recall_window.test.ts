/**
 * 2026-07-30 weekly report: `routing rules: 1265 stored / 7 validated`.
 *
 * The search for the cause kept landing on the feedback side — the strong-failure set has been narrowed
 * twice for this exact symptom (interruptDrained 2026-07-13, sameRootCauseFailures 2026-07-21). The
 * feedback side was not the problem. match() was:
 *
 *     SELECT * FROM routing_rules WHERE confidence != 'retired'
 *     ORDER BY updated_at DESC LIMIT 100
 *
 * Pre-filter by RECENCY, then rank by RELEVANCE. 1165 of the 1265 active rules were never loaded into
 * the scorer at all. And createRule stamps updated_at = now, so every new rule pushed an older one off
 * the belt permanently — a rule only earns confidence while it is being injected, so once it fell off,
 * its tier froze at provisional forever and reflection minted a replacement that would fall off in turn.
 *
 * A FIFO conveyor belt in front of a relevance ranker discards precisely what relevance would pick. The
 * skill-recall cap was the same mechanism on a different table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, extractKeywords } from '../src/index.js';

const base = { carveout: 'only for this case', evidence: 'prod log 2026-07-30' };

test('a rule stays reachable after 200 newer rules are created', () => {
  const { routingRules } = openMemoryDb(':memory:');

  const target = routingRules.createRule({
    ...base,
    taskSignature: 'pari-gp-syntax',
    triggerCondition: 'pariGp reports a gp syntax error on a script',
    preferSkill: 'gp-syntax-repair',
  });

  // 200 unrelated rules, each newer than the target — the old window was 100
  for (let i = 0; i < 200; i++) {
    routingRules.createRule({
      ...base,
      taskSignature: `unrelated-${i}`,
      triggerCondition: `unrelated topic number ${i} about wombats and spreadsheets`,
      preferSkill: `skill-${i}`,
    });
  }

  const hits = routingRules.match(null, extractKeywords('pariGp reports a gp syntax error on a script'), {
    limit: 3,
  });
  assert.ok(
    hits.some((r) => r.id === target.id),
    'the rule that actually matches must be findable however many newer rules exist',
  );
});

test('the winner is chosen by relevance, not by how recently it was written', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const relevant = routingRules.createRule({
    ...base,
    taskSignature: 'z3-timeout',
    triggerCondition: 'z3Verify times out on a nonlinear arithmetic query',
    preferSkill: 'z3-tuning',
  });
  for (let i = 0; i < 120; i++) {
    routingRules.createRule({
      ...base,
      taskSignature: `noise-${i}`,
      triggerCondition: `noise ${i} concerning quarterly logistics reports`,
      preferSkill: `noise-skill-${i}`,
    });
  }
  const [top] = routingRules.match(null, extractKeywords('z3Verify times out on a nonlinear arithmetic query'), {
    limit: 1,
  });
  assert.equal(top?.id, relevant.id);
});

test('match still returns whole rules, not the projection it scans with', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'shell command not found on windows',
    preferSkill: 'win-shell',
    carveout: 'windows only',
    evidence: 'prod 2026-07-30 exitCode 127',
  });
  const [r] = routingRules.match(null, extractKeywords('shell command not found on windows'), { limit: 1 });
  assert.equal(r.triggerCondition, 'shell command not found on windows');
  assert.equal(r.evidence, 'prod 2026-07-30 exitCode 127');
  assert.equal(r.carveout, 'windows only');
  assert.equal(r.confidence, 'provisional');
});

// ── creation side ────────────────────────────────────────────────────────────────────────────────
//
// Dedup used to require an EXACT task_signature match, and task_signature is a "<short task label>" the
// model writes freehand at every reflection. Three phrasings of one lesson are three buckets, so dedup
// could almost never fire and the table grew a row per reflection. The signature is a label, not a key.

test('the same lesson under a different label is deduped, not stored twice', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const first = routingRules.createRule({
    ...base,
    taskSignature: 'pari-gp-syntax',
    triggerCondition: 'pariGp gp syntax error in the script body',
    preferSkill: 'gp-syntax-repair',
  });
  const second = routingRules.createRule({
    ...base,
    taskSignature: 'gp 语法错误',            // the model relabelled the same lesson
    triggerCondition: 'pariGp gp syntax error in the script body',
    preferSkill: 'gp-syntax-repair',
    evidence: 'prod 2026-07-31, seen again',
  });
  assert.equal(second.id, first.id, 'one lesson, one row');
  assert.equal(routingRules.count(), 1);
  assert.match(second.evidence, /seen again/, 'the merge refreshes the evidence');
});

test('the same trigger with a DIFFERENT preferSkill is contradictory advice, never merged', () => {
  const { routingRules } = openMemoryDb(':memory:');
  const a = routingRules.createRule({
    ...base,
    taskSignature: 'lookup',
    triggerCondition: 'user asks to look up a paper by title',
    preferSkill: 'arxiv-search',
  });
  const b = routingRules.createRule({
    ...base,
    taskSignature: 'lookup',
    triggerCondition: 'user asks to look up a paper by title',
    preferSkill: 'web-search',
  });
  assert.notEqual(b.id, a.id, 'merging would silently keep the stale recommendation');
  assert.equal(routingRules.count(), 2);
});

test('unrelated triggers sharing a preferSkill are still separate rules', () => {
  const { routingRules } = openMemoryDb(':memory:');
  routingRules.createRule({
    ...base,
    taskSignature: 'a',
    triggerCondition: 'convert a docx file to markdown',
    preferSkill: 'office',
  });
  routingRules.createRule({
    ...base,
    taskSignature: 'b',
    triggerCondition: 'build a pivot table from quarterly sales',
    preferSkill: 'office',
  });
  assert.equal(routingRules.count(), 2, '0.7 keyword overlap is the bar, not "same skill"');
});
