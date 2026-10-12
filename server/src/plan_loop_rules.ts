/**
 * Plan protocol v2 — typed rule items for the mechanism loop (docs/design/plan_protocol_v2.md).
 *
 * The loop's plan used to be deliverables + steps. A guide also says "only do X when C" (guard),
 * "never do Y" (forbid), "afterwards the world must show Z" (evidence) and "W must still hold at the
 * end" (invariant). These helpers are the mechanism half of those four kinds: parsing the model's
 * rule JSON against the real tool list, refusing tool calls a guard or forbid governs, resolving a
 * guard with a read-only sub-run, and checking that an evidence/invariant readback actually happened
 * (and what it showed, via a judge that only ever sees the readback text and the condition).
 *
 * No domain words live here. The mechanism knows kinds, tool names, call inputs, results and order.
 */
import {
  patternMatchesCall,
  toolNameMatches,
  validateRuleInput,
  type ToolTraceEntry,
} from '@agent/memory';
import type { PlanItemKind, PlanToolPattern } from '@agent/memory';
import type { ToolDefinition } from '@agent/policy';

export type LoopRuleKind = Exclude<PlanItemKind, 'step'>;
export type GuardResolution = 'satisfied' | 'not_satisfied' | 'unresolved';

export interface LoopRule {
  id: string;
  kind: LoopRuleKind;
  /** The guide's own words for the condition / prohibition / expected observation. */
  condition: string;
  applies: PlanToolPattern[];
  /** Deliverables this rule protects or verifies (guard / evidence). */
  covers: string[];
  /** guard only; set by the RESOLVE phase. */
  resolution?: GuardResolution;
  resolutionEvidence?: string;
}

export const RULE_KINDS: ReadonlySet<string> = new Set(['guard', 'forbid', 'evidence', 'invariant']);

export interface ParsedRules {
  rules: LoopRule[];
  /** Human-readable problems the REVISE round must fix (unknown tool names, bad regexes, …). */
  problems: string[];
}

/**
 * Parse the model's `rules` array. Shape problems are reported, not silently dropped: a rule the
 * model wrote and the mechanism cannot enforce must come back as a revision request, otherwise the
 * guide's prohibition quietly disappears. A pattern naming a tool that does not exist is the common
 * weak-model slip (a near-miss spelling), so the message carries the closest real names.
 */
export function parseRules(raw: unknown, knownTools: ReadonlySet<string>, validDeliverableIds: ReadonlySet<string>, slug: (s: string) => string): ParsedRules {
  const rules: LoopRule[] = [];
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { rules, problems };
  if (!Array.isArray(raw)) return { rules, problems: ['"rules" must be an array'] };
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind.trim() : '';
    if (!RULE_KINDS.has(kind)) {
      problems.push(`rules[${i}]: kind must be one of guard / forbid / evidence / invariant (got "${kind || 'missing'}")`);
      return;
    }
    const id = slug(typeof o.id === 'string' && o.id.trim() ? o.id : `${kind}-${i + 1}`);
    const err = validateRuleInput(kind as PlanItemKind, { applies: o.applies, condition: o.condition }, `rules[${i}] (${id})`);
    if (err) { problems.push(err); return; }
    const applies = (o.applies as Array<Record<string, unknown>>).map((a) => {
      const p: PlanToolPattern = { tool: String(a.tool).trim() };
      if (typeof a.args === 'string' && a.args.trim()) p.args = a.args.trim();
      return p;
    });
    // Every pattern must resolve to at least one real tool, or the rule can never fire.
    if (knownTools.size > 0) {
      for (const p of applies) {
        const hits = [...knownTools].filter((t) => toolNameMatches(p.tool, t));
        if (hits.length === 0) {
          problems.push(
            `rules[${i}] (${id}): pattern "${p.tool}" matches no available tool` +
              (nearestTools(p.tool, knownTools).length ? ` — did you mean ${nearestTools(p.tool, knownTools).join(' / ')}?` : ''),
          );
          return;
        }
      }
    }
    const covers = Array.isArray(o.covers)
      ? o.covers.filter((c): c is string => typeof c === 'string').map(slug).filter((c) => validDeliverableIds.has(c))
      : [];
    const uid = seen.has(id) ? `${id}-${i + 1}` : id;
    seen.add(uid);
    rules.push({ id: uid, kind: kind as LoopRuleKind, condition: String(o.condition).trim().slice(0, 400), applies, covers });
  });
  return { rules, problems };
}

/** Closest tool names by shared trigram count — a hint for the revision, nothing else. */
export function nearestTools(name: string, known: ReadonlySet<string>, n = 3): string[] {
  const grams = (s: string): Set<string> => {
    const t = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const g = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3));
    return g;
  };
  const a = grams(name.replace(/\*/g, ''));
  if (a.size === 0) return [];
  return [...known]
    .map((t) => ({ t, s: [...grams(t)].filter((x) => a.has(x)).length }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.t);
}

