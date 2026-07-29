/**
 * Announced-tool stall gate (2026-07-27).
 *
 * The owner asked four times, over two hours, for the LRC exploration to continue. Four times the reply
 * was a preamble and nothing else — tools=0 every time, turn closed, control yielded:
 *
 *   "## For User 我现在看一下探索会话的状态，然后持续推进。 ## Work Log Let me check the deep_explore…"
 *   "## For User 先看看当前探索会话里还剩下什么方向，然后推进。 ## Work Log Let me check the deep_explore…"
 *   "## For User 先看探索会话的真实状态，说方向。      ## Work Log Let me check the current deep_explor…"
 *   "## For User 我现在就看。                        ## Work Log Calling deep_explore status to see…"
 *
 * In an async channel, ending the turn means waiting for the human. So "Calling deep_explore status" with
 * no call is a permanent stall: the owner is told work is starting and nothing ever starts. He asked
 * 你不是在推进LRC吗?
 *
 * honesty_gate.ts already has a branch for this (`announced_action_without_doing`) and it was enabled.
 * It missed all four, because it recognises the ANNOUNCEMENT by vocabulary: 我先/让我先/首先 + 调研|看看…,
 * or "let me … research|investigate|look into". The four replies said 我现在看一下 (not 我先), 先看看 (missing
 * the 我), 我现在就看, and "Calling deep_explore status" (a verb not on the list). Every miss is one word
 * away from a hit, which is the signature of a vocabulary list rather than a mechanism — the same
 * treadmill this repo has walked before.
 *
 * So this gate does not guess at the phrasing. Its window is structural and made of facts we own:
 *
 *   1. The reply names a tool from THIS turn's schema — an identifier WE generated, matched exactly.
 *   2. That tool was NOT called this turn — read off the turn's own ledger, not inferred.
 *
 * Inside that window one narrow question remains, and it is genuinely semantic: is the text saying the
 * work is about to happen, or is it describing past work / explaining a capability / answering a
 * question? A word list cannot answer that (see feedback: reading the agent's own output is the same
 * problem as reading the user's). So the window is deterministic and the judgment goes to the aux LLM,
 * asked only "what does this text assert" — never "did you fabricate", which invites the model to
 * defend itself.
 *
 * No aux model, an aux failure, or junk output → returns null and the reply goes out unchanged. A gate
 * that cannot reach its judge must not invent a verdict; the caller logs the window either way, so the
 * miss is visible rather than silent.
 */

import { callAuxLLM, isAuxLLMConfigured, type AuxLLMRequest } from '@agent/tools';
import { INTERNAL_CORRECTION_FOOTER, INTERNAL_CORRECTION_FOOTER_NL } from './internal_correction.js';

/** Tool names shorter than this are skipped — too likely to appear as ordinary prose. */
const MIN_TOOL_NAME_LEN = 4;

/**
 * Split an identifier into the pieces a human might separate in prose. `pariGp` has no separator of its
 * own, so camelCase boundaries count too — otherwise `PARI/GP` can never be matched against it.
 */
export function splitToolNameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s/.]+/)
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Which of this turn's schema tool names appear in the reply text. Tool names are our own identifiers,
 * so this is exact matching, not interpretation. `deep_explore` is also written `deep explore` and
 * `deep-explore` by the model, so separators are normalised on BOTH sides before comparing.
 */
