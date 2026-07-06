/**
 * SelfObservationWriter (WS4, docs/design/selfhood_closure.md).
 *
 * The complement to K3's SelfReflector: where K3 synthesizes an LLM-phrased self-DESCRIPTION
 * ("what I have become"), this writer records behavioral TENDENCIES ("how I actually behave") —
 * and v1 is pure aggregation over persisted records, ZERO LLM calls, so there is no fabrication
 * surface at all. Every observation is a `self` fact under an `obs.*` key whose sourceRefs point
 * at the real rows that evidence it; updateSelfFact rejects an obs.* write with empty refs.
 *
 * Observations (each written only when its evidence threshold is met, and CLEARED — soft-forget —
 * when the evidence recedes, so a stale tendency does not haunt the prompt):
 *   obs.repeated-failures  — same failure signature recurring across recent tool calls
 *   obs.handoff-tendency   — the task-commitment kernel drive repeatedly having to intervene
 *   obs.recipe-decay       — recipes failing their own verification on reuse (fed by WS5)
 *
 * Consumers: the system-prefix section "What I know about my own tendencies" (chat-handler),
 * rendered from listSelfObservations().
 */

import type { MemoryStore } from './store.js';
import type { ActionLog } from './actions.js';
import type { DriveOutcomeStore } from './drive_outcome.js';
import { extractFailureSignature, groupFailures } from './failure_signatures.js';

const WINDOW_MS = 7 * 86_400_000;
const REPEATED_FAILURE_MIN = 3;
const HANDOFF_MIN = 2;
const MAX_REFS = 10;

export interface SelfObservationDeps {
  facts: MemoryStore;
  actions: ActionLog;
  driveOutcomes: DriveOutcomeStore;
  /** driveId of the kernel task-commitment drive as registered by the server. */
  taskCommitmentDriveId?: string;
}

export interface SelfObservationRun {
  /** obs.* keys written/refreshed this run */
  written: string[];
  /** obs.* keys cleared (evidence receded) */
  cleared: string[];
}

export interface SelfObservation {
  key: string;
  content: string;
  updatedAt: number;
}

function upsert(
  deps: SelfObservationDeps,
  run: SelfObservationRun,
  key: string,
  content: string,
  sourceRefs: string[],
): void {
  deps.facts.updateSelfFact(key, content, sourceRefs.slice(0, MAX_REFS), 'self-observation');
  run.written.push(key);
}

function clear(deps: SelfObservationDeps, run: SelfObservationRun, key: string): void {
  const existing = deps.facts.getFact('self', key);
  if (existing) {
    deps.facts.softForget(existing.id);
    run.cleared.push(key);
  }
}

/**
 * Aggregate the ledger into obs.* self facts. Pure counters — safe to run every idle
 * consolidation pass; each key is upserted (same key overwrites) or cleared.
 */
export function runSelfObservations(
  deps: SelfObservationDeps,
  now: number = Date.now(),
): SelfObservationRun {
  const run: SelfObservationRun = { written: [], cleared: [] };

  // ── obs.repeated-failures ─────────────────────────────────────────────────
  const failures = deps.actions.listRecentFailures({ sinceTs: now - WINDOW_MS, limit: 100 });
  const groups = groupFailures(failures);
  const top = groups[0];
  if (top && top.count >= REPEATED_FAILURE_MIN) {
    const refs = failures
      .filter((f) => extractFailureSignature(f.toolName, f.result) === top.signature)
      .map((f) => `action:${f.id}`);
    upsert(
      deps,
      run,
      'obs.repeated-failures',
      `In the past 7 days, ${top.count} of my tool calls failed with the same signature ` +
        `"${top.signature}" (tool: ${top.toolName}). When I hit this again, I change approach ` +
        `or consult the failure notes instead of retrying the same call.`,
      refs,
    );
  } else {
    clear(deps, run, 'obs.repeated-failures');
  }

  // ── obs.handoff-tendency ──────────────────────────────────────────────────
  const driveId = deps.taskCommitmentDriveId ?? 'task-commitment';
  const interventions = deps.driveOutcomes
    .listByDrive(driveId, 50)
    .filter((o) => o.firedAt >= now - WINDOW_MS);
  if (interventions.length >= HANDOFF_MIN) {
    upsert(
      deps,
      run,
      'obs.handoff-tendency',
      `My task-commitment drive had to intervene ${interventions.length} times in the past ` +
        `7 days — I tend to hand work back to the user too early. I exhaust tool-reachable ` +
        `options before asking the user to do anything themselves.`,
      interventions.map((o) => `drive-outcome:${o.id}`),
    );
  } else {
    clear(deps, run, 'obs.handoff-tendency');
  }

  return run;
}

/**
 * Record a recipe that failed its own verification on reuse (WS5 calls this at demotion time).
 * Kept here so the evidence rule (refs mandatory) is enforced in one place.
 */
export function recordRecipeDecayObservation(
  facts: MemoryStore,
  skillName: string,
  skillId: string,
): void {
  facts.updateSelfFact(
    'obs.recipe-decay',
    `My recipe "${skillName}" failed its own verification when I reused it — it has been ` +
      `demoted to an advisory lesson. I re-verify old recipes against current reality instead ` +
      `of trusting past success.`,
    [`skill:${skillId}`],
    'self-observation',
  );
}

/** Current (non-forgotten) obs.* observations, newest first, for prompt rendering. */
export function listSelfObservations(facts: MemoryStore, topK = 5): SelfObservation[] {
  const all = facts.listFacts('self');
  const out: SelfObservation[] = [];
  for (const f of all) {
    if (!f.key.startsWith('obs.')) continue;
    const v = f.value as { content?: string | string[]; updatedAt?: number };
    const content = typeof v.content === 'string' ? v.content : null;
    if (!content) continue;
    out.push({ key: f.key, content, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, topK);
}
