/**
 * Learning the repair for a recurring mechanical error.
 *
 * ## What the 7-day numbers said
 *
 *   reflect.new_skill = 0        (in a week of reflections)
 *   top failure signature: pariGp:gp-syntax  ×71
 *
 * The obvious reading is that skill distillation is broken, and there IS a rule that forbids it on
 * degraded turns (applyReflection, 2026-05-15). But that rule is not what is binding here, and saying so
 * matters, because "unblock new_skill" would have shipped a mechanism that produces nothing.
 *
 * The model is right not to emit new_skill for a gp syntax error. Read what the reflection prompt asks
 * for: new_skill is "solidify the complete steps discovered this time into a SKILL.md template", for when
 * you "proved out a new workflow (registration / onboarding / report generation)". An unbalanced paren in
 * a gp script is not a workflow. None of the five learning types can carry "when signature S happens, do
 * THIS specific repair" — routing_rule's carveout is an avoidance clause, playbook is an abstract
 * principle, skill_refine annotates a skill that does not exist for this. So 71 recurrences produced 71
 * ways to say "avoid it" and not one repair.
 *
 * The repair knowledge does exist in this codebase — as `authoringCheatsheet()`, a table I hand-wrote in
 * in_turn_reflection.ts on 2026-06-22 after watching the same PARI/GP mistakes for hours. Hand-written is
 * the whole problem: the cheatsheet only ever knows the mistakes someone already sat and watched.
 *
 * ## The shape of the fix
 *
 * The gap is not a missing learning type in the reflection JSON. It is that the loop from "this error
 * recurred" to "here is what fixed it" was never closed, so this closes exactly that loop and nothing
 * else. Learned lines land in the same `authoringCheatsheet` the reminder already prints.
 *
 * FLOOR (deterministic, runtime ground truth — no model involved):
 *   distillation requires that within ONE turn the same tool FAILED with signature S and then SUCCEEDED.
 *   That is the recovery evidence. Without it we would be recording a guess at a fix that was never seen
 *   to work — the precise way a learning layer poisons itself, and worse than learning nothing, because a
 *   wrong cheatsheet line is injected into every future turn that hits S.
 *
 * CEILING (one narrow aux question, inside the window the floor opened):
 *   given the script that failed, the error, and the script that then worked, state the rule in one line.
 *   The model is never asked whether a fix happened — the trace already settled that.
 *
 * Every failure path (aux unconfigured, error, unparseable, over-long) returns null and stores nothing.
 * PHILONT_MECHANICAL_FIX_LEARNING=0 disables the whole thing.
 */

import { extractFailureSignature } from '@agent/memory';
import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';

/** Facts namespace holding the learned lines, keyed by failure signature. */
export const MECHANICAL_FIX_NAMESPACE = 'mechanical_fix';

/** Tools whose every error is a script bug with a mechanical repair (mirrors isMechanicalFailure). */
const AUTHORED_SCRIPT_TOOLS = new Set(['pariGp', 'z3Verify', 'leanCheck']);

/** One tool_result as extractRecentToolResults() yields it. */
export interface ToolResultRecord {
  toolName: string;
  content: string;
  toolInput?: Record<string, unknown>;
}

export interface MechanicalRecovery {
  signature: string;
  toolName: string;
  /** The script that produced the error. */
  failedSource: string;
  /** The error text, as the tool reported it. */
  errorText: string;
  /** The script that ran clean afterwards. */
  workingSource: string;
}

