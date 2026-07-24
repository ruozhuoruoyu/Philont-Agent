/**
 * InitiativeStore — CRUD for the memory_initiatives table.
 *
 * Lifecycle of a single initiative:
 *   driver.propose() → store.insert(pending) → executor.run() →
 *   store.markRunning() → store.markDone()/markFailed()/markSkipped()
 *
 * 24h dedup: listRecentSettledTargetRefs is used by the loop to filter out
 * targets that have been handled (succeeded or failed) recently before dispatching.
 * Failed items also enter dedup to prevent garbage tokens from repeatedly wasting LLM tokens.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Initiative,
  InitiativeOutcomeRefs,
  InitiativeProposal,
  InitiativeStatus,
} from './types.js';

interface InitiativeRow {
  id: string;
  kind: string;
  driver: string;
  target_ref: string;
  rationale: string;
  utility: number;
  status: string;
  budget_estimate: number;
  budget_actual: number | null;
  outcome_summary: string | null;
  outcome_refs: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function rowToInitiative(row: InitiativeRow): Initiative {
  let refs: InitiativeOutcomeRefs | null = null;
  if (row.outcome_refs) {
    try {
      const parsed = JSON.parse(row.outcome_refs) as Partial<InitiativeOutcomeRefs>;
      refs = {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
        pursuits: Array.isArray(parsed.pursuits) ? parsed.pursuits : [],
      };
    } catch {
      refs = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    driver: row.driver,
    targetRef: row.target_ref,
    rationale: row.rationale,
    utility: row.utility,
    status: parseStatus(row.status),
    budgetEstimate: row.budget_estimate,
    budgetActual: row.budget_actual,
    outcomeSummary: row.outcome_summary,
    outcomeRefs: refs,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseStatus(s: string): InitiativeStatus {
  if (
    s === 'pending' ||
    s === 'running' ||
    s === 'done' ||
    s === 'failed' ||
    s === 'skipped'
  ) {
    return s;
  }
  return 'pending';
}

const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class InitiativeStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Persist a candidate to the database with status pending. Returns the full Initiative.
   */
  insert(p: InitiativeProposal): Initiative {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare<[
        string, string, string, string, string, number, number, number,
      ]>(
        `INSERT INTO memory_initiatives
         (id, kind, driver, target_ref, rationale, utility, budget_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.kind,
        p.driver,
        p.targetRef,
        p.rationale,
        p.utility,
        p.budgetEstimate,
        createdAt,
      );
    return {
      ...p,
      id,
      status: 'pending',
      budgetActual: null,
      outcomeSummary: null,
      outcomeRefs: null,
      error: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
  }

  getById(id: string): Initiative | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM memory_initiatives WHERE id = ?`)
      .get(id) as InitiativeRow | undefined;
    return row ? rowToInitiative(row) : null;
  }

  /**
   * Mark as running. Returns updated Initiative; returns null if not in pending state.
   */
  markRunning(id: string): Initiative | null {
    const startedAt = Date.now();
    const r = this.db
      .prepare<[number, string]>(
        `UPDATE memory_initiatives
         SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(startedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markDone(
    id: string,
    summary: string,
    refs: InitiativeOutcomeRefs,
    budgetActual: number,
  ): Initiative | null {
    const completedAt = Date.now();
    const refsJson = JSON.stringify(refs);
    const r = this.db
      .prepare<[string, string, number, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'done',
             outcome_summary = ?,
             outcome_refs = ?,
             budget_actual = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(summary, refsJson, budgetActual, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markFailed(id: string, error: string, budgetActual: number): Initiative | null {
    const completedAt = Date.now();
    const r = this.db
      .prepare<[string, number, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'failed',
             error = ?,
             budget_actual = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(error, budgetActual, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  markSkipped(id: string, reason: string): Initiative | null {
    const completedAt = Date.now();
    const r = this.db
      .prepare<[string, number, string]>(
        `UPDATE memory_initiatives
         SET status = 'skipped',
             error = ?,
             completed_at = ?
         WHERE id = ?`,
      )
      .run(reason, completedAt, id);
    if (r.changes === 0) return null;
    return this.getById(id);
  }

  /**
   * Set of target_refs that are done or failed within the last 24h (used by loop for dedup before dispatching).
   *
   * Previously only done was checked, causing the same garbage token (e.g. a common Chinese phrase
   * caught by CuriosityDriver) to be repeatedly proposed → executor repeatedly fails → repeatedly proposed,
   * wasting tokens. Now failed also enters the dedup ring; the same target won't be retried for 24h.
   * For transient failures (network hiccups etc.), the 24h window naturally unlocks retry.
   */
  listRecentSettledTargetRefs(windowMs = DEFAULT_DEDUPE_WINDOW_MS, now = Date.now()): Set<string> {
    const since = now - windowMs;
    const rows = this.db
      .prepare<[number]>(
        `SELECT DISTINCT target_ref FROM memory_initiatives
         WHERE status IN ('done', 'failed') AND completed_at IS NOT NULL AND completed_at >= ?`,
      )
      .all(since) as Array<{ target_ref: string }>;
    return new Set(rows.map((r) => r.target_ref));
  }

  /**
   * Targets currently DORMANT under escalating backoff — the dedup set the loop should actually use.
   *
   * The flat 24h window above re-arms everything daily, and production showed what that buys: the same
   * ~40 gap facts re-researched every day at the same clock positions, and the same three Jacobian
   * article URLs fetched on the 23rd at 11:41, again at 12:16, and again on the 24th at 13:12 and 13:47 —
   * about 57k tokens in one 45-minute stretch, none of it new. A lookup that keeps settling without
   * changing anything is not information the system lacks; it is a question whose answer did not help,
   * and asking it again tomorrow will not improve the answer.
   *
   * Backoff: a target settled N times in the last 30 days sleeps min(30d, 24h × 2^(N−1)) from its last
   * settle. First settle keeps today's behaviour (1 day); unproductive repeats earn 2d, 4d, 8d… 30d cap.
   * Escalation only ever bites the UNPRODUCTIVE repeats by construction: a lookup that produced a new
   * fact removes its own target from the gap/token pools, so it is never re-proposed at all.
   */
  listDormantTargetRefs(now = Date.now()): Set<string> {
    const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
    const CAP_MS = LOOKBACK_MS;
    const rows = this.db
      .prepare<[number]>(
        `SELECT target_ref, COUNT(*) AS n, MAX(completed_at) AS last
         FROM memory_initiatives
         WHERE status IN ('done', 'failed') AND completed_at IS NOT NULL AND completed_at >= ?
         GROUP BY target_ref`,
      )
      .all(now - LOOKBACK_MS) as Array<{ target_ref: string; n: number; last: number }>;
    const dormant = new Set<string>();
    for (const r of rows) {
      const sleepMs = Math.min(CAP_MS, DEFAULT_DEDUPE_WINDOW_MS * 2 ** (r.n - 1));
      if (now - r.last < sleepMs) dormant.add(r.target_ref);
    }
    return dormant;
  }

  /** @deprecated Use listRecentSettledTargetRefs (failed also deduped) instead */
  listRecentDoneTargetRefs(windowMs = DEFAULT_DEDUPE_WINDOW_MS, now = Date.now()): Set<string> {
    return this.listRecentSettledTargetRefs(windowMs, now);
  }

  /**
   * List initiatives in pending status, ordered by utility DESC + created_at ASC.
   * Loop usually doesn't use this directly — dispatches immediately after propose —
   * but retained for recovery / debugging.
   */
  listPending(limit = 20): Initiative[] {
    const rows = this.db
      .prepare<[number]>(
        `SELECT * FROM memory_initiatives
         WHERE status = 'pending'
         ORDER BY utility DESC, created_at ASC
         LIMIT ?`,
      )
      .all(limit) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  /**
   * List the most recent N done initiatives (for chat-handler to render "what I just did").
   * Ordered by completed_at DESC; only those after sinceTs.
   */
  listRecentDone(sinceTs: number, limit = 5): Initiative[] {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT * FROM memory_initiatives
         WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?
         ORDER BY completed_at DESC
         LIMIT ?`,
      )
      .all(sinceTs, limit) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM memory_initiatives`)
      .get() as { n: number };
    return row.n;
  }

  countByStatus(status: InitiativeStatus): number {
    const row = this.db
      .prepare<[string]>(
        `SELECT COUNT(*) as n FROM memory_initiatives WHERE status = ?`,
      )
      .get(status) as { n: number };
    return row.n;
  }

  /**
   * WS2 (selfhood_closure): when this driver last created an initiative — the reference point
   * for the reflector-tuned per-driver propose cooldown.
   */
  lastCreatedAtByDriver(driver: string): number | null {
    const row = this.db
      .prepare<[string]>(
        `SELECT MAX(created_at) as t FROM memory_initiatives WHERE driver = ?`,
      )
      .get(driver) as { t: number | null };
    return row.t ?? null;
  }

  /**
   * WS1 (selfhood_closure): settled done/failed counts for one driver since a timestamp —
   * the raw material for the curiosity trait signal (ratioWithShrinkage).
   */
  countSettledByDriverSince(
    driver: string,
    sinceTs: number,
  ): { done: number; failed: number } {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT status, COUNT(*) as n FROM memory_initiatives
         WHERE driver = ? AND status IN ('done', 'failed') AND created_at >= ?
         GROUP BY status`,
      )
      .all(driver, sinceTs) as Array<{ status: string; n: number }>;
    let done = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === 'done') done = r.n;
      else if (r.status === 'failed') failed = r.n;
    }
    return { done, failed };
  }

  /**
   * General recent list — for dashboard / debugging; can filter by status / driver.
   * Ordered by created_at DESC; default limit 30.
   */
  listRecent(opts: {
    limit?: number;
    status?: InitiativeStatus;
    driver?: string;
  } = {}): Initiative[] {
    const limit = opts.limit ?? 30;
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.status) {
      conds.push('status = ?');
      params.push(opts.status);
    }
    if (opts.driver) {
      conds.push('driver = ?');
      params.push(opts.driver);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit);
    // rowid as stable tiebreaker when multiple inserts happen within the same ms
    // (id is a UUID string; lexicographic order does not reflect insertion order)
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_initiatives
         ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params) as InitiativeRow[];
    return rows.map(rowToInitiative);
  }

  /**
   * Count by status group (for overview). Returns a structure with all 5 tiers, defaulting to 0.
   */
  countByStatusGroup(): Record<InitiativeStatus, number> {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as n FROM memory_initiatives GROUP BY status`,
      )
      .all() as Array<{ status: string; n: number }>;
    const out: Record<InitiativeStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    };
    for (const r of rows) {
      const s = parseStatus(r.status);
      out[s] = r.n;
    }
    return out;
  }
}
