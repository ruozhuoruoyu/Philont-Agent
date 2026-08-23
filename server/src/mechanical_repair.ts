/**
 * Mechanism-initiated repair of a recurring mechanical failure.
 *
 * ## Why this exists
 *
 * `mechanical_fix_learning` already closes the loop from "this error recurred" to "here is the rule
 * that fixed it": the floor requires a same-turn fail→succeed pair, a distiller states the rule, a
 * second call tries to knock it down, and what survives is stored per failure signature. That half
 * works. Production 2026-08-22 shows what the other half costs:
 *
 *   [mechanical-fix] rejected a proposed repair for pariGp:gp-other:
 *     "Define every brace-bodied helper at top level and never nest braces inside a GP script."
 *
 * Rejected as adding nothing — because the rule was ALREADY stored, already printed in the tool's own
 * error text, and already injected into the turn. And the same signature failed again 38 times that
 * week. Nothing was missing from the learning path. What was missing is that a learned rule was only
 * ever ADVICE: it reached the model's prompt, and the model was free to submit another broken variant.
 *
 * So this module changes the unit of learning, not the knowledge in it. A rule stops being a sentence
 * shown to the model and becomes an action the mechanism takes on its own: on a mechanical failure
 * whose signature already has a rule, rewrite the failing input under that rule and RE-RUN THE TOOL.
 * The tool is the verifier — no framework here knows what any tool's input means, and it must not, or
 * the next tool needs its own hand-written repairer and we are back to a patch stream.
 *
 * ## What makes it safe to run a rewritten input
 *
 *   - Only after a MECHANICAL failure (the caller's classifier), i.e. an authoring error whose recovery
 *     is fix-and-rerun by construction.
 *   - Only when a rule for that signature already exists. With no rule this would be a guess, and a
 *     guessing repairer is the thing that poisons a learning layer.
 *   - The rewrite may not introduce a key the original input did not have, may not change any key's
 *     type, and may not grow beyond a hard byte cap. A repair narrows a mistake; it does not acquire
 *     new arguments.
 *   - The caller supplies `isSafeToRerun` and wires it to the SAME authorization check the original
 *     call passed, applied to the REWRITTEN arguments and awaited before the tool runs. A rewrite is a
 *     different call than the one that was approved — a rewritten privileged command is not a repair,
 *     it is a new decision.
 *   - One attempt per signature per turn, decided by the caller's budget.
 *
 * ## What it measures
 *
 * Every application is counted against the rule that caused it: applied / verified / failed. That is
 * the effect signal the learning layer never had — `reflect.fire=753` and `routing_rule=800` are
 * production counters, not evidence that anything changed. A rule whose `verified` never moves is a
 * note; a rule whose `verified` climbs is muscle memory, and the difference is now visible.
 *
 * Default OFF (`PHILONT_MECHANICAL_REPAIR=1` to arm): it spends an aux call and a tool re-run on a
 * path that already had a working, if slower, recovery.
 */

import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';
import type { MechanicalFixStore } from './mechanical_fix_learning.js';

/** Facts namespace holding per-signature repair counters. Separate from the rules themselves so a
 * counter write can never corrupt the rule text. */
export const MECHANICAL_REPAIR_STATS_NAMESPACE = 'mechanical_fix_stats';

/** Hard ceiling on a rewritten input. A repair that doubles the payload is not a repair. */
export const MAX_REPAIRED_INPUT_BYTES = 64_000;

export interface RepairStats {
  /** Times a rewritten input was actually executed. */
  applied: number;
  /** Of those, times the tool then succeeded — the only evidence a rule changes behaviour. */
  verified: number;
  /** Of those, times the tool failed again. */
  failed: number;
  lastAppliedAt?: string;
  lastVerifiedAt?: string;
}

export const EMPTY_REPAIR_STATS: RepairStats = { applied: 0, verified: 0, failed: 0 };

export function mechanicalRepairEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PHILONT_MECHANICAL_REPAIR ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

/** Never throws: a missing or malformed counter must not stop a repair from being attempted. */
export function readRepairStats(signature: string, facts: MechanicalFixStore): RepairStats {
  if (!signature) return { ...EMPTY_REPAIR_STATS };
  try {
    const v = facts.getFact(MECHANICAL_REPAIR_STATS_NAMESPACE, signature)?.value as
      | Partial<RepairStats>
      | undefined;
    if (!v || typeof v !== 'object') return { ...EMPTY_REPAIR_STATS };
    const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
    return {
      applied: n(v.applied),
      verified: n(v.verified),
      failed: n(v.failed),
      lastAppliedAt: typeof v.lastAppliedAt === 'string' ? v.lastAppliedAt : undefined,
      lastVerifiedAt: typeof v.lastVerifiedAt === 'string' ? v.lastVerifiedAt : undefined,
    };
  } catch {
    return { ...EMPTY_REPAIR_STATS };
  }
}