/** Best-effort read of the script out of a compute tool's input (they differ in field name). */
function sourceOf(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const k of ['code', 'script', 'source', 'input', 'query', 'program']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

const isFailure = (content: string): boolean => content.startsWith('⚠');

/**
 * Find a failure that the SAME turn went on to repair.
 *
 * Deterministic and total: reads only the tool ledger. Returns null when nothing in this turn both
 * failed and then succeeded — which is the common case, and is exactly when there is nothing to learn.
 */
export function findMechanicalRecovery(results: ToolResultRecord[]): MechanicalRecovery | null {
  for (let i = 0; i < results.length; i++) {
    const fail = results[i];
    if (!AUTHORED_SCRIPT_TOOLS.has(fail.toolName)) continue;
    if (!isFailure(fail.content)) continue;
    const failedSource = sourceOf(fail.toolInput);
    if (!failedSource) continue;

    // the first later success by the same tool is the repaired script
    for (let j = i + 1; j < results.length; j++) {
      const ok = results[j];
      if (ok.toolName !== fail.toolName) continue;
      if (isFailure(ok.content)) continue;
      const workingSource = sourceOf(ok.toolInput);
      if (!workingSource) continue;
      // An identical script that failed and then passed is a flake or a resource limit, not a repair —
      // there is no rule to extract from it, and "do the same thing again" is the worst cheatsheet line
      // imaginable.
      if (workingSource.trim() === failedSource.trim()) continue;
      return {
        signature: extractFailureSignature(fail.toolName, fail.content),
        toolName: fail.toolName,
        failedSource,
        errorText: fail.content,
        workingSource,
      };
    }
  }
  return null;
}

export function buildMechanicalFixPrompt(r: MechanicalRecovery): { system: string; user: string } {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  return {
    system:
      'You write one line for an authoring cheatsheet. The agent wrote a script, it errored, the agent ' +
      'fixed it, and the fix worked. Say what the RULE is, so the same mistake is not made again.\n' +
      'Output ONE imperative sentence, under 160 characters, naming the concrete construct — not ' +
      '"be careful with syntax". No preamble, no quotes, no bullet marker.\n' +
      'If the two scripts differ only in the problem being solved (different maths, different bounds) ' +
      'and there is no reusable authoring rule, output exactly: NONE',
    user:
      `Tool: ${r.toolName}\n\n` +
      `--- script that FAILED ---\n${clip(r.failedSource, 1500)}\n\n` +
      `--- the error ---\n${clip(r.errorText, 800)}\n\n` +
      `--- script that then WORKED ---\n${clip(r.workingSource, 1500)}\n`,
  };
}

/** Accepts one short imperative line, or nothing. Our own NONE sentinel is exact-matched. */
export function parseMechanicalFix(raw: string | null | undefined): string | null {
  const line = (raw ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (/^NONE\b/i.test(line)) return null;
  const cleaned = line.replace(/^[-•*]\s*/, '').replace(/^["'「『]|["'」』]$/g, '').trim();
  if (cleaned.length < 12) return null; // "fix the syntax" teaches nothing
  if (cleaned.length > 200) return null; // a paragraph is not a cheatsheet line
  return cleaned;
}

export function mechanicalFixLearningEnabled(): boolean {
  return process.env.PHILONT_MECHANICAL_FIX_LEARNING !== '0';
}

export interface MechanicalFixStore {
  getFact: (namespace: string, key: string) => { value: unknown } | null;
  storeFact: (input: { namespace: string; key: string; value: unknown }) => unknown;
}

/** The learned lines for a signature, newest last. Never throws. */
export function learnedCheatsheet(signature: string, facts: MechanicalFixStore): string[] {
  if (!signature || !mechanicalFixLearningEnabled()) return [];
  try {
    const fact = facts.getFact(MECHANICAL_FIX_NAMESPACE, signature);
    const v = fact?.value;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return typeof v === 'string' && v.trim() ? [v] : [];
  } catch {
    return [];
  }
}

/** How many learned lines one signature may accumulate before the oldest is dropped. */
const MAX_LINES_PER_SIGNATURE = 6;

/**
 * Distil and store the repair, if this turn actually contains one. Returns the line it learned, or null.
 *
 * Called at turn close. Safe to call on every turn: the floor rejects turns with no recovery in them,
 * which is nearly all of them, before any model is consulted.
 */
export async function distillMechanicalFix(
  results: ToolResultRecord[],
  facts: MechanicalFixStore,
  deps: {
    ask?: (req: { system: string; user: string; maxTokens: number }) => Promise<string | null>;
    configured?: boolean;
  } = {},
): Promise<{ signature: string; line: string } | null> {
  if (!mechanicalFixLearningEnabled()) return null;
  const recovery = findMechanicalRecovery(results);
  if (!recovery) return null;
  if (!(deps.configured ?? isAuxLLMConfigured())) return null;

  let line: string | null;
  try {
    const { system, user } = buildMechanicalFixPrompt(recovery);
    line = parseMechanicalFix(await (deps.ask ?? callAuxLLM)({ system, user, maxTokens: 120 }));
  } catch {
    return null;
  }
  if (!line) return null;

  try {
    const existing = learnedCheatsheet(recovery.signature, facts);
    if (existing.some((l) => l.toLowerCase() === line!.toLowerCase())) return null;
    const next = [...existing, line].slice(-MAX_LINES_PER_SIGNATURE);
    facts.storeFact({
      namespace: MECHANICAL_FIX_NAMESPACE,
      key: recovery.signature,
      value: next,
    });
  } catch {
    return null;
  }
  return { signature: recovery.signature, line };
}
