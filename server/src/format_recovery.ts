/**
 * Format-failure recovery (2026-09-20).
 *
 * A tool call that never reached a tool — arguments that did not parse, a required field missing, a
 * tool name that does not exist — is a FORMAT failure. Until now it was handled like every other
 * failure: a one-line reason, and after two of them the same-root-cause detector locked the tool for
 * the rest of the turn and demanded research before any retry. Two of its causes were invisible on
 * top of that: the OpenAI-compatible adapter turned unparseable argument JSON into `{}` (so the model
 * only ever saw "missing required field", never that its JSON was broken), and an unknown tool name
 * was answered but never recorded, so a hallucinated name (`read_file` for `readFile`) could loop to
 * the iteration cap unthrottled.
 *
 * The repair is the one ModularRSI (arXiv 2609.14857, IQuestLab/ModularRSI) evolved on the same model
 * family (DeepSeek-V4-Flash) and named `parse_error_recovery`: echo the raw text the model wrote wrong,
 * and escalate to a strict, unambiguous template after consecutive failures, because a retry prompt
 * that never changes shape gets the same malformed output back. The ladder below follows that design;
 * the code is ours (their release is CC BY-NC).
 *
 * Everything here is pure: no model, no store, no clock. The chat loop calls it at the rejection
 * point (feedback text, escalating with the count of prior format failures on the same tool this
 * turn) and at the in-turn detector (a reminder that tells the strategic gates to stand down).
 */

import type { InTurnToolRecord } from './in_turn_reflection.js';

/** The key the adapter uses to carry an argument string it could not parse as JSON. */
export const RAW_ARGUMENTS_KEY = '_raw';

/** Prefix every pre-authorization rejection starts with (failure_signatures keys its class on it). */
export const INPUT_FORMAT_PREFIX = 'tool input format error, blocked before authorization';

const ECHO_CAP = 400;

/**
 * `{ _raw: "<text>" }` is what the adapter hands over when the arguments were not JSON. The text is
 * the model's own output and must be shown back to it, not passed to a tool as if it were input.
 */
export function rawArgumentsLeak(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== RAW_ARGUMENTS_KEY) return null;
  const raw = input[RAW_ARGUMENTS_KEY];
  return typeof raw === 'string' ? raw : null;
}

export function isFormatFailureSignature(signature: string | undefined): boolean {
  return !!signature && /:(?:input-format|unknown-tool)$/.test(signature);
}

export function isFormatFailureText(text: string | undefined): boolean {
  if (!text) return false;
  return text.startsWith(INPUT_FORMAT_PREFIX) || /^(?:Error: )?Unknown tool\b/.test(text);
}

/** How many format failures this tool already collected this turn — the rung of the ladder. */
export function priorFormatFailures(records: ReadonlyArray<InTurnToolRecord>, toolName: string): number {
  let n = 0;
  for (const r of records) {
    if (r.success || r.toolName !== toolName) continue;
    if (isFormatFailureText(r.resultText)) n++;
  }
  return n;
}

function truncate(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= cap ? oneLine : `${oneLine.slice(0, cap)}… (${oneLine.length - cap} more chars)`;
}

function echoInput(input: unknown): string {
  if (typeof input === 'string') return truncate(input, ECHO_CAP);
  try {
    return truncate(JSON.stringify(input), ECHO_CAP);
  } catch {
    return '(unserializable input)';
  }
}

function typeWord(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return 'value';
  const p = prop as Record<string, unknown>;
  if (Array.isArray(p.enum) && p.enum.length > 0) {
    return p.enum.slice(0, 6).map((v) => JSON.stringify(v)).join(' | ');
  }
  const t = Array.isArray(p.type) ? p.type[0] : p.type;
  return typeof t === 'string' ? t : 'value';
}

/**
 * `{"path": <string>, "content": <string>, "offset"?: <number>}` — the shape the tool expects, built
 * from its JSON schema. Required keys first, optional keys marked, capped so a wide schema stays a hint.
 */
export function schemaShapeHint(schema: Record<string, unknown> | undefined): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const props = schema.properties;
  if (!props || typeof props !== 'object') return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === 'string') : [],
  );
  const entries = Object.entries(props as Record<string, unknown>);
  if (entries.length === 0) return null;
  const ordered = [
    ...entries.filter(([k]) => required.has(k)),
    ...entries.filter(([k]) => !required.has(k)),
  ].slice(0, 8);
  const parts = ordered.map(([k, v]) => `"${k}"${required.has(k) ? '' : '?'}: <${typeWord(v)}>`);
  return `{${parts.join(', ')}}`;
}

export interface InputRejectionInput {
  toolName: string;
  /** The validator's reason ("missing required field(s): path"). */
  detail: string;
  /** What the model actually sent (object, or the raw string when it was not JSON). */
  received: unknown;
  schema?: Record<string, unknown>;
  /** Format failures already collected for this tool this turn (before this one). */
  priorFailures: number;
}

