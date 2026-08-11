/**
 * SkillStore: Layer 3 skill library
 *
 * Stores reusable action patterns extracted from session reflection.
 * Each skill is a declarative recipe: a name, description, trigger keywords, and action template.
 *
 * v3 feedback loop:
 *   - Each invocation records success/failure via recordSkillOutcome(name, success)
 *   - search / listAll sort by log(1+use_count) × laplace_success_rate × recency
 *   - Skills with frequent failures are automatically down-weighted, shown to users with a [low reliability] indicator
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Skill, SkillInput, SkillMaturity } from './types.js';
import type { RecipeVerification } from './skill_recipes.js';
import { nextMaturity, parseMaturity } from './skill_maturity.js';
import { parseRevisionHistory, type SkillRevision } from './skill_repair.js';

/** SkillStore event payload */
export interface SkillChangeEvent {
  type: 'created' | 'updated' | 'deleted';
  name: string;
}

interface SkillRow {
  id: string;
  name: string;
  description: string;
  trigger_keywords: string;
  action_template: string;
  use_count: number;
  offered_count: number | null;
  /** v41: of those showings, how many were relevance matches rather than fallback rotation. */
  matched_count: number | null;
  last_used_at: number | null;
  created_at: number;
  success_count: number;
  failure_count: number;
  last_failure_at: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  maturity: string;
  kind: string;
  source: string | null;
  /** v15: trigger scenario text (SKILL.md frontmatter when_to_use). Empty = NULL. */
  when_to_use: string | null;
  /** v33 (H2): callable-recipe fields, JSON-encoded. NULL = advisory prose lesson. */
  verification: string | null;
  tool_policy: string | null;
  /** v35 (H3): append-only revision history, JSON-encoded. NULL = never revised. */
  revision_history: string | null;
}

/** Skill composite scoring constants */
const POSITIVE_RECENCY_HALFLIFE_DAYS = 30;
/**
 * Anti-patterns (kind='negative') use a longer half-life.
 * Anti-patterns are "don't do this" constraints with longer lifespans — not repeating them ≠ should forget,
 * so decay here is much slower than for positive Skills.
 */
const NEGATIVE_RECENCY_HALFLIFE_DAYS = 90;
const NEVER_USED_RECENCY = 0.1; // recency baseline when never used, to avoid score going to zero

/**
 * Skill composite score: log(2+useCount) × laplace_success_rate × recency_decay
 *
 * - laplace_success_rate = (success + 1) / (success + failure + 2), smooths zero samples
 * - recency_decay        = exp(-days_since_last_use / halflife)
 *   positive half-life 30 days; negative 90 days (anti-patterns should not lose influence quickly just because they haven't been used recently)
 * - Baseline 0.1 when never used
 */
export function scoreSkill(skill: Skill, now: number = Date.now()): number {
  const laplaceRate =
    (skill.successCount + 1) / (skill.successCount + skill.failureCount + 2);
  const usageWeight = Math.log(2 + skill.useCount);
  const halflife = skill.kind === 'negative'
    ? NEGATIVE_RECENCY_HALFLIFE_DAYS
    : POSITIVE_RECENCY_HALFLIFE_DAYS;
  let recencyDecay: number;
  if (skill.lastUsedAt === null) {
    recencyDecay = NEVER_USED_RECENCY;
  } else {
    const days = (now - skill.lastUsedAt) / 86_400_000;
    recencyDecay = Math.exp(-Math.max(0, days) / halflife);
  }
  return usageWeight * laplaceRate * recencyDecay;
}

