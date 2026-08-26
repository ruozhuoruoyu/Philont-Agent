/**
 * Replaying a stored repair against the failure it was learned from.
 *
 * ## Why this is not the "draft replay queue" it started as
 *
 * The obvious reading of the frozen learning pool — forty untested draft skills, minting blocked,
 * nothing draining — is that the drafts need a harness that tries them. They do not have one thing a
 * harness needs: `SessionReflector.createSkill()` passes name/description/triggerKeywords/
 * actionTemplate/kind and nothing else, so `verification` and `toolPolicy` are null on every skill
 * reflection has ever minted. `isCallableRecipe` is false for all of them. A queue that runs a
 * recipe's verification would have had zero eligible inputs on day one, which is the shape of
 * mechanism this codebase keeps having to delete.
 *
 * The repair RULES are a different object and they do have both halves. `mechanical_fix` stores a
 * rule per failure signature, `attemptMechanicalRepair` is an executor that already re-authorizes and
 * charges its own tool call, and — since the ledger started recording the failing input alongside the
 * failure — every past failure is a fixture. So this replays those.
 *
 * ## Why the fixtures are safe to trust
 *
 * Only FAILED ledger rows are used. For a window this year the ledger recorded a repaired call as
 * `params: <the broken input>, success: true`, so historical SUCCESS rows can carry an input that
 * never worked. Failure rows were never mislabelled that way, and a failing input is the only thing a
 * replay wants anyway. That is a stronger guarantee than a date cutoff and it needs no constant.
 *
 * ## What it is for
 *
 * A rule learned once and never applied is indistinguishable from a rule that does not work. Waiting
 * for the signature to recur naturally can take days, and the recurrence itself is the cost we are
 * trying to remove. Replaying answers "does this rule fix the thing it was learned from?" now, and
 * writes the answer into the same applied/verified counters the live path uses.
 *
 * On by default; `PHILONT_REPAIR_REPLAY=0` disarms it. It spends an aux call and a tool run per candidate.
 */

import { classifyRepairTransition, type RepairTransition } from './in_turn_reflection.js';
import { attemptMechanicalRepair, type RepairStats } from './mechanical_repair.js';
import type { MechanicalFixStore } from './mechanical_fix_learning.js';
import { createHash } from 'node:crypto';

export const REPAIR_REPLAY_ATTEMPTS_NAMESPACE = 'repair_replay_attempts';
const RETRY_COOLDOWN_MS = 24 * 60 * 60_000;

export interface ReplayAttemptState {
  attempts: number;
  lastAttemptAt: number;
  lastReason?: string;
  permanent?: boolean;
}

export function replayFixtureKey(candidate: Pick<ReplayCandidate, 'signature' | 'toolName' | 'input'>): string {
  return createHash('sha256')
    .update(candidate.signature).update('\0').update(candidate.toolName).update('\0')
    .update(JSON.stringify(candidate.input))
    .digest('hex');
}

/**
 * Tools whose failures may be replayed unattended.
 *
 * A replay re-runs a rewritten input with no human watching, so the set is a deliberate allow-list,
 * not a heuristic: it must contain only tools whose effect is confined to producing an answer. It is
 * configuration rather than code so the framework itself stays free of tool knowledge.
 */
export const DEFAULT_REPLAY_TOOLS = 'pariGp,z3Verify,leanCheck';

export function replayEligibleTools(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = (env.PHILONT_REPAIR_REPLAY_TOOLS ?? DEFAULT_REPLAY_TOOLS).trim();
  return new Set(
    raw.split(',').map((t) => t.trim()).filter(Boolean),
  );
}

export function repairReplayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.PHILONT_REPAIR_REPLAY ?? '').trim());
}

/** One past failure, as the action ledger stored it. */
export interface LedgerFailure {
  toolName: string;
  /** The arguments that failed. */
  input: Record<string, unknown>;
  /** The error text, used to derive the signature and to prompt the rewrite. */
  errorText: string;
  recordedAt: number;
}

export interface ReplayCandidate extends LedgerFailure {
  signature: string;
}

export interface SelectReplayInput {
  failures: readonly LedgerFailure[];
  /** Signature for a (tool, error) pair — injected so this module never classifies anything itself. */
  signatureOf: (toolName: string, errorText: string) => string;
  /** Rules already known for a signature. No rule ⇒ nothing to replay; a replay must not guess. */
  rulesFor: (signature: string) => readonly string[];
  /** Repair counters for a signature. A rule with evidence is not the one worth spending a run on. */
  statsFor: (signature: string) => Pick<RepairStats, 'applied'>;
  eligibleTools: ReadonlySet<string>;
  attemptFor?: (candidate: ReplayCandidate) => ReplayAttemptState | null;
  now?: number;
  retryCooldownMs?: number;
  limit: number;
}

/**
 * Pick the untried rules worth one run each.
 *
 * Pure, and deliberately conservative in every direction: one candidate per signature (a second run
 * of the same rule tells us nothing new this tick), only signatures that already have a rule, only
 * rules with no application on record, and only tools on the allow-list.
 */
