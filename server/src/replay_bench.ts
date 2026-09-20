/**
 * The sealed replay bench (2026-09-20).
 *
 * ## What was missing
 *
 * Every learned artifact philont produces is tested, if at all, against whatever the failure ledger
 * happens to hold in the last 14 days: `repair_replay.ts` replays untried rules against it, and
 * `draft_validation.ts` tries draft skills against it. That set changes every day, so no two runs
 * measure the same thing, and a rule that turned a failure green last month has nothing to be
 * checked against once that failure rolls off. There was no held-out set — which is the one
 * component every 2026 self-improvement result that held up had in common (RSEA's keep-better gate
 * on a disjoint split, SEAL's sealed exogenous audit, ModularRSI's benchmark-disjoint evolution set).
 *
 * ## What this is
 *
 * A fixed bank of past failures — FIXTURES — pinned from the ledger and kept until retired, with the
 * tool itself as the oracle: a fixture is green when the tool, given the input rewritten under the
 * current rules, succeeds. Sealed, in SEAL's sense: the agent never sees the bank (nothing here is
 * rendered into any prompt), and acceptance is mechanical (the tool's success flag), never a model's
 * opinion of its own work.
 *
 * Two uses:
 *   1. **Keep-better gate for learned repair lines.** A line distilled for a bench-eligible signature
 *      is a CANDIDATE until a bench run shows it turns the pinned fixture green where the accepted
 *      rules alone did not. A candidate that helps is promoted; one the accepted rules made redundant
 *      is dropped; one that fails twice is dropped. If the accepted set changes and a green fixture
 *      goes red, the newest accepted line is demoted back to candidate (keep-better in reverse).
 *   2. **A stable measurement.** How many fixtures are green, per signature, over time — the number
 *      "did learning help?" has never had.
 *
 * ## What it is not
 *
 * It exercises only tools on the replay allow-list (answer-producing, no side effects) — the same
 * boundary `repair_replay.ts` draws — so it gates executable learning (repair lines; draft recipes
 * through draft_validation), not prose (routing rules, playbooks): prose has no oracle, and this
 * module refuses to pretend otherwise.
 *
 * Pure selection, injected execution; nothing here reaches a model or a tool on its own.
 */

import { createHash } from 'node:crypto';
import { classifyRepairTransition, type RepairTransition } from './in_turn_reflection.js';
import { attemptMechanicalRepair } from './mechanical_repair.js';
import {
  demoteNewestAcceptedLine,
  dropCandidateLines,
  MECHANICAL_FIX_CANDIDATES_NAMESPACE,
  promoteCandidateLines,
  readCandidateLines,
  recordCandidateFailure,
  type MechanicalFixStore,
} from './mechanical_fix_learning.js';
import type { LedgerFailure } from './repair_replay.js';

export const REPLAY_BENCH_NAMESPACE = 'replay_bench_fixtures';

const DEFAULT_BENCH_SIZE = 50;
const DEFAULT_RUNS_PER_TICK = 2;
const DEFAULT_MIN_SESSIONS = 2;
const STALE_RUN_MS = 7 * 24 * 60 * 60_000;
const MAX_RUNS_KEPT = 20;
const MAX_ERROR_TEXT = 2000;
/** Bench runs in which candidates did not help before they are dropped. */
const CANDIDATE_FAILURE_LIMIT = 2;

export function replayBenchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.PHILONT_REPLAY_BENCH ?? '').trim());
}

export function replayBenchSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.PHILONT_REPLAY_BENCH_SIZE ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.max(5, Math.floor(n)) : DEFAULT_BENCH_SIZE;
}

export function replayBenchRunsPerTick(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PHILONT_REPLAY_BENCH_PER_TICK ?? '').trim();
  if (raw === '') return DEFAULT_RUNS_PER_TICK;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RUNS_PER_TICK;
}

export interface BenchRun {
  at: number;
  transition: RepairTransition | 'not-attempted';
  /** Hash of the rule set the run used — a changed set is a reason to run again. */
  rulesHash: string;
  /** Whether that rule set included candidate lines. */
  withCandidates: boolean;
  reason?: string;
}

