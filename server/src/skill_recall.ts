/**
 * skill_recall: task-relevant skill selection shared across all execution paths
 * (chat buildMemoryPrefix / deep_explore collectComputeLessons / plan-execute sub-loop).
 *
 * Background: self-learned skills were recalled by GLOBAL top-N (use_count / recency), not by
 * relevance to the current task. This module adds a single selector that re-ranks the FTS hit set
 * by jaccard relevance to the current task signal, keeping caps SMALL (context-bloat is a hard
 * constraint). The whole behavior is gated behind PHILONT_SKILL_RECALL_RELEVANCE (default OFF);
 * when OFF, callers must run their original code verbatim (byte-identical output).
 *
 * See docs/design/skill_recall_consolidation.md.
 */
import { SkillStore } from '@agent/memory'; // value export (index.ts:55)
import type { Skill } from '@agent/memory'; // type export (index.ts:444, from './types.js')
import { planTokenize as tokenize, planJaccard as jaccard } from '@agent/memory'; // index.ts:152-154

/**
 * Feature flag. Default OFF: unset/'' => false. Matches the codebase's existing flag-parse style.
 */
export function recallRelevanceEnabled(): boolean {
  return (
    process.env.PHILONT_SKILL_RECALL_RELEVANCE === '1' ||
    process.env.PHILONT_SKILL_RECALL_RELEVANCE === 'true'
  );
}

/**
 * Which slice of the skill corpus a section wants. The store's search() returns a mixed kind set
 * (FTS only filters deprecated), so the pool predicate is applied JS-side — no store API change.
 *   positive: s.kind !== 'negative' && s.maturity !== 'playbook'
 *   negative: s.kind === 'negative' && s.maturity !== 'playbook'  (exclude playbook so a
 *             negative-playbook never shows in BOTH negatives and lessons)
 *   playbook: s.maturity === 'playbook'
 */
export type SkillPool = 'positive' | 'negative' | 'playbook';

function poolPredicate(pool: SkillPool): (s: Skill) => boolean {
  switch (pool) {
    case 'positive':
      return (s) => s.kind !== 'negative' && s.maturity !== 'playbook';
    case 'negative':
      return (s) => s.kind === 'negative' && s.maturity !== 'playbook';
    case 'playbook':
      return (s) => s.maturity === 'playbook';
  }
}

function skillText(s: Skill): string {
  return `${s.name} ${s.description} ${s.whenToUse} ${(s.triggerKeywords || []).join(' ')}`;
}

/**
 * Select skills relevant to `query` from `skills`, capped at `k`.
 *
 * Algorithm (see contract):
 *  1. Back-compat guard: if the query tokenizes to nothing (empty/whitespace/punctuation-only/
 *     CJK-sub-trigram noise), return fallback().slice(0, k) unchanged.
 *  2. Pull a WIDE candidate set (k*12, min 60) so search()'s trailing rankByScore(limit) trim
 *     by use_count/recency is a no-op vs the FTS hit set — jaccard, not popularity, is binding.
 *  3. Filter the candidates by the pool predicate (keeps sections disjoint).
 *  4. Stable-sort matched DESC by jaccard relevance over name/description/whenToUse/triggerKeywords.
 *  5. Take top-k (dedupe by name).
 *  6. If still < k, fill from fallback() skipping already-picked names, until k.
 *  7. Hard-cap at k.
 */
export function selectRelevantSkills(
  skills: SkillStore,
  query: string,
  opts: { pool: SkillPool; k: number; fallback: () => Skill[] },
): Skill[] {
  const { pool, k, fallback } = opts;

  // 1. Back-compat guard: token-empty query -> behave as today (global fallback ordering).
  const qTokens = tokenize(query);
  if (qTokens.size === 0) return fallback().slice(0, k);

  // 2. Wide candidate pull to defeat rankByScore pre-truncation cold-start bias.
  const candidates = skills.search(query, Math.max(k * 12, 60));

  // 3. Pool predicate filter.
  const matched = candidates.filter(poolPredicate(pool));

  // 4. Relevance re-rank (stable sort, DESC by jaccard).
  const scored = matched.map((s) => ({ s, score: jaccard(qTokens, tokenize(skillText(s))) }));
  scored.sort((a, b) => b.score - a.score);

  // 5. Take top-k, deduping by name.
  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const { s } of scored) {
    if (result.length >= k) break;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    result.push(s);
  }

  // 6. Fill from fallback() (the path's current global list) deduped by name until k.
  if (result.length < k) {
    for (const s of fallback()) {
      if (result.length >= k) break;
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      result.push(s);
    }
  }

  // 7. Hard cap at k unconditionally.
  return result.slice(0, k);
}
