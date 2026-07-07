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
  /** When this observation FIRST appeared (carried across re-upserts; resets when cleared). */
  sinceTs: number;
}

function upsert(
  deps: SelfObservationDeps,
  run: SelfObservationRun,
  key: string,
  content: string,
  sourceRefs: string[],
  now: number,
): void {
  // Persistence tracking (WS3 producer (b)): a tendency that KEEPS being observed is the signal
  // worth annotating the constitution with — carry the first-seen timestamp across upserts.
  const existing = deps.facts.getFact('self', key);
  const prevSince = (existing?.value as { sinceTs?: number } | undefined)?.sinceTs;
  const sinceTs = typeof prevSince === 'number' && prevSince > 0 ? prevSince : now;
  deps.facts.updateSelfFact(key, content, sourceRefs.slice(0, MAX_REFS), 'self-observation', {
    sinceTs,
  });
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
      now,
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
      now,
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
  const existing = facts.getFact('self', 'obs.recipe-decay');
  const prevSince = (existing?.value as { sinceTs?: number } | undefined)?.sinceTs;
  facts.updateSelfFact(
    'obs.recipe-decay',
    `My recipe "${skillName}" failed its own verification when I reused it — it has been ` +
      `demoted to an advisory lesson. I re-verify old recipes against current reality instead ` +
      `of trusting past success.`,
    [`skill:${skillId}`],
    'self-observation',
    { sinceTs: typeof prevSince === 'number' && prevSince > 0 ? prevSince : Date.now() },
  );
}

// ── WS3 producer (b): persistent tendencies -> constitution value-annotation proposals ──────

/**
 * How each durable tendency reads as a constitution VALUE annotation. Static, mechanical —
 * no LLM phrasing, so no fabrication surface. Only keys listed here can produce proposals.
 */
const VALUE_ANNOTATION_BY_OBS: Record<string, string> = {
  'obs.handoff-tendency':
    'Exhaust tool-reachable options before handing work back to the owner — my own ledger shows ' +
    'this needs standing reinforcement, not turn-by-turn correction.',
  'obs.repeated-failures':
    'When a failure signature repeats, change approach or consult the failure notes before ' +
    'retrying — repeated identical retries are my documented failure mode.',
  'obs.recipe-decay':
    'Re-verify a stored recipe against current reality before trusting it — my recipes have ' +
    'demonstrably decayed in reuse.',
};

const DEFAULT_PERSIST_MS = 14 * 86_400_000;

/**
 * WS3 producer (b): a self-observation that has PERSISTED for two weeks despite being visible in
 * every prompt is a standing conflict between behavior and the constitution's stated values —
 * propose annotating the values (owner ratifies; the proposal store dedups and suppresses
 * rejected content for 30d). Returns the proposal ids filed this run.
 */
export function proposeValueAnnotationsFromObservations(
  facts: MemoryStore,
  proposals: import('./constitution_proposals.js').ConstitutionProposalStore,
  rootPursuitId: string,
  now: number = Date.now(),
  persistMs: number = DEFAULT_PERSIST_MS,
): string[] {
  const filed: string[] = [];
  for (const obs of listSelfObservations(facts, 10)) {
    const text = VALUE_ANNOTATION_BY_OBS[obs.key];
    if (!text) continue;
    if (!(obs.sinceTs > 0) || now - obs.sinceTs < persistMs) continue;
    const fact = facts.getFact('self', obs.key);
    if (!fact) continue;
    const refs = (fact.value as { sourceRefs?: string[] }).sourceRefs ?? [];
    const p = proposals.propose(
      {
        rootPursuitId,
        kind: 'value_annotation',
        payload: { text },
        rationale:
          `the tendency "${obs.key}" has persisted for ` +
          `${Math.floor((now - obs.sinceTs) / 86_400_000)} days despite prompt-level visibility`,
        evidenceRefs: [`fact:${fact.id}`, ...refs.slice(0, 8)],
      },
      now,
    );
    if (p && p.createdAt === now) filed.push(p.id);
  }
  return filed;
}

/** Current (non-forgotten) obs.* observations, newest first, for prompt rendering. */
export function listSelfObservations(facts: MemoryStore, topK = 5): SelfObservation[] {
  const all = facts.listFacts('self');
  const out: SelfObservation[] = [];
  for (const f of all) {
    if (!f.key.startsWith('obs.')) continue;
    const v = f.value as { content?: string | string[]; updatedAt?: number; sinceTs?: number };
    const content = typeof v.content === 'string' ? v.content : null;
    if (!content) continue;
    out.push({
      key: f.key,
      content,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
      sinceTs: typeof v.sinceTs === 'number' ? v.sinceTs : 0,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, topK);
}