/** Book one application against the rule that caused it. Returns the stats as written. */
export function recordRepairOutcome(
  signature: string,
  verified: boolean,
  facts: MechanicalFixStore,
  nowIso: string,
): RepairStats {
  const prior = readRepairStats(signature, facts);
  const next: RepairStats = {
    applied: prior.applied + 1,
    verified: prior.verified + (verified ? 1 : 0),
    failed: prior.failed + (verified ? 0 : 1),
    lastAppliedAt: nowIso,
    lastVerifiedAt: verified ? nowIso : prior.lastVerifiedAt,
  };
  try {
    facts.storeFact({ namespace: MECHANICAL_REPAIR_STATS_NAMESPACE, key: signature, value: next });
  } catch {
    /* the attempt still happened; losing the counter must not fail the turn */
  }
  return next;
}

/**
 * Which recurrence bucket a failure belongs in — or none, when nothing was known to recur against.
 *
 * The split is the whole point. `pariGp:gp-other ×38` mixed two different culprits into one number and
 * could therefore prove nothing: within a turn the model already has the error text in front of it and
 * submitted another variant anyway (a prompt-compliance problem); across turns the stored rule did not
 * survive the trip into the next prompt (a learning-layer problem).
 *
 * Takes no flag and no tool: this is measurement, and measurement that can be switched off with the
 * thing it measures leaves the before-period blank.
 */
export function classifyRecurrence(
  hasKnownRule: boolean,
  alreadyFailedThisTurn: boolean,
): 'intra_turn' | 'cross_turn' | null {
  if (!hasKnownRule) return null;
  return alreadyFailedThisTurn ? 'intra_turn' : 'cross_turn';
}

/** Metric key for a recurrence bucket, so the producer and the stats reader cannot drift apart. */
export function recurrenceMetricKey(bucket: 'intra_turn' | 'cross_turn'): string {
  return `learning.recurrence_after_rule.${bucket}`;
}

export function buildRepairPrompt(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  errorText: string;
  rules: readonly string[];
}): { system: string; user: string } {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  return {
    system:
      'A tool call failed with an authoring error. You are given the exact arguments that failed, the ' +
      'error, and the rules already known for this error. Apply the rules and output the CORRECTED ' +
      'ARGUMENTS.\n' +
      'Output a single JSON object and nothing else — no prose, no code fence, no explanation.\n' +
      'Hard constraints:\n' +
      '  - use exactly the same keys as the original arguments; never add a key;\n' +
      '  - change only what the error and the rules require; keep the intent of the call identical;\n' +
      '  - do not shrink the work being asked for to make it pass (no dropped cases, no smaller ' +
      'bounds, no stubbed-out body).\n' +
      'If the rules do not explain this error, or the arguments cannot be corrected without changing ' +
      'what is being computed, output exactly: NONE',
    user:
      `Tool: ${input.toolName}\n\n` +
      `--- rules already known for this error ---\n` +
      (input.rules.length ? input.rules.map((r) => `• ${r}`).join('\n') : '(none)') +
      `\n\n--- the error ---\n${clip(input.errorText, 800)}\n\n` +
      `--- arguments that FAILED (JSON) ---\n${clip(JSON.stringify(input.toolInput, null, 2), 4000)}\n`,
  };
}

/** Strip a ```json fence if the model wrapped the object despite being told not to. */
function unfence(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m ? m[1] : raw).trim();
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/**
 * Validate a proposed rewrite against the original arguments.
 *
 * The guards are deliberately about SHAPE, not meaning: nothing here knows what any tool's arguments
 * are for, and the moment it does, the next tool needs its own copy. A repair may only narrow — same
 * keys, same types, bounded size, and actually different from what failed.
 */