/**
 * The tool_result text for a call rejected before authorization. Rung 0 echoes what was sent; rung 1
 * adds the expected shape; rung 2+ switches to a strict template and names the way out.
 */
export function buildInputRejection(input: InputRejectionInput): string {
  const raw = typeof input.received === 'string' ? input.received : null;
  const lines = [
    `${INPUT_FORMAT_PREFIX}: ${raw ? 'arguments were not valid JSON' : input.detail}`,
    `You sent: ${echoInput(input.received)}`,
  ];
  if (raw) {
    lines.push('Your arguments did not parse as a JSON object — check quotes, commas and braces, then call again with valid JSON.');
  }
  if (input.priorFailures >= 1) {
    const shape = schemaShapeHint(input.schema);
    if (shape) lines.push(`Expected input shape for ${input.toolName}: ${shape}`);
    if (!raw) lines.push(`Fix: ${input.detail}.`);
  }
  if (input.priorFailures >= 2) {
    lines.push(
      '',
      `STRICT FORMAT — this is format error #${input.priorFailures + 1} on ${input.toolName} this turn. ` +
        `Reply with exactly ONE tool call to ${input.toolName} whose input is a single JSON object with every required field filled, ` +
        'and nothing else. If you cannot produce that call, stop calling this tool and tell the user what you were trying to do and where it broke.',
    );
  }
  return lines.join('\n');
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < s.length; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character bigrams of the normalized names. */
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * The known tools a wrong name most plausibly meant. Exact match after normalization wins outright
 * (`read_file` / `ReadFile` / `read-file` → `readFile`): that is the cross-package snake/camel split
 * that has cost silent misses before. Otherwise the closest by bigram similarity, at most three.
 */
export function suggestToolNames(unknown: string, known: ReadonlyArray<string>, limit = 3): string[] {
  const target = normalizeName(unknown);
  if (!target) return [];
  const exact = known.filter((k) => normalizeName(k) === target);
  if (exact.length > 0) return exact.slice(0, limit);
  const scored = known
    .map((k) => {
      const n = normalizeName(k);
      const contains = n.length >= 4 && (n.includes(target) || target.includes(n)) ? 0.6 : 0;
      return { k, score: Math.max(dice(target, n), contains) };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));
  return scored.slice(0, limit).map((s) => s.k);
}

/** The tool_result text for a call to a tool that does not exist. Same ladder as buildInputRejection. */
export function buildUnknownToolFeedback(
  name: string,
  known: ReadonlyArray<string>,
  priorFailures: number,
): string {
  const suggestions = suggestToolNames(name, known);
  const lines = [`Error: Unknown tool '${name}'.`];
  if (suggestions.length > 0) {
    lines.push(`Did you mean: ${suggestions.join(', ')}? Tool names are exact and case-sensitive — use the name as listed in your tool definitions.`);
  } else {
    lines.push('No tool with a similar name exists. Use only the tools listed in your tool definitions; do not invent names.');
  }
  if (priorFailures >= 2) {
    lines.push(
      '',
      `STRICT — this is unknown-tool error #${priorFailures + 1} this turn. ` +
        (suggestions.length > 0
          ? `Call \`${suggestions[0]}\` with its documented input, or stop and tell the user what you were trying to do.`
          : 'Stop calling non-existent tools and tell the user what you were trying to do.'),
    );
  }
  return lines.join('\n');
}

/**
 * The in-turn reminder for a repeated format failure. Replaces the strategic reflection reminder
 * (classify / research / store_note) which is wrong for this class: the approach did not fail, the
 * call did. Deliberately tells the model what NOT to do, because the strategic gates it would
 * otherwise trigger are the deadlock.
 */
export function buildFormatFixReminder(
  signature: string,
  count: number,
  ctx: { toolName: string; shapeHint?: string | null; suggestions?: ReadonlyArray<string> },
): string {
  const unknown = /:unknown-tool$/.test(signature);
  return [
    '',
    `[drive format-recovery] ${count} calls to \`${ctx.toolName}\` this turn were rejected before execution (signature=${signature}).`,
    '',
    unknown
      ? '**The tool name is wrong, not the plan.** Do NOT research, do NOT make a plan, do NOT switch approach.'
      : '**The call was malformed, not the approach.** Do NOT research, do NOT make a plan, do NOT switch tools.',
    ...(unknown
      ? [
          ctx.suggestions && ctx.suggestions.length > 0
            ? `  • Use the exact name \`${ctx.suggestions[0]}\` (names are case-sensitive; snake_case and camelCase are different tools).`
            : '  • Use only names listed in your tool definitions. Do not invent tool names.',
        ]
      : [
          '  • Re-read the rejection text: it quotes what you sent and names the missing or broken part.',
          ...(ctx.shapeHint ? [`  • Send exactly this shape: ${ctx.shapeHint}`] : []),
          '  • Arguments must be ONE JSON object: double-quoted keys and strings, no trailing commas, no prose around it.',
        ]),
    '',
    'If the next call is rejected again, stop calling this tool and tell the user what you were trying to do.',
    '',
  ].join('\n');
}
