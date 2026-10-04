/**
 * skill_recall: task-relevant skill selection shared across all execution paths
 * (chat buildMemoryPrefix / deep_explore collectComputeLessons / plan-execute sub-loop).
 *
 * Background: self-learned skills were recalled by GLOBAL top-N (use_count / recency), not by
 * relevance to the current task. This module adds a single selector that re-ranks the FTS hit set
 * by jaccard relevance to the current task signal, keeping caps SMALL (context-bloat is a hard
 * constraint). Gated behind PHILONT_SKILL_RECALL_RELEVANCE, which is **default ON** (this header used to
 * say OFF — it was stale, and that stale line was still being cited as a to-do a month later. Relevance
 * recall is NOT the skill loop's bottleneck; the ladder is: see SkillStore.pruneDraftsToCap).
 * When explicitly OFF, callers run their original code verbatim (byte-identical output).
 *
 * See docs/design/skill_recall_consolidation.md.
 */
import { SkillStore } from '@agent/memory'; // value export (index.ts:55)
import type { Skill } from '@agent/memory'; // type export (index.ts:444, from './types.js')
import { planTokenize as tokenize, planJaccard as jaccard } from '@agent/memory'; // index.ts:152-154

/**
 * Feature flag. Default ON: only an explicit off-ish value disables it (env is configured via the web-ui,
 * so there is no local-env to set — on-by-default is the intended production behavior). Set
 * PHILONT_SKILL_RECALL_RELEVANCE=0/off/false/no to revert to the legacy global-top-N selection.
 */
export function recallRelevanceEnabled(): boolean {
  const v = (process.env.PHILONT_SKILL_RECALL_RELEVANCE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * PHILONT_SKILL_RECALL_NO_FILL (2026-10-03, default OFF; default ON since 2026-10-05, see recallNoFillEnabled). When ON, a section whose relevance match is
 * EMPTY is left empty instead of being filled from the global top-N.
 *
 * Why this exists: the fallback fill guarantees the section is never empty, but what it fills with is
 * by construction unrelated to the task (it reached the list by popularity, not by matching). Two
 * independent measurements say that unrelated recall is not neutral: in philosophers exp 103 (ScienceWorld,
 * 27B) retrieving facts from other tasks by similarity turned a task solved in 5/5 episodes into 5/5
 * failures, and the SRDP formalisation (Memento 2) reserves an explicit "void case" so the model can act
 * without memory rather than on the wrong memory. Here, with a CJK query against an English corpus,
 * matchedByRelevance is 0 on every turn and the same six popular skills are injected regardless of topic
 * (see the 2026-07-25 note below) — the exact "wrong memory" case.
 *
 * Default OFF because the fill is also the only path by which a never-matched but genuinely useful skill
 * is ever seen; flipping the default is a measurement decision (use_skill rate and recurring-failure
 * signatures before/after), not a design one. Partial matches are not affected: if ≥1 skill matched,
 * the remaining slots still fill as before.
 */
export function recallNoFillEnabled(): boolean {
  // 2026-10-05: default ON. Evidence (docs/design/memory_interface_evidence.md §3e/§3f): on LifelongAgentBench OS
  // the fill never helped in 8 real-model runs; when the baseline's reflection had authored a failure playbook, the
  // fill injected it into 37–41 of 60 turns and the no-fill arm hit the wall-clock limit half as often; when no such
  // artifact existed, the two arms were equal. Set PHILONT_SKILL_RECALL_NO_FILL=0/off to restore the fill.
  const v = (process.env.PHILONT_SKILL_RECALL_NO_FILL ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
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
  opts: { pool: SkillPool; k: number; fallback: () => Skill[]; noFill?: boolean },
): Skill[] {
  return selectRelevantSkillsDetailed(skills, query, opts).skills;
}

/**
 * Same selection, plus how it was actually reached. `matchedByRelevance` is how many of the returned
 * entries came from the jaccard path rather than from the global fallback fill at step 6.
 *
 * It exists because the funnel log said `relevance=on` on every turn while the offered list never
 * changed — and "the flag is on" is not the same claim as "the flag did anything". Production
 * 2026-07-25: a Chinese query tokenizes to single CHARACTERS ('脊','线','前'…), the skill corpus is
 * written in English, so jaccard is 0 against every row; and because single characters are non-empty
 * tokens the step-1 guard does not fire either, so the path silently proceeds to an empty match set and
 * fills all six slots from the global top-N. The same five mature skills were therefore offered on every
 * turn for a week regardless of topic. A subsystem reporting itself ON while contributing nothing is the
 * exact shape this codebase keeps having to dig out of logs by hand.
 */
export function selectRelevantSkillsDetailed(
  skills: SkillStore,
  query: string,
  opts: { pool: SkillPool; k: number; fallback: () => Skill[]; noFill?: boolean },
): { skills: Skill[]; matchedByRelevance: number } {
  const { pool, k, fallback } = opts;

  // 1. Back-compat guard: token-empty query -> behave as today (global fallback ordering).
  const qTokens = tokenize(query);
  if (qTokens.size === 0) return { skills: fallback().slice(0, k), matchedByRelevance: 0 };

  // 2. Wide candidate pull to defeat rankByScore pre-truncation cold-start bias.
  //    2026-10-05: the FTS pull alone returned NOTHING for ordinary multi-word queries ("compare gpu hbm memory
  //    bandwidth across hardware" against a skill keyed hbm/bandwidth/gpu), so the relevance re-rank below had
  //    no candidates and every slot was filled from the global list — the "same six skills every turn" seen in
  //    production, and the reason the no-fill arm injected nothing in the LifelongAgentBench runs. The corpus
  //    is small (tens to a few hundred rows), so also pull the recommendation list and let jaccard decide.
  const pulled = [...skills.search(query, Math.max(k * 12, 60)), ...skills.listForRecommendation(400)];
  const seenCand = new Set<string>();
  const candidates = pulled.filter((s) => (seenCand.has(s.name) ? false : (seenCand.add(s.name), true)));

  // 3. Pool predicate filter.
  const matched = candidates.filter(poolPredicate(pool));

  // 4. Relevance re-rank (stable sort, DESC by jaccard).
  const scored = matched.map((s) => ({ s, score: jaccard(qTokens, tokenize(skillText(s))) }));
  scored.sort((a, b) => b.score - a.score);

  // 5. Take the top-k RELEVANT rows (score > 0), deduping by name. A zero-scoring row is not a relevance
  //    match — it reached this list through the candidate pull (now the whole corpus) and must not be
  //    counted as evidence the ranker worked, nor selected as if it were.
  const seen = new Set<string>();
  const result: Skill[] = [];
  let matchedByRelevance = 0;
  for (const { s, score } of scored) {
    if (result.length >= k) break;
    if (score <= 0) break; // sorted DESC: nothing relevant follows
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    result.push(s);
    matchedByRelevance++;
  }

  // 6. Fill from fallback() (the path's current global list) deduped by name until k — the legacy padding.
  //    With PHILONT_SKILL_RECALL_NO_FILL (default on since 2026-10-05) the section holds ONLY what matched:
  //    an unrelated skill is not a neutral filler (philosophers exp 103; recallNoFillEnabled), whether the
  //    section is otherwise empty or partially filled.
  if (opts.noFill ?? recallNoFillEnabled()) {
    return { skills: result, matchedByRelevance };
  }
  if (result.length < k) {
    for (const s of fallback()) {
      if (result.length >= k) break;
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      result.push(s);
    }
  }

  // 7. Hard cap at k unconditionally.
  return { skills: result.slice(0, k), matchedByRelevance };
}
