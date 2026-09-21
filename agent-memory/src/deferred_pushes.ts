/** Durable mailbox for proactive messages a channel can deliver only on the next inbound turn. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type DeferredPushSeverity = 'urgent' | 'digest';

/**
 * What the series rule folded into this row (2026-09-21). The rule used to DELETE the older pending
 * reports of a series when a newer one arrived; a morning of forty auto-advance rounds reached the
 * owner as one line. The newest report still carries the whole state, but the rounds it replaced are
 * kept as a count and their headlines, so the card the owner finally sees says what happened in
 * between, not only where things stand now.
 */
export interface FoldedReports {
  /** Reports folded into this one (not counting itself). */
  count: number;
  /** createdAt of the oldest folded report. */
  since: number;
  /** One line per folded report, oldest first, bounded. */
  headlines: string[];
}

export interface DeferredPush {
  id: string;
  channel: string;
  peer: string;
  severity: DeferredPushSeverity;
  kind: string;
  targetRef: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  folded?: FoldedReports | null;
}

export interface DeferredPushExpirySummary {
  count: number;
  byKind: Record<string, number>;
  byChannel: Record<string, number>;
}

interface DeferredPushRow {
  id: string;
  channel: string;
  peer: string;
  severity: DeferredPushSeverity;
  kind: string;
  target_ref: string;
  text: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  folded_json?: string | null;
}

function parseFolded(raw: string | null | undefined): FoldedReports | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<FoldedReports>;
    if (!v || typeof v !== 'object') return null;
    return {
      count: Math.max(0, Number(v.count) || 0),
      since: Number(v.since) || 0,
      headlines: Array.isArray(v.headlines) ? v.headlines.filter((h): h is string => typeof h === 'string') : [],
    };
  } catch {
    return null;
  }
}

const rowToPush = (r: DeferredPushRow): DeferredPush => ({
  id: r.id, channel: r.channel, peer: r.peer, severity: r.severity,
  kind: r.kind, targetRef: r.target_ref, text: r.text,
  createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
  folded: parseFolded(r.folded_json),
});

/**
 * Ownership convention: **an expired row should only be deleted by a caller that durably records the
 * expiry first.** This is call-site discipline, not a guarantee — `pruneExpired` is public (the only
 * maintainer lives in the server package) and nothing here stops a future caller from bypassing it. What
 * enforces it today is a single production call site plus a test that fails if an ordinary write starts
 * pruning again.
 *
 * The convention exists because DELETE and the durable account of it are two statements, not one
 * transaction: whoever deletes can crash before recording. Keeping the deleter singular reduces that to
 * one narrow window inside the maintenance pass; it does not remove it. Strictly never losing an expiry
 * would need an expiry ledger written in the same SQLite transaction as the DELETE, which would couple
 * this store to the metrics schema — deliberately not done, because expiry counts are observability, not
 * business state.
 *
 * Reads never depended on pruning: `listPending` filters on `expires_at > now`, so an unpruned expired
 * row is undeliverable, merely still resident. Leaving it until the next maintenance pass costs at most
 * an hour of dead rows.
 */
export class DeferredPushStore {
  constructor(private readonly db: Database.Database) {}

  /** Upsert by semantic identity so repeated retries never create duplicate cards. */
  enqueue(input: Omit<DeferredPush, 'id' | 'createdAt' | 'updatedAt'>, now = Date.now()): DeferredPush {
    const id = randomUUID();
    const foldedJson = input.folded ? JSON.stringify(input.folded) : null;
    this.db.prepare(
      `INSERT INTO deferred_pushes
       (id, channel, peer, severity, kind, target_ref, text, created_at, updated_at, expires_at, folded_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer, kind, target_ref) DO UPDATE SET
         severity = excluded.severity, text = excluded.text,
         updated_at = excluded.updated_at, expires_at = excluded.expires_at,
         folded_json = excluded.folded_json`,
    ).run(id, input.channel, input.peer, input.severity, input.kind, input.targetRef,
      input.text, now, now, input.expiresAt, foldedJson);
    return this.get(input.channel, input.peer, input.kind, input.targetRef)!;
  }

