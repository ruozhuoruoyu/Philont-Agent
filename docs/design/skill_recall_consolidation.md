# Skill Recall Consolidation — task-relevant injection across all execution paths

Status: DESIGN (not yet implemented). Author: ruozhuoruoyu.
Companion to `deep_explore_phase_redesign.md`. Anchored to real `file:line` so the plan stays honest.

## 1. Problem

Self-learned skills (positives + negative anti-patterns + playbook lessons) are produced and stored
fine — dozens show in web-ui via `GET /api/memory/skills` (`server/src/index.ts:298`). But they are
barely *used*, and corrected mistakes recur. Two field symptoms:
- "几十个技能，看不到 `use_skill` 调用" (positives never pulled).
- "之前的错误还犯" (anti-patterns not adhered to).

Recall is **three different mechanisms, inconsistent, and weaker the heavier the path**:

| Path | Entry | Selection | Positives | Anti-patterns / lessons | `use_skill` callable |
|---|---|---|---|---|---|
| chat | `buildMemoryPrefix` (`chat-handler.ts:2629`) | global top-N by use_count/recency, **no task match** | index only, opt-in `use_skill` (`:3046` `listAll(40)`→top15) | force-injected `listNegative(20)` (`:3145`) + playbooks (`:3088`/`:3118`) | yes |
| deep_explore | `collectComputeLessons` (`deep_explore.ts:890`) | regex `COMPUTE_LESSON_RE` (`:889`, pari/gp/z3/smt), top 3 | **none** | **compute-matching only** | **no — whitelist has `search_skills` (`:718`/`:1228`) but not `use_skill`** |
| plan-execute sub-loops | `planAndExecute.ts:683` sub-task systemPrompt | — | **none in prompt** | **none in prompt** | only if parent `toolDefs` carry it; prompt never mentions skills |

Concrete consequence: the 910C-vs-H200 deep_explore (hardware topic) matched the compute regex on
**zero** lessons → ran with no learned-skill recall at all; and a plan-execute sub-step can repeat an
exactly-corrected mistake because negatives never reach the sub-loop prompt.

## 2. Root cause

The proactive injection picks **what** to inject by global popularity, not by the current task:
- positives `listAll` → `ORDER BY use_count DESC` (`skills.ts:300`)
- lessons `listByMaturity` → `ORDER BY created_at DESC` (`:322`)
- negatives `listNegative` → `ORDER BY last_used_at DESC` (`:342`)

The only task-relevance matcher, `skills.search()` (FTS5 trigram + LIKE, `skills.ts:246`), runs **only
inside the `search_skills` tool** — i.e. only when the model chooses to call it. So:
- positives are opt-in AND cold-start-invisible: a freshly-learned skill has use_count=0 → ranks below
  the top-15 cut → never seen → never used → use_count stays 0 (self-locking; the code already notes
  this for playbooks at `chat-handler.ts:3052`/`:3111`).
- negatives are force-fed but **unmatched**: capped at 20 by recency with no task match, as a wall the
  model skims (`chat-handler.ts:3006` documents the skim-past behavior). Injection ≠ adherence.

This is NOT the snake_case/whitelist silent-drop trap — `search_skills`/`use_skill` are correct and
exported (`agent-memory/src/index.ts:491-492`). The defect is selection, not plumbing.

## 3. Constraint (hard, from the user)

The small top-N caps are **intentional**: long context → lost-in-the-middle "forgetting", burned
before. So the fix must **change the selection criterion, not grow the injected volume** — ideally the
caps shrink. Task-relevant retrieval is exactly compatible: it changes *which* K, not *how many*. The
current design is the worst case — it pays the context cost (20 unmatched negatives every turn) AND
misses the relevant one. Precision is what lets K stay small without dropping the relevant item.

## 4. Design

### 4.1 One shared selector

Add a single pure-ish helper (server side, `server/src/skill_recall.ts`) used by every path:

```
selectRelevantSkills(skills, query, { pool, k, fallback }): Skill[]
```
- `skills` = the `SkillStore` (chat: `memory.skills`; deep_explore: its `skills`). Threaded as arg1;
  the store API is **unchanged** (no `search({kind})`), the pool is filtered JS-side.
- `query` = the current task signal (chat: `userMessageForRecall`; deep_explore: `session.goal`;
  plan-execute: sub-task description + parent task).
- `pool` (NOT `kind`) ∈ `'positive' | 'negative' | 'playbook'`, with a 3-way predicate:
  - `positive`: `s.kind !== 'negative' && s.maturity !== 'playbook'`
  - `negative`: `s.kind === 'negative' && s.maturity !== 'playbook'`
  - `playbook`: `s.maturity === 'playbook'`
  These keep the sections disjoint (a negative-playbook never shows in BOTH negatives and lessons).
