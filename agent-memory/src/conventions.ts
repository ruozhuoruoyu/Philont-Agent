/**
 * ConventionStore (2026-10-08): acceptance conventions learned from failed checks — the failure-side
 * learning family (ACE-style counted rules / philosophers exp 115's check bank), as distinct from the
 * success-side family (cases, trajectory replay).
 *
 * Why a separate store: philosophers exp 115/116 found two memory families with different triggers.
 * Conventions a model cannot guess from the task text (an unnamed status file, a literal permission
 * bit) are invisible in successful trajectories (replay 0–14% on those templates) but recoverable from
 * the *failed acceptance checks* of earlier tasks (ACE / check bank 24–64%). They only help where
 * failures recur across tasks (ConvStream, AppWorld app conventions), not where every task's checker is
 * different (LifelongAgentBench OS) — so the store is keyed by environment and every rule carries
 * helpful/harmful counts that decide whether it keeps being shown.
 *
 * Write policy: one row per (env_key, normalized rule text); re-learning the same rule bumps `seen`.
 * Read policy: token-Jaccard of the task text against the rule's trigger words (+ rule text), score > 0
 * only; rules whose harmful count exceeds helpful by more than 2 are retired from selection. Callers
 * report the outcome of a task in which rules were shown (`feedback`), ACE-style.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { tokenize, jaccard } from './text_tokenize.js';

export interface ConventionInput {
  envKey: string;
  /** The rule as shown to the model: one sentence, imperative, environment-general. */
  rule: string;
  /** Where it came from: the failing check clause / test requirement (bounded). */
  source?: string | null;
  /** Words of the task(s) that triggered it; retrieval key. Defaults to the rule's own tokens. */
  trigger?: string | null;
}

export interface Convention {
  id: string;
  envKey: string;
  rule: string;
  source: string | null;
  trigger: string;
  helpful: number;
  harmful: number;
  seen: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConventionMatch extends Convention {
  score: number;
}

interface Row {
  id: string;
  env_key: string;
  rule: string;
  source: string | null;
  trigger: string;
  helpful: number;
  harmful: number;
  seen: number;
  created_at: number;
  updated_at: number;
}

const RULE_MAX = 300;
const SOURCE_MAX = 400;
const TRIGGER_MAX = 400;
export const CONVENTION_RETAIN_MAX_PER_ENV = 500;
/** A rule is retired from selection once it has misled more often than it helped, by this margin. */
export const CONVENTION_RETIRE_MARGIN = 2;

/** Function words that would make every rule "applicable" to every task; dropped before matching. */
const STOP = new Set('the a an and or of to in on for with from by at as is are be this that these those it its into all any each my me i you your when if then must should not no do does did file files task tasks'.split(' '));
function keyTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text ?? '')) if (!STOP.has(t) && t.length >= 3) out.add(t);
  return out;
}

function norm(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

function rowToConvention(r: Row): Convention {
  return { id: r.id, envKey: r.env_key, rule: r.rule, source: r.source, trigger: r.trigger, helpful: r.helpful, harmful: r.harmful, seen: r.seen, createdAt: r.created_at, updatedAt: r.updated_at };
}

export class ConventionStore {
  constructor(private readonly db: Database.Database) {}

  /** Insert, or bump `seen` on the identical rule in the same environment. Returns null for a blank rule. */
  record(input: ConventionInput, now: number = Date.now()): Convention | null {
    const rule = norm(input.rule).slice(0, RULE_MAX);
    const envKey = norm(input.envKey) || 'default';
    if (!rule) return null;
    const existing = this.db.prepare(`SELECT * FROM memory_conventions WHERE env_key = ? AND lower(rule) = lower(?)`).get(envKey, rule) as Row | undefined;
    if (existing) {
      this.db.prepare(`UPDATE memory_conventions SET seen = seen + 1, updated_at = ? WHERE id = ?`).run(now, existing.id);
      return this.get(existing.id);
    }
    const trigger = norm(input.trigger ?? '') ? [...tokenize(norm(input.trigger ?? ''))].join(' ').slice(0, TRIGGER_MAX) : [...tokenize(rule)].join(' ').slice(0, TRIGGER_MAX);
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO memory_conventions (id, env_key, rule, source, trigger, helpful, harmful, seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`)
      .run(id, envKey, rule, input.source ? norm(input.source).slice(0, SOURCE_MAX) : null, trigger, now, now);
    this.trim(envKey);
    return this.get(id);
  }

  get(id: string): Convention | null {
    const row = this.db.prepare(`SELECT * FROM memory_conventions WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToConvention(row) : null;
  }

  /**
   * Rules of `envKey` applicable to `query`: Jaccard(query tokens, trigger ∪ rule tokens) > 0, not retired,
   * best first (score, then net helpfulness, then recency). At most `k`.
   */
  select(envKey: string, query: string, k = 5): ConventionMatch[] {
    const q = keyTokens(query ?? '');
    if (q.size === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM memory_conventions WHERE env_key = ? ORDER BY updated_at DESC LIMIT 2000`).all(norm(envKey) || 'default') as Row[];
    const out: ConventionMatch[] = [];
    for (const r of rows) {
      if (r.harmful > r.helpful + CONVENTION_RETIRE_MARGIN) continue;
      // Match on the trigger (words of the tasks that taught the rule) plus the rule's own content words;
      // function words are excluded so a rule is never "applicable" by sharing only "the" with the task.
      const score = jaccard(q, new Set([...keyTokens(r.trigger), ...keyTokens(r.rule)]));
      if (score > 0) out.push({ ...rowToConvention(r), score });
    }
    out.sort((a, b) => b.score - a.score || (b.helpful - b.harmful) - (a.helpful - a.harmful) || b.updatedAt - a.updatedAt);
    return out.slice(0, Math.max(1, k));
  }

  /** ACE-style outcome credit for the rules that were shown in a task: all helpful if it passed, all harmful if not. */
  feedback(ids: readonly string[], passed: boolean, now: number = Date.now()): void {
    if (ids.length === 0) return;
    const col = passed ? 'helpful' : 'harmful';
    const stmt = this.db.prepare(`UPDATE memory_conventions SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`);
    for (const id of ids) stmt.run(now, id);
  }

  count(envKey?: string): number {
    if (envKey === undefined) return (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_conventions`).get() as { n: number }).n;
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_conventions WHERE env_key = ?`).get(norm(envKey) || 'default') as { n: number }).n;
  }

  list(envKey: string, limit = 50): Convention[] {
    return (this.db.prepare(`SELECT * FROM memory_conventions WHERE env_key = ? ORDER BY (helpful - harmful) DESC, updated_at DESC LIMIT ?`).all(norm(envKey) || 'default', limit) as Row[]).map(rowToConvention);
  }

  private trim(envKey: string): void {
    const n = this.count(envKey);
    if (n <= CONVENTION_RETAIN_MAX_PER_ENV) return;
    // Retire the least useful first (most harmful net), then the oldest.
    this.db
      .prepare(`DELETE FROM memory_conventions WHERE id IN (SELECT id FROM memory_conventions WHERE env_key = ? ORDER BY (helpful - harmful) ASC, updated_at ASC LIMIT ?)`)
      .run(envKey, n - CONVENTION_RETAIN_MAX_PER_ENV);
  }
}