function rankByScore(skills: Skill[], limit: number, now: number = Date.now()): Skill[] {
  return skills
    .map((s) => ({ skill: s, score: scoreSkill(s, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.skill);
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    whenToUse: row.when_to_use ?? '',
    triggerKeywords: JSON.parse(row.trigger_keywords),
    actionTemplate: row.action_template,
    useCount: row.use_count,
    offeredCount: row.offered_count ?? 0,
    matchedCount: row.matched_count ?? 0,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures ?? 0,
    maturity: parseMaturity(row.maturity, 'draft'),
    kind: row.kind === 'negative' ? 'negative' : 'positive',
    source: row.source ?? null,
    verification: parseRecipeJson<RecipeVerification>(row.verification),
    toolPolicy: parseRecipeJson<string[]>(row.tool_policy),
    revisionHistory: parseRevisionHistory(row.revision_history),
  };
}

/** Safe JSON parse for the v33 recipe columns — malformed / NULL → null (never throws). */
function parseRecipeJson<T>(raw: string | null | undefined): T | null {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * How many distinct showings an unchosen draft gets before it counts as declined. See pruneDraftsToCap.
 */
export const DECLINED_MIN_OFFERS = 3;

/**
 * How many arbitrary (global-fallback) showings stand in for one relevance match.
 *
 * Not zero, or nothing ever drains: a draft leaves the untested pool by being USED or by being evicted,
 * and while it sits there the creation-side bound stops the reflector minting. Not three either, which is
 * what 2026-08-04 did — `exact-rational-lrc-tightness-verification` and three siblings, the skills most
 * obviously about the week's work, deleted at "offered 3x, never chosen" when all three showings were
 * `relevance=on(matched 0 → global fallback)` on unrelated turns.
 */
export const DECLINED_MIN_FALLBACK_OFFERS = 12;

/**
 * Has this skill earned its deletion?
 *
 * Being CHOSEN is not being declined (the sort key knew that; the eviction filter did not, and deleted
 * the one skill the agent used all day on 2026-07-31). Being shown BECAUSE it matched, and passed over,
 * is real evidence. Being shown because the ranker matched nothing and the top-N filled the slot is
 * evidence about the turn, not about the skill — so it takes many more of those to add up to the same
 * verdict.
 */
export function isDeclinedDraft(s: Skill): boolean {
  if (s.useCount > 0) return false;
  if (s.matchedCount >= DECLINED_MIN_OFFERS) return true;
  return s.offeredCount >= DECLINED_MIN_FALLBACK_OFFERS;
}

export class SkillStore extends EventEmitter {
  constructor(private readonly db: Database.Database) {
    super();
  }

  /**
   * Create a new skill. Throws if name already exists (reflector should check first).
   * Emits a 'changed' event on success for hot-reload subscribers to refresh the index.
   */
  createSkill(input: SkillInput): Skill {
    const id = randomUUID();
    const createdAt = Date.now();
    const keywordsJson = JSON.stringify(input.triggerKeywords);
    const kind: 'positive' | 'negative' = input.kind === 'negative' ? 'negative' : 'positive';
    const source: string | null = input.source ?? null;
    const maturity: SkillMaturity = parseMaturity(input.maturity, 'draft');
    const whenToUse: string = input.whenToUse ?? '';
    const verification: RecipeVerification | null = input.verification ?? null;
    const toolPolicy: string[] | null = input.toolPolicy ?? null;
    const verificationJson = verification ? JSON.stringify(verification) : null;
    const toolPolicyJson = toolPolicy ? JSON.stringify(toolPolicy) : null;

    this.db
      .prepare<[string, string, string, string, string, number, string, string | null, string, string | null, string | null, string | null]>(
        `INSERT INTO memory_skills
         (id, name, description, trigger_keywords, action_template, created_at, kind, source, maturity, when_to_use, verification, tool_policy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.name, input.description, keywordsJson, input.actionTemplate, createdAt, kind, source, maturity, whenToUse || null, verificationJson, toolPolicyJson);

    this.emit('changed', { type: 'created', name: input.name } satisfies SkillChangeEvent);

    return {
      id,
      name: input.name,
      description: input.description,
      whenToUse,
      offeredCount: 0,
      matchedCount: 0,
      triggerKeywords: input.triggerKeywords,
      actionTemplate: input.actionTemplate,
      useCount: 0,
      lastUsedAt: null,
      createdAt,
      successCount: 0,
      failureCount: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      maturity,
      revisionHistory: [],
      kind,
      source,
      verification,
      toolPolicy,
    };
  }

  /**
   * MECE check (v17, 2026-05-11): find existing skills with high similarity to the input name+whenToUse.
   *
   * Uses Jaccard token overlap similarity (name tokens + whenToUse tokens),
   * default threshold 0.5 (plan design):
   *   ≥ 0.5 → treated as "should extend existing skill rather than create new one", returns candidate list
   *   < 0.5 → not returned, creating new skill is allowed
   *
   * Caller semantics:
   *   - applyReflection new_skill: hit → downgrade to skill_refine, append newCondition
   *     to existing skill description
   *   - plan_close success hook: hit → updateSkill to append plan steps experience; no hit
   *     → create new_skill
   *
   * Design choices:
   *   - Does not automatically throw from inside createSkill (preserves compatibility with existing caller / bundled / clawhub loading)
   *   - Caller decides refine / replace / force-new based on business semantics
   *   - kind='negative' / maturity='deprecated' do not participate as candidates (they are counter-examples / terminal states)
   *
   * Returns candidates sorted by similarity DESC (at most 5); empty array means no conflict.
   */
  findDuplicateCandidates(
    name: string,
    whenToUse: string = '',
    threshold = 0.5,
  ): Array<{ skill: Skill; jaccard: number }> {
    const targetTokens = this.tokenize(name + ' ' + whenToUse);
    if (targetTokens.size === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_skills
         WHERE maturity != 'deprecated' AND kind != 'negative'`,
      )
      .all() as SkillRow[];

    const scored: Array<{ skill: Skill; jaccard: number }> = [];
    for (const row of rows) {
      const skill = rowToSkill(row);
      const candTokens = this.tokenize(skill.name + ' ' + skill.whenToUse);
      if (candTokens.size === 0) continue;
      const j = this.jaccard(targetTokens, candTokens);
      if (j >= threshold) scored.push({ skill, jaccard: j });
    }
    scored.sort((a, b) => b.jaccard - a.jaccard);
    return scored.slice(0, 5);
  }

  /** Simple tokenize: lowercase, split on [a-z0-9 Chinese], drop 1-char stop words. Used for MECE check. */
  private tokenize(text: string): Set<string> {
    const out = new Set<string>();
    const lowered = text.toLowerCase();
    // Split on non-alphanumeric non-Chinese characters; Chinese 1-2 char n-gram is too complex, treat each character individually
    const tokens = lowered.match(/[a-z0-9]+|[一-龥]/g);
    if (!tokens) return out;
    for (const t of tokens) {
      if (t.length >= 2) out.add(t);
    }
    return out;
  }

  /** Jaccard = |A ∩ B| / |A ∪ B| */
  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  /**
   * Exact lookup by name
   */
  getByName(name: string): Skill | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_skills WHERE name = ? LIMIT 1`)
      .get(name) as SkillRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  /**
   * Full-text skill search (matches any of name/description/keywords)
   *
   * Strategy: FTS5 trigram main path + LIKE fallback.
   * After hits, re-rank in JS layer by composite score, preferring "frequently used, high success rate, recently used" skills.
   */
  search(query: string, limit = 5): Skill[] {
    const safe = query.replace(/['"*()]/g, ' ').trim();
    if (!safe) return [];
    const candidateLimit = Math.max(limit * 4, 20);

    // 2026-05-09: filter maturity='deprecated'. The design intent of deprecated is "agent
    // should not use this anymore" (terminal state); but previously the SQL did not filter it,
    // so after cleanup marked skills as deprecated they still surfaced to LLM (caught in production
    // mycox testing — 70+ deprecated mycox playbooks loaded could still be called by LLM, polluting behaviour).
    let rows: SkillRow[] = [];
    if (safe.length >= 3) {
      try {
        rows = this.db
          .prepare<[string, number]>(
            `SELECT s.* FROM memory_skills s
             JOIN memory_skills_fts fts ON fts.rowid = s.rowid
             WHERE memory_skills_fts MATCH ?
               AND s.maturity != 'deprecated'
             LIMIT ?`
          )
          .all(safe, candidateLimit) as SkillRow[];
      } catch {
        rows = [];
      }
    }

    if (rows.length === 0) {
      const pattern = `%${safe}%`;
      rows = this.db
        .prepare<[string, string, string, number]>(
          `SELECT * FROM memory_skills
           WHERE (name LIKE ? OR description LIKE ? OR trigger_keywords LIKE ?)
             AND maturity != 'deprecated'
           LIMIT ?`
        )
        .all(pattern, pattern, pattern, candidateLimit) as SkillRow[];
    }

    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * List all skills (descending composite score; used for system prompt injection index).
   *
   * 2026-05-09: filter deprecated. Same reason as search — the system prompt injection index
   * is also content LLM sees, deprecated skills should not appear.
   */
  listAll(limit = 50): Skill[] {
    // Fetch enough candidates; re-rank in JS layer
    const candidateLimit = Math.max(limit * 4, 200);
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills
         WHERE maturity != 'deprecated'
         ORDER BY use_count DESC, created_at DESC
         LIMIT ?`
      )
      .all(candidateLimit) as SkillRow[];
    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * Every skill row, ALL maturities (incl. deprecated), no relevance ranking. For MAINTENANCE paths
   * (bulk delete / audit) that must see the complete set — listAll / search both hide deprecated and
   * rank+truncate, so neither can enumerate "all skills" for a criterion delete (prod: forget_skill
   * "删除使用次数为0" could not reach deprecated/unranked skills). Not for LLM surfacing.
   */
  listAllForMaintenance(limit = 10000): Skill[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills ORDER BY use_count ASC, created_at DESC LIMIT ?`
      )
      .all(limit) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * List skills by maturity tier, sorted by created_at DESC (newest first).
   *
   * 2026-05-11: designed specifically for playbook section rendering. Playbook skills do not
   * accumulate use_count (always 0); sorting by created_at ensures the lessons from the most
   * recent reflection are exposed first. Also usable for targeted queries for other tiers
   * (e.g. "how many draft skills are there now").
   *
   * Default limit=5, matching the prefix section length of buildPlaybookHints.
   */
  listByMaturity(maturity: SkillMaturity, limit = 5): Skill[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM memory_skills
         WHERE maturity = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(maturity, limit) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * List all anti-pattern Skills (kind='negative').
   *
   * Descending composite score (more recently updated / more frequently violated anti-patterns first);
   * used for full injection into the system prompt. If the count grows too large to inject in full (>20),
   * caller can pass a limit.
   */
  listNegative(limit = 50): Skill[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills
         WHERE kind = 'negative'
           AND maturity != 'deprecated'
         ORDER BY last_used_at DESC, created_at DESC
         LIMIT ?`
      )
      .all(Math.max(limit, 50)) as SkillRow[];
    return rankByScore(rows.map(rowToSkill), limit);
  }

  /**
   * Record a skill invocation result (core of feedback loop + maturity state machine).
   *
   *   - success=true  → success_count++, update last_used_at + last_success_at,
   *                     reset consecutive_failures to 0
   *   - success=false → failure_count++, update last_used_at + last_failure_at,
   *                     consecutive_failures++
   * Both cases: use_count++.
   *
   * Then evaluates whether to promote/demote the current tier using nextMaturity():
   *   - Promotion: success path only, strictly threshold-controlled (see skill_maturity.ts)
   *   - Demotion: failure path → deprecated directly if deprecated threshold triggered;
   *               otherwise stable → confirmed, confirmed → draft, draft → draft
   *   - playbook and deprecated are terminal states, the automatic state machine does not enter or exit them
   */
  recordSkillOutcome(name: string, success: boolean, at: number = Date.now()): Skill | null {
    const sql = success
      ? `UPDATE memory_skills
         SET use_count            = use_count + 1,
             success_count        = success_count + 1,
             last_used_at         = ?,
             last_success_at      = ?,
             consecutive_failures = 0
         WHERE name = ?`
      : `UPDATE memory_skills
         SET use_count            = use_count + 1,
             failure_count        = failure_count + 1,
             last_used_at         = ?,
             last_failure_at      = ?,
             consecutive_failures = consecutive_failures + 1
         WHERE name = ?`;
    const result = success
      ? this.db.prepare<[number, number, string]>(sql).run(at, at, name)
      : this.db.prepare<[number, number, string]>(sql).run(at, at, name);
    if (result.changes === 0) return null;

    // State machine evaluation: compute next tier from the already-updated counts, UPDATE if changed
    const after = this.getByName(name);
    if (!after) return null;
    const computed = nextMaturity({
      current: after.maturity,
      successCount: after.successCount,
      failureCount: after.failureCount,
      consecutiveFailures: after.consecutiveFailures,
      lastOutcome: success ? 'success' : 'failure',
    });
    if (computed !== after.maturity) {
      this.db
        .prepare<[string, string]>(`UPDATE memory_skills SET maturity = ? WHERE name = ?`)
        .run(computed, name);
      this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
      return { ...after, maturity: computed };
    }
    return after;
  }

  /**
   * Explicitly set maturity (overriding the state machine). For the following scenarios:
   *   - reflection writes playbook (state machine does not auto-enter playbook)
   *   - manually reviving a mistakenly deprecated skill to draft (state machine does not revive)
   *   - clawhub loading presetting trust tier to confirmed/stable
   *
   * Does not modify success/failure counts or timestamps.
   */
  setMaturity(name: string, maturity: SkillMaturity): Skill | null {
    const result = this.db
      .prepare<[string, string]>(`UPDATE memory_skills SET maturity = ? WHERE name = ?`)
      .run(maturity, name);
    if (result.changes === 0) return null;
    this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
    return this.getByName(name);
  }

  /**
   * Record that a skill was RETRIEVED (use_skill fetched its body). Bumps use_count + last_used_at ONLY —
   * for recency/usage ranking in scoreSkill — and deliberately touches neither success_count/failure_count
   * nor the maturity state machine.
   *
   * 2026-07-15 (self_learning_redesign Phase 0.1): retrieval used to route through
   * recordSkillOutcome(name, true), so merely fetching a skill's body twice credited two "successes" and
   * climbed draft→confirmed. "confirmed" therefore meant "fetched twice", not "worked twice" — a fabricated
   * efficacy signal. Efficacy is now credited ONLY by the reflector's linkedSkill outcome attribution
   * (recordLinkedSkillOutcomes → recordSkillOutcome), which observes whether the actions AFTER the retrieval
   * actually succeeded. Fetching is usage, not proof.
   */
  recordUsage(name: string, at: number = Date.now()): Skill | null {
    const result = this.db
      .prepare<[number, string]>(
        `UPDATE memory_skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?`,
      )
      .run(at, name);
    if (result.changes === 0) return null;
    return this.getByName(name);
  }

  /**
   * @deprecated Retrieval must not credit efficacy. Kept as an alias for recordUsage so external callers do
   * not break, but it no longer records a success or moves maturity (see recordUsage). Prefer recordUsage
   * for retrieval and recordSkillOutcome for a real observed outcome.
   */
  incrementUseCount(name: string): Skill | null {
    return this.recordUsage(name);
  }

  /**
   * Update a skill (used by reflector to merge similar patterns)
   */
  updateSkill(
    name: string,
    updates: Partial<Pick<SkillInput, 'description' | 'triggerKeywords' | 'actionTemplate' | 'kind' | 'source' | 'whenToUse'>>,
  ): Skill | null {
    const existing = this.getByName(name);
    if (!existing) return null;

    const description = updates.description ?? existing.description;
    const triggerKeywords = updates.triggerKeywords ?? existing.triggerKeywords;
    const actionTemplate = updates.actionTemplate ?? existing.actionTemplate;
    const kind: 'positive' | 'negative' = updates.kind === 'negative' || updates.kind === 'positive'
      ? updates.kind
      : existing.kind;
    // source 用 hasOwnProperty 区分"未传"(保留原值)与"显式 null"(清空)
    const source: string | null = Object.prototype.hasOwnProperty.call(updates, 'source')
      ? (updates.source ?? null)
      : existing.source;
    const whenToUse: string = updates.whenToUse ?? existing.whenToUse;

    this.db
      .prepare<[string, string, string, string, string | null, string | null, string]>(
        `UPDATE memory_skills
         SET description = ?, trigger_keywords = ?, action_template = ?, kind = ?, source = ?, when_to_use = ?
         WHERE name = ?`
      )
      .run(description, JSON.stringify(triggerKeywords), actionTemplate, kind, source, whenToUse || null, name);

    this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
    return this.getByName(name);
  }

  /**
   * H3 (skill_self_repair.md): overwrite a callable recipe's steps/verification/tool-policy after a
   * diagnosis, preserving the OUTGOING values in `revision_history` first (so "did rev N+1 beat rev N"
   * is measurable — the whole point of repairing rather than just demoting).
   *
   * Dedicated method rather than folding into `updateSkill`: recipe fields need the append-only
   * history bookkeeping every other `updateSkill` field does not, and a revision always re-enters the
   * maturity ladder at 'draft' (it has not yet re-earned trust) regardless of where it was ('playbook'
   * after demotion, in the common case).
   *
   * No-op (returns null) on a skill that isn't a callable recipe (`verification` currently null) —
   * revising a prose lesson's `actionTemplate` is what `updateSkill` is for.
   */
  reviseRecipe(
    name: string,
    updates: {
      actionTemplate?: string;
      verification?: RecipeVerification | null;
      toolPolicy?: string[] | null;
      /** why — e.g. `skill_repair:<deep_explore session id>` (see skill_repair.ts REPAIR_REASON_PREFIX) */
      reason: string;
    },
  ): Skill | null {
    const existing = this.getByName(name);
    if (!existing || existing.verification == null) return null;

    const outgoing: SkillRevision = {
      at: Date.now(),
      actionTemplate: existing.actionTemplate,
      verification: existing.verification,
      toolPolicy: existing.toolPolicy,
      reason: updates.reason,
    };
    const revisionHistory = [...existing.revisionHistory, outgoing];

    const actionTemplate = updates.actionTemplate ?? existing.actionTemplate;
    const verification = Object.prototype.hasOwnProperty.call(updates, 'verification')
      ? (updates.verification ?? null)
      : existing.verification;
    const toolPolicy = Object.prototype.hasOwnProperty.call(updates, 'toolPolicy')
      ? (updates.toolPolicy ?? null)
      : existing.toolPolicy;

    this.db
      .prepare<[string, string | null, string | null, string, string, string]>(
        `UPDATE memory_skills
         SET action_template = ?, verification = ?, tool_policy = ?, maturity = ?, revision_history = ?
         WHERE name = ?`
      )
      .run(
        actionTemplate,
        verification ? JSON.stringify(verification) : null,
        toolPolicy ? JSON.stringify(toolPolicy) : null,
        'draft' satisfies SkillMaturity,
        JSON.stringify(revisionHistory),
        name,
      );

    this.emit('changed', { type: 'updated', name } satisfies SkillChangeEvent);
    return this.getByName(name);
  }

  /** Delete a skill (users can revoke low-quality skills) */
  deleteSkill(name: string): boolean {
    const result = this.db
      .prepare<[string]>(`DELETE FROM memory_skills WHERE name = ?`)
      .run(name);
    if (result.changes > 0) {
      this.emit('changed', { type: 'deleted', name } satisfies SkillChangeEvent);
    }
    return result.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_skills`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * 2026-06-08: cap reflection-distilled DRAFT skills to bound skill-store bloat. The idle reflector
   * mints new draft skills every cycle; with no cap the store grows unboundedly, the reflector keeps
   * re-distilling near-duplicates, and skill scans/injection get noisier (and feed memory-prefix
   * growth). Evict the LOWEST-scored drafts (scoreSkill: unused / old / failing first) once drafts
   * exceed maxDrafts. ONLY `draft` maturity is touched — confirmed/stable/playbook (promoted,
   * curated) and external (disk SKILL.md) skills are never pruned here. Returns the number deleted.
   */
  pruneDraftsToCap(maxDrafts: number): number {
    if (!Number.isFinite(maxDrafts) || maxDrafts < 0) return 0;
    // Reflection drafts only. Most disk-installed skills also sit at maturity 'draft' (importSkills sets
    // none, createSkill defaults), and counting them here made the cap permanently unreachable: production
    // logged "cap 40: 12 over, only 0 have evidence — kept" on every idle cycle, forever, because ~40 of
    // the counted drafts were disk skills the prune must not delete anyway (deleting the row is pointless —
    // the next hot-reload re-imports it). A cap that is always exceeded and never enforceable is pure
    // wolf-crying in the funnel log. Disk skills have their own lifecycle (the disk prune, keyed on the
    // directory disappearing); this cap governs what REFLECTION minted.
    const drafts = (
      this.db.prepare(`SELECT * FROM memory_skills WHERE maturity = 'draft' AND COALESCE(from_disk, 0) = 0`).all() as SkillRow[]
    ).map(rowToSkill);
    if (drafts.length <= maxDrafts) return 0;
    const now = Date.now();
    // Evidence-ordered eviction (v36). scoreSkill alone cannot rank these: in production EVERY draft has
    // useCount 0 (use_skill fired 10 times in 462 turns), so the score collapsed to pure age and the cap
    // became a FIFO conveyor — mint a draft, never try it, delete it when it gets old, forever. draft sat
    // pinned at exactly the cap (40) for a week with validated=0.
    //
    // A skill that was OFFERED many times and never chosen has earned its deletion — that is real negative
    // evidence. A skill that was NEVER OFFERED has no evidence against it at all; deleting it is discarding
    // an untested hypothesis for losing a race it was never entered in. So: evict the declined ones FIRST,
    // and only fall back to the score once the declined pool is exhausted.
    const sorted = drafts.slice().sort((a, b) => {
      const aDeclined = isDeclinedDraft(a);
      const bDeclined = isDeclinedDraft(b);
      if (aDeclined !== bDeclined) return aDeclined ? -1 : 1;
      // Within the declined pool, the most-declined goes first (strongest evidence of uselessness).
      if (aDeclined && bDeclined && a.offeredCount !== b.offeredCount) {
        return b.offeredCount - a.offeredCount;
      }
      return scoreSkill(a, now) - scoreSkill(b, now);
    });
    // ...and once the declined pool IS exhausted, STOP. Production 2026-07-22 pruned three drafts: one
    // genuinely declined, and two that had never been offered at all. Ordering the eviction was only half
    // the fix — while the reflector mints faster than the funnel can offer, the never-offered pool is eaten
    // anyway, and the conveyor is back with better logging. Deleting an untested hypothesis to make room
    // for another untested hypothesis is not a trade worth making. The bound now lives on the CREATION
    // side (see untestedDraftCount): stop generating what there is no capacity to test.
    //
    // "Declined" needs more than one showing. The day the exploration slot went live it fed this exact
    // filter: a draft was rotated into the index once — on a turn about a completely unrelated topic —
    // not chosen (of course), and evicted seventeen minutes later as "offered 1x, never chosen". One offer
    // on one arbitrary turn measures the TURN's relevance, not the skill's worth; being explored must not
    // be what makes a draft eviction-eligible, or the slot is just feeding the executioner. Three distinct
    // showings is still a fast verdict at one exploration slot per chat turn.
    // `useCount === 0` as well as the offer count. The sort key above already knew that being CHOSEN is
    // not being declined; this filter did not, and it is the one that decides who can die.
    //
    // Production 2026-07-31: `verify-lrc-by-enumeration` was offered, ACCEPTED via use_skill at 11:11:00,
    // and used to run the enumeration. At 13:06:24 the cap evicted it — logged as `(score 0.548)`, the
    // useCount>0 branch, so the store knew it had been used while it deleted it. It was the only skill in
    // the entire day's log that the agent chose. Being chosen is the strongest positive evidence this
    // funnel can collect, and the cap was eating exactly that.
    //
    // A used draft leaves through the maturity ladder (recordSkillOutcome), never through the cap.
    const evictable = sorted.filter(isDeclinedDraft);
    const wanted = drafts.length - maxDrafts;
    const toDelete = evictable.slice(0, wanted);
    if (toDelete.length < wanted) {
      console.log(
        `[skill-funnel] cap ${maxDrafts}: ${wanted} over, only ${toDelete.length} have evidence against them — ` +
        `${wanted - toDelete.length} never-offered draft(s) kept (an untried hypothesis is not evicted for losing a race it never entered)`,
      );
    }
    let deleted = 0;
    for (const s of toDelete) {
      const why = s.useCount === 0
        ? `offered ${s.offeredCount}x (${s.matchedCount} by relevance), never chosen`
        : `score ${scoreSkill(s, now).toFixed(3)}`;
      if (this.deleteSkill(s.name)) {
        deleted++;
        console.log(`[skill-funnel] pruned draft '${s.name}' (${why})`);
      }
    }
    return deleted;
  }

  /**
   * Last-resort eviction when pruneDraftsToCap cannot evict (declined pool empty) but the creation-side
   * cap is blocking minting. Force-evicts the untested draft with the HIGHEST offered_count — it has been
   * shown the most times and never chosen, which is the strongest negative evidence short of the
   * isDeclinedDraft bar. A never-offered draft is never force-evicted: it has zero evidence against it.
   *
   * Rationale (prod 2026-08-05): with DECLINED_MIN_FALLBACK_OFFERS at 12 and one exploration slot per turn,
   * 40 drafts each need 12 fallback showings (≈480 turns ≈ 3.7 days) before pruneDraftsToCap can touch
   * them — during which minting is frozen and reflect.new_skill stays 0. Force-evicting the most-offered
   * draft breaks the deadlock without lowering the declined bar (which risks false-positive deletion of
   * useful skills on irrelevant-turn offers, as seen at DECLINED_MIN_FALLBACK_OFFERS=3 on 2026-08-04).
   *
   * Returns the evicted skill name, or null if there is nothing to force-evict (every draft has
   * offered_count 0 — genuinely never tested, the original design's "refuse to mint" applies).
   */
  forceEvictOldestDraft(): string | null {
    const row = this.db
      .prepare(
        `SELECT name FROM memory_skills
         WHERE maturity = 'draft' AND COALESCE(use_count, 0) = 0 AND COALESCE(from_disk, 0) = 0
           AND COALESCE(offered_count, 0) > 0
         ORDER BY COALESCE(offered_count, 0) DESC, created_at ASC
         LIMIT 1`,
      )
      .get() as { name: string } | undefined;
    if (!row) return null;
    if (this.deleteSkill(row.name)) return row.name;
    return null;
  }

  /**
   * Drafts that have never been offered to the model — hypotheses nobody has had the chance to test.
   *
   * This is the number the CREATION side must respect. The store's own design metric is "creation rate <=
   * measurement rate"; while it is violated, minting another draft cannot help and costs a real one, since
   * the cap has to evict something to make room.
   */
  untestedDraftCount(): number {
    // Counts what REFLECTION minted and nothing has yet PROVEN — the pool the creation-side bound reads.
    // Two corrections, each from one production day:
    //   - excludes from_disk (07-23 morning): importSkills sets no maturity, so all 68 disk skills counted
    //     as "untested drafts" and froze the reflector permanently. The number is an accusation against
    //     the generator; it must count only the generator's own output.
    //   - no longer excludes offered-but-unchosen drafts (07-23 night): being OFFERED is not being tested.
    //     With the offered=0 filter, every draft the exploration slot rotated through left this pool,
    //     minting unblocked, cap pressure returned, and the just-explored drafts were the ones evicted —
    //     an explore→evict→mint churn in which no hypothesis ever survived to a second showing. A draft
    //     leaves this pool by being USED (the maturity ladder takes over) or by being evicted after
    //     DECLINED_MIN_OFFERS showings.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_skills
         WHERE maturity = 'draft' AND COALESCE(use_count, 0) = 0 AND COALESCE(from_disk, 0) = 0`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * Record that these skills were OFFERED to the model in this turn's recall index (v36).
   *
   * The counterpart to recordSkillOutcome. The maturity ladder only ever observed ACCEPTANCE, so a skill
   * the model never picked was indistinguishable from a skill the model never saw — and the loop could
   * neither promote nor honestly reject anything. Best-effort: never throw into the prompt-build path.
   */
  recordSkillsOffered(names: string[], matchedNames: readonly string[] = []): void {
    if (!names.length) return;
    try {
      const matched = new Set(matchedNames);
      const bump = this.db.prepare<[string]>(
        `UPDATE memory_skills SET offered_count = offered_count + 1 WHERE name = ?`,
      );
      const bumpMatched = this.db.prepare<[string]>(
        `UPDATE memory_skills SET offered_count = offered_count + 1, matched_count = matched_count + 1
          WHERE name = ?`,
      );
      const tx = this.db.transaction((ns: string[]) => {
        for (const n of ns) (matched.has(n) ? bumpMatched : bump).run(n);
      });
      tx(names);
    } catch {
      // Instrumentation must never break the turn.
    }
  }

  /**
   * List all skills whose source starts with the specified prefix (for ClawHub list / filtering by registry).
   *
   * Example: listBySourcePrefix('clawhub:') returns all ClawHub-loaded skills,
   * regardless of version. Sorted by createdAt DESC, most recently loaded first.
   */
  listBySourcePrefix(sourcePrefix: string): Skill[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM memory_skills
         WHERE source LIKE ?
         ORDER BY created_at DESC`
      )
      .all(`${sourcePrefix}%`) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * Skills the reload-prune may delete for being absent from disk: the ones the DISK IMPORTER stamped.
   *
   * This used to be a denylist — everything with a non-null source except `self:%` — and the exclusion
   * list was the bug. Its own comment explained the shape ("non-NULL source but no corresponding file on
   * disk — disk scan will never find them → they would be mistakenly deleted"), noted it was fixed for
   * `self:%` in May, and then `auto-recovery:*` was introduced elsewhere without joining the list. A
   * plan-failure playbook was deleted by an unrelated file event, and the disk prune had no way to know it
   * had never been a disk skill.
   *
   * The judgement is now positive provenance rather than absence of evidence: importSkills stamps
   * from_disk, so a source nobody has taught this file about is safe BY DEFAULT. That is the direction
   * that survives someone adding a new kind of skill without reading this comment.
   *
   * No scoring; sorted by createdAt DESC — prune does not need ranking.
   */
  listExternalSkills(): Skill[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_skills
         WHERE from_disk = 1
         ORDER BY created_at DESC`,
      )
      .all() as SkillRow[];
    return rows.map(rowToSkill);
  }

  /**
   * Reflection-minted drafts nobody has ever been shown, oldest-offered first.
   *
   * The exploration slot's supply. offered_count exists to tell "never shown" apart from "shown and
   * declined" — but production shows the same six mature skills offered on every single turn regardless of
   * the query, so no draft ever moved off zero, and the distinction the column was added to make could
   * never be made. Relevance ranking cannot rescue this on its own: for a Chinese query the tokenizer
   * yields nothing to match on, jaccard is zero across the board, and the order collapses back to
   * use_count — which every draft is at the bottom of by definition.
   *
   * So one slot is reserved and drawn from here. Ordering is least-recently-offered so the pool rotates
   * rather than re-showing the same candidate, and disk skills are excluded because they are not
   * hypotheses the reflector is on the hook for.
   */
  untestedDraftsForExploration(limit = 1): Skill[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_skills
         WHERE maturity = 'draft' AND COALESCE(from_disk, 0) = 0 AND kind != 'negative'
         ORDER BY COALESCE(offered_count, 0) ASC, COALESCE(last_used_at, 0) ASC, created_at ASC
         LIMIT ?`,
      )
      .all(limit) as SkillRow[];
    return rows.map(rowToSkill);
  }

  /** Offered-vs-total over REFLECTION drafts — the health report's skills ratio, matching the slot's supply. */
  reflectionDraftStats(): { offered: number; drafts: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS drafts, SUM(CASE WHEN COALESCE(offered_count, 0) > 0 THEN 1 ELSE 0 END) AS offered
         FROM memory_skills WHERE maturity = 'draft' AND COALESCE(from_disk, 0) = 0`,
      )
      .get() as { drafts: number; offered: number | null };
    return { offered: row.offered ?? 0, drafts: row.drafts };
  }

  /** Stamp a skill as disk-imported. Called by importSkills; nothing else should set this. */
  markFromDisk(names: readonly string[]): void {
    if (names.length === 0) return;
    const stmt = this.db.prepare<[string]>(`UPDATE memory_skills SET from_disk = 1 WHERE name = ?`);
    const tx = this.db.transaction(() => {
      for (const n of names) stmt.run(n);
    });
    tx();
  }
}