export function findNamedTools(text: string, toolNames: readonly string[]): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const name of toolNames) {
    if (!name || name.length < MIN_TOOL_NAME_LEN) continue;
    // Segments of the identifier, rejoined with a flexible separator so `deep_explore` also matches
    // "deep explore" and "deep-explore". Bounded by non-identifier characters so `search_notes` does
    // not match inside `search_notes_v2`.
    // Separators include `/` and `.` because the model writes tool names the way a human would in prose:
    // production 2026-07-29 06:45 named `PARI/GP`, which no amount of underscore/space tolerance matches
    // against `pariGp`. A tool the reply names but the matcher cannot see is a window that never opens.
    const segments = splitToolNameSegments(name);
    if (!segments.length) continue;
    const re = new RegExp(`(?<![a-z0-9_])${segments.join('[_\\-\\s/.]*')}(?![a-z0-9_])`, 'i');
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

export interface AnnouncedToolVerdict {
  /** The tool the text says is about to run / is running. */
  toolName: string;
  /** The phrase that announced it, for the directive and the log. */
  quote: string;
}

/** Extract the first JSON object and validate it. Junk → null (the gate then does not fire). */
export function parseAnnouncedToolVerdict(raw: string, candidates: readonly string[]): AnnouncedToolVerdict | null {
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (obj.pending !== true) return null;
  const named = typeof obj.tool === 'string' ? obj.tool.trim() : '';
  // The judge may echo a name we did not offer; fall back to the first candidate rather than trusting it.
  const toolName = candidates.includes(named) ? named : candidates[0];
  if (!toolName) return null;
  const quote = (typeof obj.quote === 'string' ? obj.quote : '').trim().slice(0, 60);
  return { toolName, quote: quote || toolName };
}

export function buildAnnouncedToolPrompt(text: string, candidates: readonly string[]): string {
  return (
    'Below is an assistant\'s complete reply to its user. Facts you can rely on: the assistant called NO ' +
    `tool at all while producing it, and the reply mentions the tool name(s): ${candidates.join(', ')}.\n\n` +
    'Judge ONLY what the text says — not whether it is right, not whether the assistant did well.\n\n' +
    'Question: does the text tell the reader that the assistant is about to perform, or is in the middle of ' +
    'performing, an action with one of those tools — so that the reader would sit and wait for a result?\n\n' +
    'Answer false when the text merely describes work done in the PAST, explains what a tool can do, asks ' +
    'the user a question, declines to act, or gives a complete answer that promises nothing further.\n\n' +
    'Reply with ONLY this JSON object:\n' +
    '{"pending": true|false, "tool": "<the tool name, exactly as listed above>", "quote": "<the phrase that announces it, at most 40 characters>"}\n\n' +
    'The reply:\n"""\n' +
    text.slice(0, 3000) +
    '\n"""'
  );
}

export interface AnnouncedToolStallInput {
  /** The assistant's final text for this turn. */
  finalText: string;
  /** Tool names offered to the model this turn. */
  toolNames: readonly string[];
  /** Tool names actually invoked this turn (from the turn ledger). */
  calledToolNames: readonly string[];
  /** Injectable aux caller (defaults to callAuxLLM) so tests run without a live model. */
  call?: (req: AuxLLMRequest) => Promise<string>;
  signal?: AbortSignal;
}

export interface AnnouncedToolStallResult {
  /** Tools named in the text but never called — the deterministic window. Logged even when no fire. */
  window: string[];
  /** Non-null only when the aux judge confirmed the text leaves an action pending. */
  verdict: AnnouncedToolVerdict | null;
  /** Why no verdict: the window was empty, or the judge was unreachable / returned junk. */
  note?: 'no_window' | 'judge_unavailable' | 'judge_says_not_pending';
}

export function announcedToolGateEnabled(): boolean {
  const raw = (process.env.PHILONT_ANNOUNCED_TOOL_GATE ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
}

/** Never throws. See the module header for why an unreachable judge yields no verdict. */
export async function detectAnnouncedToolStall(
  input: AnnouncedToolStallInput,
): Promise<AnnouncedToolStallResult> {
  const called = new Set(input.calledToolNames);
  const window = findNamedTools(input.finalText, input.toolNames).filter((n) => !called.has(n));
  if (!window.length) return { window, verdict: null, note: 'no_window' };

  const call = input.call ?? callAuxLLM;
  if (input.call === undefined && !isAuxLLMConfigured()) {
    return { window, verdict: null, note: 'judge_unavailable' };
  }
  let raw: string;
  try {
    raw = await call({
      system: 'You judge what a piece of text asserts. Output only the requested JSON object.',
      user: buildAnnouncedToolPrompt(input.finalText, window),
      maxTokens: 200,
      signal: input.signal,
    });
  } catch {
    return { window, verdict: null, note: 'judge_unavailable' };
  }
  const verdict = parseAnnouncedToolVerdict(raw, window);
  return { window, verdict, note: verdict ? undefined : 'judge_says_not_pending' };
}

/** The intra-turn rewrite directive. Names the stall, then closes the two exits that are not doing it. */
export function buildAnnouncedToolDirective(v: AnnouncedToolVerdict): string {
  return (
    `[drive AnnouncedToolStall] Your reply says "${v.quote}" — it tells the user that \`${v.toolName}\` is ` +
    `about to run — but this turn issued NO tool call at all. Writing the call in prose or in a Work Log ` +
    `is not calling it.\n\n` +
    `You are in an asynchronous channel. Ending the turn here yields control and you do not get it back ` +
    `until the user speaks again, so nothing you announced will ever start. The user will read "I'm ` +
    `checking now" and wait for a result that cannot arrive.\n\n` +
    `**Rewrite this reply. Do ONE of these — do not straddle:**\n` +
    `  A · CALL \`${v.toolName}\` NOW, in this reply, and report what it actually returned;\n` +
    `  B · Say plainly that you are NOT doing it, and why — name the blocker (a missing tool, a missing ` +
    `credential, a decision you need from the user). "I'll do it next" is not a blocker and leaves the ` +
    `same stall.\n` +
    `Do not restate "${v.quote}".\n` +
    INTERNAL_CORRECTION_FOOTER
  );
}