export interface BenchFixture {
  id: string;
  signature: string;
  toolName: string;
  input: Record<string, unknown>;
  errorText: string;
  pinnedAt: number;
  sourceRecordedAt: number;
  /** Distinct sessions the signature was seen in when pinned (the cross-task vote). */
  sessions: number;
  status: 'active' | 'retired';
  retiredReason?: string;
  /** Newest last. */
  runs: BenchRun[];
}

/** The facts-store subset the bench needs. */
export interface BenchStore extends MechanicalFixStore {
  listFacts: (namespace: string) => Array<{ key: string; value: unknown }>;
}

/** A failure as the ledger recorded it, with the session it came from. */
export interface SessionLedgerFailure extends LedgerFailure {
  sessionId?: string;
}

export function fixtureId(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(toolName).update('\0').update(stableStringify(input)).digest('hex').slice(0, 32);
}

export function rulesHash(rules: readonly string[]): string {
  return createHash('sha256').update(rules.join('\n')).digest('hex').slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function isFixture(v: unknown): v is BenchFixture {
  if (!v || typeof v !== 'object') return false;
  const f = v as Partial<BenchFixture>;
  return typeof f.id === 'string' && typeof f.signature === 'string' && typeof f.toolName === 'string'
    && !!f.input && typeof f.input === 'object' && (f.status === 'active' || f.status === 'retired');
}

/** Every fixture in the store, malformed rows skipped. */
export function loadFixtures(store: Pick<BenchStore, 'listFacts'>): BenchFixture[] {
  try {
    return store.listFacts(REPLAY_BENCH_NAMESPACE)
      .map((r) => r.value)
      .filter(isFixture)
      .map((f) => ({ ...f, runs: Array.isArray(f.runs) ? f.runs : [] }));
  } catch {
    return [];
  }
}

export function saveFixture(store: Pick<BenchStore, 'storeFact'>, fixture: BenchFixture): void {
  store.storeFact({ namespace: REPLAY_BENCH_NAMESPACE, key: fixture.id, value: fixture });
}

export interface SelectPinInput {
  failures: readonly SessionLedgerFailure[];
  existing: readonly BenchFixture[];
  signatureOf: (toolName: string, errorText: string) => string;
  /** Accepted rules for a signature; a signature with a rule is what that rule was learned from. */
  rulesFor: (signature: string) => readonly string[];
  eligibleTools: ReadonlySet<string>;
  capacity: number;
  /** Distinct sessions a signature must have been seen in to be pinned without a rule. */
  minSessions?: number;
}

export interface PinCandidate {
  failure: SessionLedgerFailure;
  signature: string;
  sessions: number;
}

/**
 * Which ledger failures deserve a permanent seat on the bench.
 *
 * One fixture per signature (the bench measures breadth of failure classes, not one class many
 * times); a signature qualifies when it was seen in at least `minSessions` distinct sessions — the
 * cross-task support ModularRSI votes on — or when a rule already exists for it (the rule's own
 * fixture). Newest failure of each qualifying signature, most-supported first. Pinned fixtures are
 * never displaced: a full bench pins nothing new until something is retired.
 */
export function selectFixturesToPin(input: SelectPinInput): PinCandidate[] {
  const minSessions = input.minSessions ?? DEFAULT_MIN_SESSIONS;
  const room = input.capacity - input.existing.filter((f) => f.status === 'active').length;
  if (room <= 0) return [];
  const pinnedSignatures = new Set(input.existing.filter((f) => f.status === 'active').map((f) => f.signature));
  const pinnedIds = new Set(input.existing.map((f) => f.id));

  const bySignature = new Map<string, { newest: SessionLedgerFailure; sessions: Set<string> }>();
  for (const f of input.failures) {
    if (!input.eligibleTools.has(f.toolName)) continue;
    if (!f.errorText?.trim()) continue;
    if (!f.input || typeof f.input !== 'object' || Array.isArray(f.input) || Object.keys(f.input).length === 0) continue;
    const signature = input.signatureOf(f.toolName, f.errorText);
    if (!signature || pinnedSignatures.has(signature)) continue;
    const cur = bySignature.get(signature);
    if (!cur) {
      bySignature.set(signature, { newest: f, sessions: new Set(f.sessionId ? [f.sessionId] : []) });
    } else {
      if (f.sessionId) cur.sessions.add(f.sessionId);
      if (f.recordedAt > cur.newest.recordedAt) cur.newest = f;
    }
  }

  const out: PinCandidate[] = [];
  for (const [signature, agg] of bySignature) {
    const sessions = agg.sessions.size;
    const hasRule = input.rulesFor(signature).length > 0;
    if (sessions < minSessions && !hasRule) continue;
    if (pinnedIds.has(fixtureId(agg.newest.toolName, agg.newest.input))) continue;
    out.push({ failure: agg.newest, signature, sessions });
  }
  out.sort((a, b) => b.sessions - a.sessions || b.failure.recordedAt - a.failure.recordedAt);
  return out.slice(0, room);
}

export function pinFixture(store: Pick<BenchStore, 'storeFact'>, c: PinCandidate, now = Date.now()): BenchFixture {
  const fixture: BenchFixture = {
    id: fixtureId(c.failure.toolName, c.failure.input),
    signature: c.signature,
    toolName: c.failure.toolName,
    input: c.failure.input,
    errorText: c.failure.errorText.slice(0, MAX_ERROR_TEXT),
    pinnedAt: now,
    sourceRecordedAt: c.failure.recordedAt,
    sessions: c.sessions,
    status: 'active',
    runs: [],
  };
  saveFixture(store, fixture);
  return fixture;
}

export interface SelectRunInput {
  fixtures: readonly BenchFixture[];
  /** Accepted rules (hand-written + learned) for a signature. */
  rulesFor: (signature: string) => readonly string[];
  /** Candidate lines waiting for the bench. */
  candidatesFor: (signature: string) => readonly string[];
  now: number;
  limit: number;
  staleMs?: number;
}

export interface RunPlan {
  fixture: BenchFixture;
  /** The rule set this run will use. */
  rules: string[];
  withCandidates: boolean;
  why: 'never-run' | 'baseline-for-candidates' | 'candidates' | 'rules-changed' | 'stale';
}

function lastRun(f: BenchFixture): BenchRun | undefined {
  return f.runs.length > 0 ? f.runs[f.runs.length - 1] : undefined;
}

/**
 * Which fixtures to spend a run on this tick, and with which rules.
 *
 * A fixture with candidates needs a BASELINE first — the accepted rules alone, so a candidate can only
 * be credited for a change it caused — then the candidate run. Otherwise: never run, rule set changed
 * since the last run, or stale. Nothing without any rule at all: the executor would only decline.
 */
export function selectFixturesToRun(input: SelectRunInput): RunPlan[] {
  const staleMs = input.staleMs ?? STALE_RUN_MS;
  const plans: Array<RunPlan & { rank: number }> = [];
  for (const f of input.fixtures) {
    if (f.status !== 'active') continue;
    const accepted = [...input.rulesFor(f.signature)];
    const candidates = [...input.candidatesFor(f.signature)];
    if (accepted.length === 0 && candidates.length === 0) continue;
    const last = lastRun(f);
    if (candidates.length > 0) {
      const baselineHash = rulesHash(accepted);
      const hasBaseline = accepted.length === 0 || f.runs.some((r) => r.rulesHash === baselineHash && !r.withCandidates);
      if (!hasBaseline) {
        plans.push({ fixture: f, rules: accepted, withCandidates: false, why: 'baseline-for-candidates', rank: 0 });
        continue;
      }
      const candidateHash = rulesHash([...accepted, ...candidates]);
      if (!f.runs.some((r) => r.rulesHash === candidateHash && r.withCandidates)) {
        plans.push({ fixture: f, rules: [...accepted, ...candidates], withCandidates: true, why: 'candidates', rank: 1 });
      }
      continue;
    }
    if (!last) {
      plans.push({ fixture: f, rules: accepted, withCandidates: false, why: 'never-run', rank: 0 });
    } else if (last.rulesHash !== rulesHash(accepted)) {
      plans.push({ fixture: f, rules: accepted, withCandidates: false, why: 'rules-changed', rank: 2 });
    } else if (input.now - last.at > staleMs) {
      plans.push({ fixture: f, rules: accepted, withCandidates: false, why: 'stale', rank: 3 });
    }
  }
  plans.sort((a, b) => a.rank - b.rank || (lastRun(a.fixture)?.at ?? 0) - (lastRun(b.fixture)?.at ?? 0));
  return plans.slice(0, Math.max(0, input.limit)).map(({ rank: _rank, ...p }) => p);
}

export type BenchDecision =
  | 'promoted'
  | 'dropped-redundant'
  | 'dropped-failed'
  | 'candidate-failed'
  | 'regression-demoted'
  | 'regression'
  | 'none';

export interface BenchOutcome {
  fixtureId: string;
  signature: string;
  why: RunPlan['why'];
  transition: RepairTransition | 'not-attempted';
  reason?: string;
  decision: BenchDecision;
  /** Lines moved by the decision, when any. */
  lines?: string[];
}

export interface RunBenchInput {
  store: BenchStore;
  fixtures?: readonly BenchFixture[];
  signatureOf: (toolName: string, errorText: string) => string;
  rulesFor: (signature: string) => readonly string[];
  runTool: (toolName: string, input: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>;
  isSafeToRerun?: (toolName: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  ask?: (req: { system: string; user: string; maxTokens: number; requireComplete: boolean }) => Promise<string | null>;
  configured?: boolean;
  onOutcome?: (outcome: BenchOutcome) => void;
  limit?: number;
  now?: number;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
}

function wasGreen(f: BenchFixture): boolean {
  return f.runs.some((r) => r.transition === 'verified');
}

/**
 * Decide what a run means for the rule ledger. Pure over the fixture's history and the run.
 */
export function decideAfterRun(
  fixture: BenchFixture,
  plan: Pick<RunPlan, 'withCandidates' | 'rules'>,
  transition: BenchRun['transition'],
  acceptedHash: string,
  candidateFailures: number,
): BenchDecision {
  if (transition === 'not-attempted' || transition === 'inconclusive') return 'none';
  if (plan.withCandidates) {
    const baselineGreen = fixture.runs.some((r) => !r.withCandidates && r.rulesHash === acceptedHash && r.transition === 'verified');
    if (transition === 'verified') return baselineGreen ? 'dropped-redundant' : 'promoted';
    return candidateFailures + 1 >= CANDIDATE_FAILURE_LIMIT ? 'dropped-failed' : 'candidate-failed';
  }
  if (transition !== 'verified' && wasGreen(fixture)) {
    // Green before, red now. If the accepted set is not the one that was green, the change is the suspect.
    const greenHashes = new Set(fixture.runs.filter((r) => r.transition === 'verified' && !r.withCandidates).map((r) => r.rulesHash));
    return greenHashes.has(acceptedHash) ? 'regression' : 'regression-demoted';
  }
  return 'none';
}

/**
 * Run up to `limit` planned fixtures and apply the keep-better decisions. Never throws: this runs on
 * the idle maintenance path.
 */
export async function runReplayBench(input: RunBenchInput): Promise<{ attempted: number; outcomes: BenchOutcome[] }> {
  const now = input.now ?? Date.now();
  const fixtures = input.fixtures ?? loadFixtures(input.store);
  const plans = selectFixturesToRun({
    fixtures,
    rulesFor: input.rulesFor,
    candidatesFor: (sig) => readCandidateLines(sig, input.store).lines,
    now,
    limit: input.limit ?? DEFAULT_RUNS_PER_TICK,
  });
  const outcomes: BenchOutcome[] = [];
  for (const plan of plans) {
    const f = plan.fixture;
    const hash = rulesHash(plan.rules);
    let transition: BenchRun['transition'] = 'not-attempted';
    let reason: string | undefined;
    try {
      const result = await attemptMechanicalRepair({
        signature: f.signature,
        toolName: f.toolName,
        toolInput: f.input,
        errorText: f.errorText,
        rules: plan.rules,
        facts: input.store,
        isSafeToRerun: input.isSafeToRerun ? (rw) => input.isSafeToRerun!(f.toolName, rw) : undefined,
        run: (rw) => input.runTool(f.toolName, rw),
        classifyResult: (r) => classifyRepairTransition({
          beforeSignature: f.signature,
          afterSuccess: r.success,
          afterSignature: r.success ? undefined : input.signatureOf(f.toolName, r.error ?? r.output ?? ''),
        }),
        ask: input.ask,
        configured: input.configured,
        nowIso: input.nowIso,
        env: input.env,
      });
      if (result.attempted && result.result) {
        transition = classifyRepairTransition({
          beforeSignature: f.signature,
          afterSuccess: result.result.success,
          afterSignature: result.result.success ? undefined : input.signatureOf(f.toolName, result.result.error ?? result.result.output ?? ''),
        });
      } else {
        reason = result.reason;
      }
    } catch (e) {
      reason = (e as Error)?.message ?? String(e);
    }

    const acceptedHash = rulesHash([...input.rulesFor(f.signature)]);
    const candidateFailures = readCandidateLines(f.signature, input.store).failures;
    const decision = decideAfterRun(f, plan, transition, acceptedHash, candidateFailures);
    let lines: string[] | undefined;
    try {
      switch (decision) {
        case 'promoted': lines = promoteCandidateLines(f.signature, input.store, now); break;
        case 'dropped-redundant': lines = dropCandidateLines(f.signature, input.store, now); break;
        case 'dropped-failed': lines = dropCandidateLines(f.signature, input.store, now); break;
        case 'candidate-failed': recordCandidateFailure(f.signature, input.store, now); break;
        case 'regression-demoted': { const l = demoteNewestAcceptedLine(f.signature, input.store, now); lines = l ? [l] : []; break; }
        default: break;
      }
    } catch { /* a ledger write must not stop the bench */ }

    const run: BenchRun = { at: now, transition, rulesHash: hash, withCandidates: plan.withCandidates, reason };
    const updated: BenchFixture = { ...f, runs: [...f.runs, run].slice(-MAX_RUNS_KEPT) };
    if (reason === 'unsafe-to-rerun') {
      updated.status = 'retired';
      updated.retiredReason = 'unsafe-to-rerun';
    }
    try { saveFixture(input.store, updated); } catch { /* same */ }

    const outcome: BenchOutcome = { fixtureId: f.id, signature: f.signature, why: plan.why, transition, reason, decision, lines };
    outcomes.push(outcome);
    input.onOutcome?.(outcome);
  }
  return { attempted: outcomes.filter((o) => o.transition !== 'not-attempted').length, outcomes };
}

/**
 * The active bench as ledger rows, so anything that consumes ledger failures (draft validation) can be
 * pointed at the fixed bank first and the rolling ledger second. `extra` rows whose (tool, input)
 * already sit on the bench are dropped, so a fixture is never tried twice under two names.
 */
export function fixturesAsLedger(
  fixtures: readonly BenchFixture[],
  extra: readonly LedgerFailure[] = [],
): LedgerFailure[] {
  const out: LedgerFailure[] = [];
  const seen = new Set<string>();
  for (const f of fixtures) {
    if (f.status !== 'active') continue;
    seen.add(f.id);
    out.push({ toolName: f.toolName, input: f.input, errorText: f.errorText, recordedAt: f.sourceRecordedAt });
  }
  for (const r of extra) {
    if (!r.input || typeof r.input !== 'object' || Array.isArray(r.input)) continue;
    const id = fixtureId(r.toolName, r.input);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

export interface BenchSummary {
  active: number;
  retired: number;
  neverRun: number;
  green: number;
  red: number;
  /** Signatures with candidate lines still waiting for a verdict. */
  pendingCandidates: number;
}

/** The one number the learning report needs: how much of the bench is green under the current rules. */
export function summarizeBench(store: BenchStore): BenchSummary {
  const fixtures = loadFixtures(store);
  const s: BenchSummary = { active: 0, retired: 0, neverRun: 0, green: 0, red: 0, pendingCandidates: 0 };
  for (const f of fixtures) {
    if (f.status === 'retired') { s.retired++; continue; }
    s.active++;
    const last = [...f.runs].reverse().find((r) => r.transition !== 'not-attempted' && !r.withCandidates);
    if (!last) s.neverRun++;
    else if (last.transition === 'verified') s.green++;
    else s.red++;
  }
  try {
    s.pendingCandidates = store.listFacts(MECHANICAL_FIX_CANDIDATES_NAMESPACE).filter((r) => {
      const v = r.value as { lines?: unknown } | null;
      return Array.isArray(v?.lines) && v!.lines.length > 0;
    }).length;
  } catch { /* report what we have */ }
  return s;
}