export function parseRepairedInput(
  raw: string | null | undefined,
  original: Record<string, unknown>,
): Record<string, unknown> | null {
  const text = unfence(raw ?? '');
  if (!text || /^NONE\b/i.test(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;

  for (const key of Object.keys(candidate)) {
    // A repair does not acquire arguments it was not given. This is what stops a rewrite from
    // reaching for a longer timeout, a different path, or any field the original call never carried.
    if (!(key in original)) return null;
    const before = original[key];
    const after = candidate[key];
    if (before === null || after === null) {
      if (before !== after && before !== undefined) return null;
      continue;
    }
    if (Array.isArray(before) !== Array.isArray(after)) return null;
    if (typeof before !== typeof after) return null;
  }
  if (stableStringify(candidate) === stableStringify(original)) return null; // "try the same thing again"
  if (JSON.stringify(candidate).length > MAX_REPAIRED_INPUT_BYTES) return null;
  return candidate;
}

export type RepairSkipReason =
  | 'disabled'
  | 'no-rule'
  | 'aux-unconfigured'
  | 'model-declined'
  | 'unsafe-to-rerun'
  | 'ask-failed';

export interface RepairOutcome {
  attempted: boolean;
  verified?: boolean;
  reason?: RepairSkipReason;
  /** The arguments that were run, when one was run. */
  repairedInput?: Record<string, unknown>;
  /** The tool's result for the re-run, when one was run. */
  result?: { success: boolean; output?: string; error?: string };
  stats?: RepairStats;
}

export interface AttemptRepairOptions {
  signature: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  errorText: string;
  /** Rules already known for this signature, from any source. Empty ⇒ nothing to apply, do not guess. */
  rules: readonly string[];
  facts: MechanicalFixStore;
  /** Re-runs the tool. The caller owns this so no gate is bypassed and no tool is named here. */
  run: (input: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>;
  /**
   * The caller's authorization check, applied to the REWRITTEN arguments and awaited before the tool
   * runs. A rewrite is a different call than the one that was approved, so it is decided again.
   */
  isSafeToRerun?: (input: Record<string, unknown>) => boolean | Promise<boolean>;
  ask?: (req: { system: string; user: string; maxTokens: number }) => Promise<string | null>;
  configured?: boolean;
  nowIso?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * One mechanism-initiated repair attempt. Total: every failure path returns `attempted: false` with a
 * reason, and the caller's original failure stands untouched.
 */
export async function attemptMechanicalRepair(opts: AttemptRepairOptions): Promise<RepairOutcome> {
  if (!mechanicalRepairEnabled(opts.env ?? process.env)) return { attempted: false, reason: 'disabled' };
  if (opts.rules.length === 0) return { attempted: false, reason: 'no-rule' };
  if (!(opts.configured ?? isAuxLLMConfigured())) return { attempted: false, reason: 'aux-unconfigured' };

  const ask = opts.ask ?? callAuxLLM;
  let repaired: Record<string, unknown> | null;
  try {
    const { system, user } = buildRepairPrompt({
      toolName: opts.toolName,
      toolInput: opts.toolInput,
      errorText: opts.errorText,
      rules: opts.rules,
    });
    repaired = parseRepairedInput(await ask({ system, user, maxTokens: 2000 }), opts.toolInput);
  } catch {
    return { attempted: false, reason: 'ask-failed' };
  }
  if (!repaired) return { attempted: false, reason: 'model-declined' };
  if (opts.isSafeToRerun && !(await opts.isSafeToRerun(repaired))) {
    return { attempted: false, reason: 'unsafe-to-rerun' };
  }

  const result = await opts.run(repaired);
  const stats = recordRepairOutcome(
    opts.signature,
    result.success,
    opts.facts,
    opts.nowIso ?? new Date().toISOString(),
  );
  return { attempted: true, verified: result.success, repairedInput: repaired, result, stats };
}

/**
 * What the model is told after the mechanism repaired its call for it.
 *
 * It has to be told. A silently corrected argument list teaches the model that its own version worked,
 * which is the opposite of the point — the next call would repeat the mistake and burn the repair
 * budget forever.
 */
export function renderRepairNotice(
  toolName: string,
  rules: readonly string[],
  verified: boolean,
): string {
  const rule = rules[rules.length - 1] ?? '';
  return verified
    ? `\n\n[auto-repair] This ${toolName} call failed with a known authoring error, so the arguments were ` +
        `corrected automatically and re-run — the result above is from the corrected call. ` +
        `Write it correctly yourself next time: ${rule}`
    : `\n\n[auto-repair] This ${toolName} call failed with a known authoring error. The known rule was ` +
        `applied automatically and it still failed, so the rule does not cover this case: ${rule}`;
}
