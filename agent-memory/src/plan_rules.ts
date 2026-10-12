/**
 * Typed plan items — the mechanism side (v53, 2026-10-12).
 *
 * A guide says three kinds of things besides "do X": "only do X when C", "never do Y", and "when you are
 * done, Z must be true". The plan used to flatten all of them into steps, so the gate could not refuse a
 * call that a guide forbids, could not hold a call until its precondition was looked at, and could not
 * tell "I did it" from "the world shows it". These helpers are the deterministic part: tool-call pattern
 * matching, finding the rule that blocks a call, and checking that a readback actually happened in the
 * tool trace. Nothing here knows any domain; the model decides what the items say.
 *
 * Division of labour (same as the honesty gate): the model reads the guide and writes the items; the
 * mechanism matches tool names / arguments and the trace, and never judges prose.
 */
import type { Plan, PlanItemKind, PlanRule, PlanStep, PlanToolPattern } from './types.js';

export const PLAN_ITEM_KINDS: readonly PlanItemKind[] = ['step', 'guard', 'forbid', 'evidence', 'invariant'];

export function isPlanItemKind(v: unknown): v is PlanItemKind {
  return typeof v === 'string' && (PLAN_ITEM_KINDS as readonly string[]).includes(v);
}

/** Kinds that carry a rule with tool patterns. */
export function kindNeedsRule(kind: PlanItemKind | undefined): boolean {
  return kind === 'guard' || kind === 'forbid' || kind === 'evidence' || kind === 'invariant';
}

/** One executed tool call, as the host records it (input is the call's JSON input, possibly truncated). */
export interface ToolTraceEntry {
  toolName: string;
  input: unknown;
  success: boolean;
  at: number;
}

/** Glob with `*` only; everything else literal. Case-sensitive like tool names themselves. */
export function toolNameMatches(pattern: string, toolName: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (!p.includes('*')) return p === toolName;
  const re = new RegExp('^' + p.split('*').map(escapeRegex).join('.*') + '$');
  return re.test(toolName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Safe regex construction: an invalid pattern matches nothing (and is reported at validation time). */
export function compileArgsPattern(args: string | undefined): RegExp | null {
  if (args === undefined || args.trim() === '') return null;
  try {
    return new RegExp(args, 'i');
  } catch {
    return null;
  }
}

/** Does this tool call match the pattern? `args` is tested against the JSON text of the input. */
export function patternMatchesCall(pattern: PlanToolPattern, toolName: string, input: unknown): boolean {
  if (!toolNameMatches(pattern.tool, toolName)) return false;
  if (pattern.args === undefined || pattern.args.trim() === '') return true;
  const re = compileArgsPattern(pattern.args);
  if (!re) return false;
  let text = '';
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  } catch {
    text = String(input);
  }
  return re.test(text);
}

export function ruleMatchesCall(rule: PlanRule, toolName: string, input: unknown): boolean {
  return rule.applies.some((p) => patternMatchesCall(p, toolName, input));
}

export interface BlockingRule {
  step: PlanStep;
  kind: 'guard' | 'forbid';
  /** guard: 'unresolved' (never looked at) or 'not_satisfied' (looked at, condition fails) */
  why: 'forbidden' | 'unresolved' | 'not_satisfied';
}

/**
 * The first open rule that blocks this tool call, or null. Forbid items block while the plan is open.
 * Guard items block until resolved 'satisfied'; a guard resolved 'not_satisfied' keeps blocking (the
 * guide's alternative path is a different step). Only plans that are not terminal are consulted.
 */
export function findBlockingRule(plan: Plan | undefined | null, toolName: string, input: unknown): BlockingRule | null {
  if (!plan) return null;
  if (plan.status === 'completed' || plan.status === 'failed') return null;
  for (const step of plan.steps) {
    if (!step.rule || (step.kind !== 'guard' && step.kind !== 'forbid')) continue;
    if (!ruleMatchesCall(step.rule, toolName, input)) continue;
    if (step.kind === 'forbid') return { step, kind: 'forbid', why: 'forbidden' };
    const res = step.rule.resolution ?? null;
    if (res === 'satisfied') continue;
    return { step, kind: 'guard', why: res === 'not_satisfied' ? 'not_satisfied' : 'unresolved' };
  }
  return null;
}

/**
 * Readback floor for evidence / invariant items: a SUCCESSFUL tool call matching one of the item's
 * patterns must exist in the trace at or after `sinceTs`. The model may claim anything in `evidence`;
 * this is the part it cannot claim.
 */
export function readbackSatisfied(step: PlanStep, trace: readonly ToolTraceEntry[], sinceTs: number): ToolTraceEntry | null {
  if (!step.rule) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const t = trace[i];
    if (!t.success || t.at < sinceTs) continue;
    if (ruleMatchesCall(step.rule, t.toolName, t.input)) return t;
  }
  return null;
}

/** Validation of the model-supplied rule fields; returns an error string or null. */
export function validateRuleInput(kind: PlanItemKind | undefined, raw: unknown, label: string): string | null {
  if (!kindNeedsRule(kind)) return null;
  if (!raw || typeof raw !== 'object') return `${label}: kind '${kind}' requires rule {applies:[{tool,args?}], condition}`;
  const r = raw as Record<string, unknown>;
  if (typeof r.condition !== 'string' || r.condition.trim().length < 4) {
    return `${label}: rule.condition must state the condition / prohibition / expected observation (≥ 4 chars)`;
  }
  if (!Array.isArray(r.applies) || r.applies.length === 0) {
    return `${label}: rule.applies must list at least one tool pattern {tool, args?}`;
  }
  for (let i = 0; i < r.applies.length; i++) {
    const a = r.applies[i] as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || typeof a.tool !== 'string' || !a.tool.trim()) {
      return `${label}: rule.applies[${i}].tool must be a tool name or glob (e.g. "jira__*")`;
    }
    if (a.args !== undefined) {
      if (typeof a.args !== 'string') return `${label}: rule.applies[${i}].args must be a regular expression string`;
      if (a.args.trim() && compileArgsPattern(a.args) === null) {
        return `${label}: rule.applies[${i}].args is not a valid regular expression`;
      }
    }
  }
  return null;
}

/** Build the stored rule from validated input (drops unknown fields, trims strings). */
export function normalizeRuleInput(raw: Record<string, unknown>): PlanRule {
  const applies = (raw.applies as Array<Record<string, unknown>>).map((a) => {
    const p: PlanToolPattern = { tool: String(a.tool).trim() };
    if (typeof a.args === 'string' && a.args.trim()) p.args = a.args.trim();
    return p;
  });
  return { applies, condition: String(raw.condition).trim(), resolution: null };
}

/** Open (non-terminal) guard / forbid / evidence / invariant items, for prompts and close-time checks. */
export function ruleItems(plan: Plan): PlanStep[] {
  return plan.steps.filter((s) => s.rule && kindNeedsRule(s.kind));
}