/** One line per tool for the compile prompt: the model must use exact names in patterns. */
export function toolListBlock(toolDefs: readonly ToolDefinition[], max = 120): string {
  const lines = toolDefs.slice(0, max).map((t) => `- ${t.name}: ${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
  const more = toolDefs.length > max ? `\n- …and ${toolDefs.length - max} more` : '';
  return `# Tools available (use EXACT names in rule patterns; "*" is a wildcard)\n${lines.join('\n')}${more}`;
}

export interface RuleBlock {
  rule: LoopRule;
  why: 'forbidden' | 'unresolved' | 'not_satisfied';
}

/** The first rule that refuses this call. Forbids always; guards until resolved satisfied. */
export function findRuleBlock(rules: readonly LoopRule[], toolName: string, input: unknown): RuleBlock | null {
  for (const rule of rules) {
    if (rule.kind !== 'guard' && rule.kind !== 'forbid') continue;
    if (!rule.applies.some((p) => patternMatchesCall(p, toolName, input))) continue;
    if (rule.kind === 'forbid') return { rule, why: 'forbidden' };
    if (rule.resolution === 'satisfied') continue;
    return { rule, why: rule.resolution === 'not_satisfied' ? 'not_satisfied' : 'unresolved' };
  }
  return null;
}

/** The refusal the model sees. It names the rule and the guide's words; it never explains how to get around it. */
export function ruleBlockMessage(b: RuleBlock, toolName: string): string {
  const head = `[plan-rule] ${toolName} refused by ${b.rule.kind} "${b.rule.id}": ${b.rule.condition}`;
  switch (b.why) {
    case 'forbidden':
      return `${head}\nThe guide forbids this action in this task. Do not retry it; follow the guide's alternative path (it is a deliverable of this plan if the guide names one).`;
    case 'not_satisfied':
      return `${head}\nThe guard was checked and the condition does NOT hold (${b.rule.resolutionEvidence ?? 'no evidence recorded'}). Do not retry it; follow the guide's alternative path for this case.`;
    default:
      return `${head}\nThis guard has not been resolved yet; the call is held until the condition has been verified with read tools.`;
  }
}

/** The index in a step's call history of the last successful write/execute call (−1 when none). */
export function lastWriteIndex(history: readonly { ok: boolean; name: string; input: Record<string, unknown> }[], isAction: (c: { name: string; input: Record<string, unknown> }) => boolean): number {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].ok && isAction(history[i])) return i;
  return -1;
}

/**
 * Readback floor for an evidence/invariant rule over a step's full-output trace: a SUCCESSFUL call
 * matching the rule, at or after `afterIndex` (the step's last write). Returns the matching entry.
 */
export function findReadback<T extends ToolTraceEntry>(rule: LoopRule, trace: readonly T[], afterIndex: number): T | null {
  for (let i = trace.length - 1; i >= 0 && i >= afterIndex; i--) {
    const t = trace[i];
    if (!t.success) continue;
    if (rule.applies.some((p) => patternMatchesCall(p, t.toolName, t.input))) return t;
  }
  return null;
}

/** Parse the fixed one-line verdict of a RESOLVE sub-run. Anything else is 'unresolved'. */
export function parseGuardVerdict(text: string): GuardResolution {
  const m = text.match(/VERDICT\s*:\s*(SATISFIED|NOT_SATISFIED)\b/i);
  if (!m) return 'unresolved';
  return m[1].toUpperCase() === 'SATISFIED' ? 'satisfied' : 'not_satisfied';
}

/** Parse the judge's one-word answer about what a readback shows. */
export function parseReadbackVerdict(text: string): 'yes' | 'no' | 'unclear' {
  const t = text.trim().toLowerCase();
  if (/^\s*(yes|shows|confirmed)\b/.test(t) || /"verdict"\s*:\s*"yes"/.test(t)) return 'yes';
  if (/^\s*(no|does not|not shown)\b/.test(t) || /"verdict"\s*:\s*"no"/.test(t)) return 'no';
  return 'unclear';
}

export const RESOLVE_SYSTEM =
  'You are checking ONE condition from a task guide before any action that depends on it. Use READ tools only ' +
  '(look things up; change nothing). Then end your reply with exactly one line:\n' +
  'VERDICT: SATISFIED — <what you read that shows it>\nor\nVERDICT: NOT_SATISFIED — <what you read that shows it>\n' +
  'If you could not read anything relevant, say so and give no VERDICT line.';

export const READBACK_SYSTEM =
  'You are verifying ONE expected outcome by reading the current state back from the environment. Use READ tools ' +
  'only (look it up; change nothing). Report plainly what the tool returned.';

export const READBACK_JUDGE_SYSTEM =
  'You are shown text that a tool returned, and an expected observation. Answer with one word — yes, no, or unclear — ' +
  'about whether the TEXT shows the observation. Judge only the text; never assume anything that is not in it.';