  /**
   * The pending rows of one series (same kind, targetRef prefix), oldest first, except `excludeId` —
   * what `discardSeries` is about to delete, read first so it can be folded into the survivor.
   */
  listSeries(channel: string, peer: string, kind: string, targetRefPrefix: string, excludeId?: string, now = Date.now()): DeferredPush[] {
    if (!targetRefPrefix) return [];
    const escaped = targetRefPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db.prepare(
      `SELECT * FROM deferred_pushes
       WHERE channel=? AND peer=? AND kind=? AND target_ref LIKE ? ESCAPE '\\' AND expires_at>? AND (? IS NULL OR id<>?)
       ORDER BY created_at ASC`,
    ).all(channel, peer, kind, `${escaped}%`, now, excludeId ?? null, excludeId ?? null) as DeferredPushRow[];
    return rows.map(rowToPush);
  }

  get(channel: string, peer: string, kind: string, targetRef: string): DeferredPush | null {
    const row = this.db.prepare(
      `SELECT * FROM deferred_pushes WHERE channel=? AND peer=? AND kind=? AND target_ref=?`,
    ).get(channel, peer, kind, targetRef) as DeferredPushRow | undefined;
    return row ? rowToPush(row) : null;
  }

  /**
   * Remove expired rows and return the non-sensitive aggregate. The caller MUST persist the returned
   * summary before doing anything else — see the ownership invariant on this class. Aggregate only:
   * message text, peer and targetRef never leave the store.
   */
  pruneExpired(now = Date.now()): DeferredPushExpirySummary {
    const rows = this.db.prepare(
      `SELECT kind, channel, COUNT(*) AS count FROM deferred_pushes
       WHERE expires_at <= ? GROUP BY kind, channel`,
    ).all(now) as Array<{ kind: string; channel: string; count: number }>;
    const summary: DeferredPushExpirySummary = { count: 0, byKind: {}, byChannel: {} };
    for (const row of rows) {
      summary.count += row.count;
      summary.byKind[row.kind] = (summary.byKind[row.kind] ?? 0) + row.count;
      summary.byChannel[row.channel] = (summary.byChannel[row.channel] ?? 0) + row.count;
    }
    if (summary.count > 0) {
      this.db.prepare(`DELETE FROM deferred_pushes WHERE expires_at <= ?`).run(now);
    }
    return summary;
  }

  /** Bounded selection: urgent first, then oldest digest. Reading never consumes. */
  listPending(channel: string, peer: string, limit = 3, now = Date.now()): DeferredPush[] {
    if (!Number.isInteger(limit) || limit < 1) return [];
    const rows = this.db.prepare(
      `SELECT * FROM deferred_pushes
       WHERE channel=? AND peer=? AND expires_at>?
       ORDER BY CASE severity WHEN 'urgent' THEN 0 ELSE 1 END, created_at ASC LIMIT ?`,
    ).all(channel, peer, now, limit) as DeferredPushRow[];
    return rows.map(rowToPush);
  }

  /**
   * Drop the pending rows of one kind whose targetRef starts with `targetRefPrefix`, except `keepId`.
   * For report series where the newest item makes the older ones obsolete (a progress card carries
   * the whole tree state, so "round 13" delivered a day after "round 1 of the next batch" is noise):
   * prod 2026-09-17 16:49 handed the owner three cards from the previous night with counts a live
   * card had already contradicted. Prefix match only — `%`/`_` in the prefix are escaped.
   */
  discardSeries(channel: string, peer: string, kind: string, targetRefPrefix: string, keepId?: string): number {
    if (!targetRefPrefix) return 0;
    const escaped = targetRefPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.db.prepare(
      `DELETE FROM deferred_pushes
       WHERE channel=? AND peer=? AND kind=? AND target_ref LIKE ? ESCAPE '\\' AND (? IS NULL OR id<>?)`,
    ).run(channel, peer, kind, `${escaped}%`, keepId ?? null, keepId ?? null).changes;
  }

  /** Drop every pending row of one kind — for kinds that stopped being deferrable. */
  discardKind(kind: string): number {
    return this.db.prepare(`DELETE FROM deferred_pushes WHERE kind=?`).run(kind).changes;
  }

  markDelivered(id: string): boolean {
    return this.db.prepare(`DELETE FROM deferred_pushes WHERE id=?`).run(id).changes > 0;
  }

  markManyDelivered(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const remove = this.db.prepare(`DELETE FROM deferred_pushes WHERE id=?`);
    return this.db.transaction((xs: readonly string[]) => xs.reduce((n, id) => n + remove.run(id).changes, 0))(ids);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM deferred_pushes`).get() as { n: number }).n;
  }
}