export function selectReplayCandidates(input: SelectReplayInput): ReplayCandidate[] {
  const seen = new Set<string>();
  const out: ReplayCandidate[] = [];
  // Newest first: the most recent shape of a failure is the one a rule has to handle now.
  const ordered = [...input.failures].sort((a, b) => b.recordedAt - a.recordedAt);
  for (const f of ordered) {
    if (out.length >= input.limit) break;
    if (!input.eligibleTools.has(f.toolName)) continue;
    if (!f.errorText.trim()) continue;
    if (!f.input || typeof f.input !== 'object' || Array.isArray(f.input)) continue;
    if (Object.keys(f.input).length === 0) continue;
    const signature = input.signatureOf(f.toolName, f.errorText);
    if (!signature || seen.has(signature)) continue;
    if (input.rulesFor(signature).length === 0) continue;
    if (input.statsFor(signature).applied > 0) continue;
    const candidate = { ...f, signature };
    const prior = input.attemptFor?.(candidate);
    if (prior?.permanent) continue;
    if (prior && (input.now ?? Date.now()) - prior.lastAttemptAt < (input.retryCooldownMs ?? RETRY_COOLDOWN_MS)) continue;
    seen.add(signature);
    out.push(candidate);
  }
  return out;
}

export type ReplaySkipReason = 'disabled' | 'no-candidates';

export interface ReplayOutcome {
  signature: string;
  transition: RepairTransition | 'not-attempted';
  reason?: string;
}

export interface RunReplayInput extends Omit<SelectReplayInput, 'limit'> {
  limit?: number;
  facts: MechanicalFixStore;
  /** Executes a tool through the caller's ALREADY-AUTHORIZED background runner. */
  runTool: (toolName: string, input: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>;
  /** The caller's authorization check for the rewritten arguments, same as the live repair path. */
  isSafeToRerun?: (toolName: string, input: Record<string, unknown>) => boolean | Promise<boolean>;
  onOutcome?: (outcome: ReplayOutcome) => void;
  /** Rewrite call, injected so a test never reaches the network and the caller keeps its own routing. */
  ask?: (req: { system: string; user: string; maxTokens: number; requireComplete: boolean }) => Promise<string | null>;
  configured?: boolean;
  env?: NodeJS.ProcessEnv;
  nowIso?: string;
}

function recordReplayAttempt(
  facts: MechanicalFixStore,
  candidate: ReplayCandidate,
  reason: string | undefined,
  now: number,
): void {
  const key = replayFixtureKey(candidate);
  const prior = facts.getFact(REPAIR_REPLAY_ATTEMPTS_NAMESPACE, key)?.value as Partial<ReplayAttemptState> | undefined;
  const permanent = reason === 'unsafe-to-rerun';
  facts.storeFact({
    namespace: REPAIR_REPLAY_ATTEMPTS_NAMESPACE,
    key,
    value: {
      attempts: Math.max(0, Number(prior?.attempts) || 0) + 1,
      lastAttemptAt: now,
      lastReason: reason,
      permanent,
    } satisfies ReplayAttemptState,
  });
}

/**
 * Replay up to `limit` untried rules. Total: any failure is reported through `onOutcome` and never
 * thrown, because this runs on an idle maintenance path that must not take the process with it.
 */
export async function runRepairReplay(
  input: RunReplayInput,
): Promise<{ attempted: number; outcomes: ReplayOutcome[]; skipped?: ReplaySkipReason }> {
  if (!repairReplayEnabled(input.env ?? process.env)) {
    return { attempted: 0, outcomes: [], skipped: 'disabled' };
  }
  const now = input.now ?? Date.now();
  const candidates = selectReplayCandidates({ ...input, now, limit: input.limit ?? 1 });
  if (candidates.length === 0) return { attempted: 0, outcomes: [], skipped: 'no-candidates' };

  const outcomes: ReplayOutcome[] = [];
  for (const c of candidates) {
    try {
      const result = await attemptMechanicalRepair({
        signature: c.signature,
        toolName: c.toolName,
        toolInput: c.input,
        errorText: c.errorText,
        rules: input.rulesFor(c.signature),
        facts: input.facts,
        isSafeToRerun: input.isSafeToRerun
          ? (rewritten) => input.isSafeToRerun!(c.toolName, rewritten)
          : undefined,
        run: (rewritten) => input.runTool(c.toolName, rewritten),
        classifyResult: (repaired) => classifyRepairTransition({
          beforeSignature: c.signature,
          afterSuccess: repaired.success,
          afterSignature: repaired.success
            ? undefined
            : input.signatureOf(c.toolName, repaired.error ?? repaired.output ?? ''),
        }),
        ask: input.ask,
        configured: input.configured,
        nowIso: input.nowIso,
        env: input.env,
      });
      if (!result.attempted || !result.result) {
        recordReplayAttempt(input.facts, c, result.reason, now);
        const outcome: ReplayOutcome = { signature: c.signature, transition: 'not-attempted', reason: result.reason };
        outcomes.push(outcome);
        input.onOutcome?.(outcome);
        continue;
      }
      const transition = classifyRepairTransition({
        beforeSignature: c.signature,
        afterSuccess: result.result.success,
        afterSignature: result.result.success
          ? undefined
          : input.signatureOf(c.toolName, result.result.error ?? result.result.output ?? ''),
      });
      const outcome: ReplayOutcome = { signature: c.signature, transition };
      outcomes.push(outcome);
      input.onOutcome?.(outcome);
    } catch (e) {
      recordReplayAttempt(input.facts, c, (e as Error)?.message ?? String(e), now);
      const outcome: ReplayOutcome = {
        signature: c.signature,
        transition: 'not-attempted',
        reason: (e as Error)?.message ?? String(e),
      };
      outcomes.push(outcome);
      input.onOutcome?.(outcome);
    }
  }
  return { attempted: outcomes.filter((o) => o.transition !== 'not-attempted').length, outcomes };
}
