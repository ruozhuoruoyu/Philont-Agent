/**
 * Acceptance conventions (2026-10-08): the failure-side learning loop around the acceptance–repair loop.
 *
 * When a task's acceptance check fails, the failing clauses / test requirements say what this
 * environment's checker demands that the task text did not. Those demands recur across tasks in
 * environments with stable conventions (philosophers exp 115 ConvStream: ACE-style rules +11/+9 paired,
 * check bank +8/+17; exp 116 AppWorld: ACE +2/+4), and do not recur where every checker is different
 * (LifelongAgentBench OS: 0). So the loop is: distil ≤ 2 environment-general rules from the failing
 * clauses (aux LLM, main-LLM fallback), store them keyed by environment with helpful/harmful counts, show
 * the applicable ones in later task prompts, and credit them with the task's first-check outcome.
 * Everything here is pure or store-only; headless.ts wires it around the acceptance loop.
 */
import type { ConventionMatch } from '@agent/memory';

export const MAX_RULES_PER_FAILURE = 2;
export const MAX_RULES_SHOWN = 5;

export function distilPrompt(taskText: string, failing: readonly string[], checkOutput: string): string {
  const detail = failing.length
    ? ['Failed acceptance checks (bash clauses / test requirements, each must pass):', ...failing.slice(0, 8).map((c) => `- ${c.slice(0, 300)}`)]
    : ['Acceptance check output:', checkOutput.slice(-1200) || '(no output)'];
  return [
    'An autonomous agent completed a task in a fixed environment, but the environment\'s acceptance checker rejected it. From the failed checks, write the environment\'s CONVENTIONS the agent did not know — rules that will apply to OTHER tasks in the same environment, not a fix for this one task.',
    '',
    `Task: ${taskText.slice(0, 1200)}`,
    ...detail,
    '',
    `Write at most ${MAX_RULES_PER_FAILURE} rules. Each rule: one imperative sentence, environment-general (no task-specific names or values unless they are the convention itself, e.g. a fixed file name or permission mode), stating WHEN it applies and WHAT the checker requires. Skip anything that is just this task's content. If nothing generalizes, output NONE.`,
    'Output one rule per line, prefixed with "- ". No other text.',
  ].join('\n');
}

/** Parse "- rule" lines; drops blanks, NONE, and over-long lines; at most MAX_RULES_PER_FAILURE. */
export function parseRules(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line || /^none\.?$/i.test(line) || line.length < 12 || line.length > 300) continue;
    if (/^(rules?|output|conventions?)\s*:?$/i.test(line)) continue;
    if (!out.some((r) => r.toLowerCase() === line.toLowerCase())) out.push(line);
    if (out.length >= MAX_RULES_PER_FAILURE) break;
  }
  return out;
}

/** The prompt section shown before a task: applicable conventions with their track record. */
export function renderConventions(rules: readonly ConventionMatch[]): string {
  if (rules.length === 0) return '';
  return [
    '',
    '## Acceptance conventions learned in this environment',
    '(From earlier tasks whose acceptance checks failed; counts = tasks they helped / misled. Follow them unless the task says otherwise.)',
    ...rules.slice(0, MAX_RULES_SHOWN).map((r) => `- ${r.rule} (+${r.helpful}/−${r.harmful})`),
    '',
  ].join('\n');
}
