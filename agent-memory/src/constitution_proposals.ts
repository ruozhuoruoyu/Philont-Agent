/**
 * Constitution proposals (WS3, docs/design/selfhood_closure.md) — the identity-evolution channel.
 *
 * The constitution (the root pursuit's four constitution_* fields) is write-once at bootstrap and
 * frozen during runs. This module makes it a LIVE identity without giving the agent a free pen:
 * the agent PROPOSES an amendment with evidence, the owner RATIFIES, and only then is the
 * constitution amended — append-only, provenance-stamped, hash-audited.
 *
 * Hard rules:
 *   - Red lines are NOT amendable through this channel, period. The two supported kinds can only
 *     touch driveBounds (widen a tuning range) and values (append an annotation).
 *   - Amendments are append-only: existing text is never rewritten.
 *   - A rejected proposal suppresses re-proposal of identical content for 30 days.
 *   - Surfacing is rate-limited (default: at most one proposal shown per 24h).
 *
 * Producers today: SessionDriveReflector's out-of-bounds tuning attempts (drive_bounds kind).
 * The value_annotation kind is producer-ready for the consolidation-conflict pass.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PursuitStore } from './pursuit.js';
import type { MemoryAuditHook } from './audit.js';

export type ConstitutionProposalKind = 'drive_bounds' | 'value_annotation';
export type ConstitutionProposalStatus = 'pending' | 'approved' | 'rejected';

export interface DriveBoundsPayload {
  driveId: string;
  param: string;
  currentRange: [number, number];
  proposedValue: number;
}

export interface ValueAnnotationPayload {
  text: string;
}

export interface ConstitutionProposal {
  id: string;
  rootPursuitId: string;
  kind: ConstitutionProposalKind;
  payload: DriveBoundsPayload | ValueAnnotationPayload;
  rationale: string;
  evidenceRefs: string[];
  status: ConstitutionProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  surfacedAt: number | null;
}

export interface ConstitutionProposalInput {
  rootPursuitId: string;
  kind: ConstitutionProposalKind;
  payload: DriveBoundsPayload | ValueAnnotationPayload;
  rationale: string;
  evidenceRefs?: string[];
}

const REJECTED_SUPPRESSION_MS = 30 * 86_400_000;
const DEFAULT_SURFACE_INTERVAL_MS = 24 * 60 * 60_000;

interface Row {
  id: string;
  root_pursuit_id: string;
  kind: string;
  payload_json: string;
  rationale: string;
  evidence_refs_json: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  surfaced_at: number | null;
}

function rowToProposal(r: Row): ConstitutionProposal {
  return {
    id: r.id,
    rootPursuitId: r.root_pursuit_id,
    kind: r.kind as ConstitutionProposalKind,
    payload: JSON.parse(r.payload_json),
    rationale: r.rationale,
    evidenceRefs: JSON.parse(r.evidence_refs_json),
    status: r.status as ConstitutionProposalStatus,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    surfacedAt: r.surfaced_at,
  };
}

export class ConstitutionProposalStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * File a proposal. Dedup rules:
   *   - identical (kind, payload) already PENDING → returns the existing proposal (no duplicate);
   *   - identical content REJECTED within 30 days → returns null (owner said no; do not nag).
   */
  propose(input: ConstitutionProposalInput, now: number = Date.now()): ConstitutionProposal | null {
    const payloadJson = JSON.stringify(input.payload);
    const dupe = this.db
      .prepare<[string, string, string]>(
        `SELECT * FROM constitution_proposals
         WHERE root_pursuit_id = ? AND kind = ? AND payload_json = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.rootPursuitId, input.kind, payloadJson) as Row | undefined;
    if (dupe) {
      if (dupe.status === 'pending') return rowToProposal(dupe);
      if (
        dupe.status === 'rejected' &&
        dupe.decided_at !== null &&
        now - dupe.decided_at < REJECTED_SUPPRESSION_MS
      ) {
        return null;
      }
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO constitution_proposals
         (id, root_pursuit_id, kind, payload_json, rationale, evidence_refs_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.rootPursuitId,
        input.kind,
        payloadJson,
        input.rationale,
        JSON.stringify(input.evidenceRefs ?? []),
        now,
      );
    return this.get(id)!;
  }

  get(id: string): ConstitutionProposal | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM constitution_proposals WHERE id = ? LIMIT 1`)
      .get(id) as Row | undefined;
    return row ? rowToProposal(row) : null;
  }

  listPending(rootPursuitId: string, limit = 5): ConstitutionProposal[] {
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT * FROM constitution_proposals
         WHERE root_pursuit_id = ? AND status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(rootPursuitId, limit) as Row[];
    return rows.map(rowToProposal);
  }

  /**
   * The single proposal to surface to the owner now, or null. Rate limit: nothing is surfaced if
   * ANY proposal was surfaced within the interval (default 24h). Marks nothing — call
   * markSurfaced once actually rendered.
   */
  nextToSurface(
    rootPursuitId: string,
    now: number = Date.now(),
    minIntervalMs: number = DEFAULT_SURFACE_INTERVAL_MS,
  ): ConstitutionProposal | null {
    const recent = this.db
      .prepare<[string, number]>(
        `SELECT COUNT(*) as n FROM constitution_proposals
         WHERE root_pursuit_id = ? AND surfaced_at IS NOT NULL AND surfaced_at > ?`,
      )
      .get(rootPursuitId, now - minIntervalMs) as { n: number };
    if (recent.n > 0) return null;
    const pending = this.listPending(rootPursuitId, 1);
    return pending[0] ?? null;
  }

  markSurfaced(id: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, string]>(
        `UPDATE constitution_proposals SET surfaced_at = ? WHERE id = ?`,
      )
      .run(at, id);
  }

  /** pending → approved/rejected. Returns the updated proposal; null if missing or already decided. */
  decide(
    id: string,
    decision: 'approved' | 'rejected',
    at: number = Date.now(),
  ): ConstitutionProposal | null {
    const r = this.db
      .prepare<[string, number, string]>(
        `UPDATE constitution_proposals SET status = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, at, id);
    if (r.changes === 0) return null;
    return this.get(id);
  }
}

/** Render a proposal as the short human-decision card shown to the owner. */
export function renderProposalCard(p: ConstitutionProposal): string {
  const what =
    p.kind === 'drive_bounds'
      ? (() => {
          const pl = p.payload as DriveBoundsPayload;
          return `widen drive bound ${pl.driveId}.${pl.param} from [${pl.currentRange[0]}, ${pl.currentRange[1]}] to include ${pl.proposedValue}`;
        })()
      : `append a value annotation: "${(p.payload as ValueAnnotationPayload).text}"`;
  return `[proposal ${p.id.slice(0, 8)}] I propose to ${what}. Why: ${p.rationale}`;
}

/**
 * Apply an owner-APPROVED proposal to the constitution: append-only, red lines untouched,
 * audited with the post-amendment hash (same tamper-evidence chain as constitution_load).
 * Throws if the proposal is not pending (already decided) or unknown.
 */
export function approveAndApply(
  store: ConstitutionProposalStore,
  pursuits: PursuitStore,
  proposalId: string,
  auditHook?: MemoryAuditHook,
  now: number = Date.now(),
): ConstitutionProposal {
  const p = store.get(proposalId);
  if (!p) throw new Error(`constitution proposal ${proposalId} not found`);
  if (p.status !== 'pending') throw new Error(`constitution proposal ${proposalId} already ${p.status}`);

  const fields = pursuits.getConstitution(p.rootPursuitId) ?? {};
  const redLinesBefore = JSON.stringify(fields.redLines ?? null);

  if (p.kind === 'drive_bounds') {
    const pl = p.payload as DriveBoundsPayload;
    const bounds = { ...(fields.driveBounds ?? {}) };
    const forDrive = { ...(bounds[pl.driveId] ?? {}) };
    const existing = forDrive[pl.param] ?? pl.currentRange;
    forDrive[pl.param] = [
      Math.min(existing[0], pl.proposedValue),
      Math.max(existing[1], pl.proposedValue),
    ];
    bounds[pl.driveId] = forDrive;
    fields.driveBounds = bounds;
  } else {
    const pl = p.payload as ValueAnnotationPayload;
    const stamp = new Date(now).toISOString().slice(0, 10);
    const annotation = `[amendment ${stamp} · ${p.id.slice(0, 8)}] ${pl.text}`;
    fields.values = fields.values ? `${fields.values}\n${annotation}` : annotation;
  }

  // Invariant: this channel can never change red lines.
  if (JSON.stringify(fields.redLines ?? null) !== redLinesBefore) {
    throw new Error('constitution amendment attempted to modify red lines — refused');
  }

  pursuits.setConstitution(p.rootPursuitId, fields);
  const decided = store.decide(p.id, 'approved', now)!;

  auditHook?.append('self_domain_write', {
    source: 'constitution_amend',
    origin: 'Internal',
    toolName: 'constitution_amend',
    proposalId: p.id,
    kind: p.kind,
    // Post-amendment integrity hash — same chain constitution_load writes at startup.
    constitutionHash: pursuits.computeConstitutionHash(p.rootPursuitId),
    rationale: p.rationale,
  });
  return decided;
}
