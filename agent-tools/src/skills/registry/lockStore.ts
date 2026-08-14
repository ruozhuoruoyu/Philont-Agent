/**
 * Provenance / lock store for marketplace-installed skills.
 *
 * Lives as a side-file, NOT in the SkillStore DB, because:
 *   - agent-tools must stay free of an agent-memory dependency (acyclic package graph — the same
 *     discipline installTool.ts follows).
 *   - the DB is rebuilt from disk on every reload; provenance (hash / trust / verdict / who-confirmed)
 *     must survive that. The DB row already carries `source` (enough for prune); the lock file holds
 *     the richer audit fields.
 *
 * Files (under <cwd>/.philont/):
 *   - skills.lock.json   : { [skillName]: ProvenanceRecord }   (atomic write via tmp+rename)
 *   - skills-audit.log   : JSONL, append-only install/uninstall events
 *
 * Stale entries (skill dir manually removed) are harmless: the server's /installed merge keys off the
 * live SkillStore, so an orphan lock row simply never matches a loaded skill.
 */

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvenanceRecord } from './types.js';

function philontDir(): string {
  return join(process.cwd(), '.philont');
}
function lockPath(): string {
  return join(philontDir(), 'skills.lock.json');
}
function auditPath(): string {
  return join(philontDir(), 'skills-audit.log');
}

/** Read the full provenance map. Returns {} if the file is absent or malformed. */
export function readLock(): Record<string, ProvenanceRecord> {
  try {
    const raw = readFileSync(lockPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ProvenanceRecord>) : {};
  } catch {
    return {};
  }
}

/** Look up one record by skill name. */
export function getProvenance(name: string): ProvenanceRecord | null {
  return readLock()[name] ?? null;
}

function writeLock(map: Record<string, ProvenanceRecord>): void {
  mkdirSync(philontDir(), { recursive: true });
  const tmp = lockPath() + `.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf-8');
  renameSync(tmp, lockPath());
}

/** Insert or replace a provenance record. */
export function upsertLock(rec: ProvenanceRecord): void {
  const map = readLock();
  map[rec.name] = rec;
  writeLock(map);
}

/** Remove a provenance record (no-op if absent). */
export function removeLock(name: string): void {
  const map = readLock();
  if (name in map) {
    delete map[name];
    writeLock(map);
  }
}

export interface AuditEvent {
  ts: string;
  action:
    | 'install'
    | 'update'
    | 'uninstall'
    | 'blocked'
    /** A user knowingly installed past a `block` verdict. */
    | 'override_install'
    /** An override was requested but not honoured (agent-initiated overrides are never honoured). */
    | 'override_refused';
  name: string;
  sourceTag?: string;
  verdict?: string;
  decision?: string;
  actor?: string;
}

/** Append a JSONL audit line. Best-effort: never throws. */
export function appendAudit(event: AuditEvent): void {
  try {
    mkdirSync(philontDir(), { recursive: true });
    appendFileSync(auditPath(), JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    /* audit is advisory; ignore write failures */
  }
}
