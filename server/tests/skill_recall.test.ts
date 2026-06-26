/**
 * skill_recall unit tests (P0).
 *
 * Covers the shared selector + flag:
 *   (a) flag OFF => recallRelevanceEnabled() === false
 *   (b) blank/whitespace/punctuation-only/CJK-sub-trigram query => fallback().slice(0,k) unchanged
 *   (c) pool predicates partition correctly (positive/negative/playbook disjoint)
 *   (d) jaccard re-rank: a use_count=0 but query-relevant skill outranks a high-use_count
 *       irrelevant one (cold-start mitigation via wide candidate pull)
 *   (e) fill: matched<k appends from fallback deduped-by-name until k; len===min(k,total), no dup
 *   (f) Chinese query with zero FTS hits => fallback fill fires (no worse than today)
 *
 * Uses the same in-memory db helper as deep_explore.test.ts: openMemoryDb(':memory:').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import type { Skill, SkillStore } from '@agent/memory';
import { recallRelevanceEnabled, selectRelevantSkills } from '../src/skill_recall.js';

function makeStore(): SkillStore {
  return openMemoryDb(':memory:').skills;
}

function add(
  skills: SkillStore,
  name: string,
  description: string,
  opts: {
    kind?: 'positive' | 'negative';
    maturity?: 'draft' | 'confirmed' | 'stable' | 'playbook' | 'deprecated';
    keywords?: string[];
    whenToUse?: string;
  } = {},
): void {
  skills.createSkill({
    name,
    description,
    triggerKeywords: opts.keywords ?? [],
    actionTemplate: '',
    whenToUse: opts.whenToUse ?? '',
    kind: opts.kind ?? 'positive',
    maturity: opts.maturity ?? 'draft',
  });
}

// (a) flag default OFF.
test('recallRelevanceEnabled defaults ON; only an explicit off-ish value disables', () => {
  const prev = process.env.PHILONT_SKILL_RECALL_RELEVANCE;
  delete process.env.PHILONT_SKILL_RECALL_RELEVANCE;
  try {
    assert.equal(recallRelevanceEnabled(), true, 'unset → ON (default)');
    process.env.PHILONT_SKILL_RECALL_RELEVANCE = '';
    assert.equal(recallRelevanceEnabled(), true, 'empty → ON');
    for (const off of ['0', 'off', 'false', 'no', 'OFF']) {
      process.env.PHILONT_SKILL_RECALL_RELEVANCE = off;
      assert.equal(recallRelevanceEnabled(), false, `${off} → OFF`);
    }
    for (const on of ['1', 'true', 'on']) {
      process.env.PHILONT_SKILL_RECALL_RELEVANCE = on;
      assert.equal(recallRelevanceEnabled(), true, `${on} → ON`);
    }
  } finally {
    if (prev === undefined) delete process.env.PHILONT_SKILL_RECALL_RELEVANCE;
    else process.env.PHILONT_SKILL_RECALL_RELEVANCE = prev;
  }
});

// (b) token-empty queries return fallback().slice(0,k) unchanged.
test('blank/whitespace/punctuation/CJK-sub-trigram query returns fallback unchanged', () => {
  const skills = makeStore();
  add(skills, 'alpha', 'deploy a kubernetes cluster');
  add(skills, 'beta', 'write a python script');
  add(skills, 'gamma', 'format a json document');

  const fallback = () => skills.listAll(40);
  const k = 2;
  const expected = fallback().slice(0, k);

  for (const q of ['', '   ', '\t\n', '!@#$%^&*()', 'a', '中']) {
    const got = selectRelevantSkills(skills, q, { pool: 'positive', k, fallback });
    assert.deepEqual(
      got.map((s) => s.name),
      expected.map((s) => s.name),
      `query ${JSON.stringify(q)} should pass through to fallback().slice(0,k)`,
    );
  }
});

// (c) pool predicates partition the corpus disjointly.
test('pool predicates partition positive/negative/playbook disjointly', () => {
  const skills = makeStore();
  add(skills, 'pos-draft', 'kubernetes deployment helper', { keywords: ['kubernetes'] });
  add(skills, 'pos-stable', 'kubernetes scaling helper', { maturity: 'stable', keywords: ['kubernetes'] });
  add(skills, 'neg-anti', 'never hardcode kubernetes secrets', { kind: 'negative', keywords: ['kubernetes'] });
  add(skills, 'play-lesson', 'kubernetes rollout playbook', { maturity: 'playbook', keywords: ['kubernetes'] });
  // a negative-playbook must NOT appear in the negative pool (excluded by maturity!=='playbook').
  add(skills, 'neg-play', 'kubernetes negative playbook', {
    kind: 'negative',
    maturity: 'playbook',
    keywords: ['kubernetes'],
  });

  const fallback = () => [] as Skill[];
  const q = 'kubernetes';

  const pos = selectRelevantSkills(skills, q, { pool: 'positive', k: 10, fallback }).map((s) => s.name);
  const neg = selectRelevantSkills(skills, q, { pool: 'negative', k: 10, fallback }).map((s) => s.name);
  const play = selectRelevantSkills(skills, q, { pool: 'playbook', k: 10, fallback }).map((s) => s.name);

  assert.deepEqual(new Set(pos), new Set(['pos-draft', 'pos-stable']), 'positive = non-negative non-playbook');
  assert.deepEqual(new Set(neg), new Set(['neg-anti']), 'negative excludes playbook-maturity negatives');
  assert.deepEqual(new Set(play), new Set(['play-lesson', 'neg-play']), 'playbook = all maturity===playbook');

  // disjointness of positive vs negative vs playbook.
  for (const n of pos) assert.ok(!neg.includes(n) && !play.includes(n));
  for (const n of neg) assert.ok(!pos.includes(n) && !play.includes(n));
});

// (d) cold-start: use_count=0 relevant skill outranks a high-use_count irrelevant one.
test('jaccard re-rank lets a use_count=0 relevant skill outrank a popular irrelevant one', () => {
  const skills = makeStore();
  // Popular but irrelevant to the query.
  add(skills, 'popular-irrelevant', 'manage docker compose networking stacks', {
    keywords: ['docker', 'compose', 'networking'],
  });
  // Brand new (use_count stays 0), highly relevant to the query.
  add(skills, 'fresh-relevant', 'kubernetes pod autoscaling tuning', {
    keywords: ['kubernetes', 'pod', 'autoscaling'],
  });
  // Bump the irrelevant one's use_count high so global ordering would favor it.
  for (let i = 0; i < 8; i++) skills.recordSkillOutcome('popular-irrelevant', true);

  const fallback = () => skills.listAll(40);
  const got = selectRelevantSkills(skills, 'kubernetes pod autoscaling', {
    pool: 'positive',
    k: 2,
    fallback,
  });
  assert.equal(got[0]?.name, 'fresh-relevant', 'relevance must beat popularity for the matched set');
});

// (e) fill: matched < k appends from fallback deduped-by-name until k.
test('fill appends from fallback deduped-by-name until k', () => {
  const skills = makeStore();
  add(skills, 'match-one', 'kubernetes ingress routing', { keywords: ['kubernetes', 'ingress'] });
  // These do not match the query but exist in fallback (global list).
  add(skills, 'filler-a', 'terraform module layout', { keywords: ['terraform'] });
  add(skills, 'filler-b', 'ansible inventory grouping', { keywords: ['ansible'] });

  const fallback = () => skills.listAll(40);
  const k = 3;
  const got = selectRelevantSkills(skills, 'kubernetes ingress', { pool: 'positive', k, fallback });

  assert.equal(got.length, Math.min(k, 3), 'length is min(k, total)');
  assert.equal(got[0]?.name, 'match-one', 'matched skill comes first');
  const names = got.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  // remaining slots filled from fallback.
  assert.ok(names.includes('filler-a') && names.includes('filler-b'), 'fill from fallback');
});

test('fill never produces duplicates when a matched skill is also in fallback', () => {
  const skills = makeStore();
  add(skills, 'match-dup', 'kubernetes ingress routing', { keywords: ['kubernetes'] });
  add(skills, 'extra', 'unrelated topic', { keywords: ['unrelated'] });

  const fallback = () => skills.listAll(40); // includes match-dup as well
  const got = selectRelevantSkills(skills, 'kubernetes', { pool: 'positive', k: 5, fallback });
  const names = got.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, 'matched skill not re-added by fill');
  assert.ok(names.includes('match-dup'));
});

// (f) Chinese query with zero FTS hits => fallback fill fires.
test('Chinese query with no FTS hits still fills from fallback (no worse than today)', () => {
  const skills = makeStore();
  add(skills, 'eng-a', 'english only skill about deployment', { keywords: ['deploy'] });
  add(skills, 'eng-b', 'english only skill about testing', { keywords: ['test'] });

  const fallback = () => skills.listAll(40);
  const k = 2;
  // multi-char Chinese query: tokenizes to >=1 token (not blank), but no FTS/LIKE match.
  const got = selectRelevantSkills(skills, '部署集群', { pool: 'positive', k, fallback });
  assert.equal(got.length, k, 'fallback fills to k even with zero matches');
  assert.equal(new Set(got.map((s) => s.name)).size, got.length, 'no dup');
});