- relevance via the existing FTS path; reuse `text_tokenize.tokenize`/`jaccard` exported as
  `planTokenize`/`planJaccard` (`agent-memory/src/index.ts:152-154`) for a light re-rank so
  relevance — not use_count — orders *within* the matched set (kills the cold-start penalty for
  matched items). Candidates are pulled WIDE (`k*12`, min 60) so `search()`'s trailing
  `rankByScore(limit)` popularity trim is a no-op vs the FTS hit set.
- `fallback`: when FTS returns < k matches, **fill** the remainder from the current global top-N
  ordering (deduped by name) so the anti-pattern safety net is never empty (graceful degrade, never
  inject-nothing). A token-empty query (blank/whitespace/punctuation/CJK-sub-trigram) returns
  `fallback().slice(0,k)` unchanged (full back-compat).
- Chinese relevance is char-overlap / trigram grade only (per-character tokens), so matches may be
  weak; the guaranteed fallback-fill ensures it is never worse than today.

### 4.2 No store API change

`search()` (`skills.ts:246`) filters `deprecated` only — it already returns BOTH positive and negative
matches. The contract keeps `search(query, limit)` **unchanged**: the proposed store-level
`search(query, { kind })` API is dropped. The `pool` predicate is applied JS-side in the selector
after the wide candidate pull. No schema change; FTS table already exists (`memory_skills_fts`).

### 4.3 Per-path wiring

1. **chat** — `buildMemoryPrefix` is top-level (`chat-handler.ts:2629`); add a `recallQuery?: string`
   param and pass `userMessageForRecall` at the call site (`:3916`, already in scope at `:3912`).
   Replace the four global-top-N selections with `selectRelevantSkills(memory.skills, recallQuery, …)`
   at the smaller K (see §5). When `recallQuery` is empty, behave exactly as today (full back-compat).
2. **deep_explore** — generalize `collectComputeLessons` (`:890`) from the compute regex to TWO
   separate selector calls (the invalid `kind:'negative'+playbook` is split): one
   `selectRelevantSkills(skills, session.goal, { pool:'negative', … })` and one
   `selectRelevantSkills(skills, session.goal, { pool:'playbook', … })`, merged dedup-by-name; keep
   the PARI/GP primer only for `formal` mode. Add `use_skill` to the deep_explore tool whitelists
   (`:718`/`:1228`) so a skill found mid-exploration can actually be pulled.
3. **plan-execute (cross-layer, largest)** — agent-tools cannot import server memory. Thread a
   `recall?: (query) => string` callback from the server into `planAndExecute` → `runMiniAgentLoop`,
   and inject its result into the sub-task systemPrompt (`planAndExecute.ts:683`). This is the path
   where "错误照犯" is worst (sub-steps run blind). Behind its own flag; default decision in §5.

## 5. Decisions (recommended defaults — edit here)

1. **K per section.** Recommend SHRINK: positives 15→6, negatives 20→5, lessons 5→3, failure 3→3.
   Net injection is shorter than today, not longer.
2. **Fallback.** Recommend matched-first, then fill to K from the existing global top-N (preserves the
   always-on negative safety net; never inject-nothing).
3. **plan-execute inclusion.** Recommend YES but as its own phase (P3) behind a flag — it is the
   highest-value (worst current gap) but the only cross-layer change.
4. **Positive cold-start.** Recommend relevance-first ranking within the matched set (4.1). The
   reserved "new draft" exposure slot is **OUT of scope** for this change — the widened candidate pull
   (`k*12`, min 60) is the cold-start mitigation instead: it makes `search()`'s `rankByScore(limit)`
   popularity trim a no-op vs the FTS hit set, so a never-used but relevant draft surfaces by jaccard.
   Low risk because it only reorders an already task-matched set.

## 6. Rollout (phased, each independently shippable, flag-gated)

- **P0** selector + store kind-filter + `text_tokenize` reuse + unit tests. Flag
  `PHILONT_SKILL_RECALL_RELEVANCE` default **off** → zero behavior change.
- **P1** chat `buildMemoryPrefix` uses it (recallQuery). Dogfood with flag on.
- **P2** deep_explore generalize + `use_skill` whitelist.
- **P3** plan-execute cross-layer recall callback.

## 7. Instrumentation (prove it worked)

Counters already exist: `antipattern.inject.turns` (`chat-handler.ts:3147`), `playbook.inject.turns`
(`:3123`); `learning_stats` reports `search_skills`/`use_skill` call counts (`learning_stats.ts:99`).
Add: per-turn **match-hit rate** (did the task query match ≥1 skill) and **use_skill call rate** before
vs after. Success = use_skill rate up, recurring-failure signatures (`learning_stats` top failures) down.

## 8. Non-goals

How skills are LEARNED/distilled (reflection/consolidator), the marketplace/clawhub install flow, and
any schema change. This is purely a recall-selection change.
