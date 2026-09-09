/**
 * MetricsStore — lightweight, persisted key→count counters for self-learning instrumentation
 * (2026-06-22).
 *
 * Purpose: measure whether the learning machinery (routing-rule injection/outcome, turn-close
 * reflection production, in-turn reminders, playbook/anti-pattern injection, doom-loop suppression)
 * actually reaches the agent and matures — so the keep/simplify decision is data-driven rather than
 * by intuition. Deliberately tiny: a single counter table, atomic increments, no LLM, no state machine.
 *
 * All methods SWALLOW their own errors (telemetry must never affect the main control flow), so call
 * sites can write `memory.metrics.increment('x')` without try/catch.
 */
import type Database from 'better-sqlite3';

export interface MetricRow {
  key: string;
  count: number;
  updatedAt: number;
}

export interface DailyMetricSnapshot {
  day: string;
  metrics: Record<string, number>;
}

export class MetricsStore {
  constructor(private readonly db: Database.Database) {}

  /** Atomically add `n` to a counter (creates it at `n` if absent). Never throws. */
  increment(key: string, n = 1, now: number = Date.now()): void {
    try {
      this.db
        .prepare(
          `INSERT INTO learning_metrics (key, count, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at`,
        )
        .run(key, n, now);
    } catch (e) {
      console.warn(`[metrics] increment(${key}) failed, ignored:`, (e as Error)?.message);
    }
  }

  /** Set an absolute value (used for day-stamps / gauges). Never throws. */
  set(key: string, value: number, now: number = Date.now()): void {
    try {
      this.db
        .prepare(
          `INSERT INTO learning_metrics (key, count, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`,
        )
        .run(key, value, now);
    } catch (e) {
      console.warn(`[metrics] set(${key}) failed, ignored:`, (e as Error)?.message);
    }
  }

  /** Read one counter (0 if absent). Never throws. */
  get(key: string): number {
    try {
      const row = this.db
        .prepare(`SELECT count FROM learning_metrics WHERE key = ?`)
        .get(key) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /** All counters, sorted by key. Never throws. */
  snapshot(): MetricRow[] {
    try {
      const rows = this.db
        .prepare(`SELECT key, count, updated_at AS updatedAt FROM learning_metrics ORDER BY key`)
        .all() as MetricRow[];
      return rows;
    } catch {
      return [];
    }
  }

  /** Persist the current cumulative counters under a UTC day. Never throws. */
  snapshotDaily(day: string, now: number = Date.now()): void {
    try {
      const rows = this.db.prepare(`SELECT key, count FROM learning_metrics WHERE key != 'stats.last_logged_ymd'`).all() as Array<{ key: string; count: number }>;
      const stmt = this.db.prepare(
        `INSERT INTO learning_metric_daily (day, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      const tx = this.db.transaction(() => { for (const row of rows) stmt.run(day, row.key, row.count, now); });
      tx();
    } catch (e) {
      console.warn(`[metrics] snapshotDaily(${day}) failed, ignored:`, (e as Error)?.message);
    }
  }

  /** Read daily snapshots, oldest first, with one object per day. Never throws. */
  dailySnapshots(days = 30): DailyMetricSnapshot[] {
    try {
      const rows = this.db.prepare(
        `SELECT day, key, value FROM learning_metric_daily
         WHERE day >= date('now', ?)
         ORDER BY day ASC, key ASC`,
      ).all(`-${Math.max(1, Math.min(3650, Math.floor(days)))} days`) as Array<{ day: string; key: string; value: number }>;
      const grouped = new Map<string, Record<string, number>>();
      for (const row of rows) { if (!grouped.has(row.day)) grouped.set(row.day, {}); grouped.get(row.day)![row.key] = row.value; }
      return [...grouped.entries()].map(([day, metrics]) => ({ day, metrics }));
    } catch { return []; }
  }
}
