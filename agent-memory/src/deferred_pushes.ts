/** Durable mailbox for proactive messages a channel can deliver only on the next inbound turn. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type DeferredPushSeverity = 'urgent' | 'digest';

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
}

const rowToPush = (r: DeferredPushRow): DeferredPush => ({
  id: r.id, channel: r.channel, peer: r.peer, severity: r.severity,
  kind: r.kind, targetRef: r.target_ref, text: r.text,
  createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at,
});

export class DeferredPushStore {
  constructor(private readonly db: Database.Database) {}

  /** Upsert by semantic identity so repeated retries never create duplicate cards. */
  enqueue(input: Omit<DeferredPush, 'id' | 'createdAt' | 'updatedAt'>, now = Date.now()): DeferredPush {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO deferred_pushes
       (id, channel, peer, severity, kind, target_ref, text, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, peer, kind, target_ref) DO UPDATE SET
         severity = excluded.severity, text = excluded.text,
         updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
    ).run(id, input.channel, input.peer, input.severity, input.kind, input.targetRef,
      input.text, now, now, input.expiresAt);
    return this.get(input.channel, input.peer, input.kind, input.targetRef)!;
  }

  get(channel: string, peer: string, kind: string, targetRef: string): DeferredPush | null {
    const row = this.db.prepare(
      `SELECT * FROM deferred_pushes WHERE channel=? AND peer=? AND kind=? AND target_ref=?`,
    ).get(channel, peer, kind, targetRef) as DeferredPushRow | undefined;
    return row ? rowToPush(row) : null;
  }

  /** Remove expired rows and return the count so expiration can never be silent. */
  pruneExpired(now = Date.now()): number {
    return this.db.prepare(`DELETE FROM deferred_pushes WHERE expires_at <= ?`).run(now).changes;
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

  /** Compatibility helper for callers that need exactly one. */
  peek(channel: string, peer: string, now = Date.now()): DeferredPush | null {
    this.pruneExpired(now);
    return this.listPending(channel, peer, 1, now)[0] ?? null;
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
