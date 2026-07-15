/**
 * The learning judge (self_learning_redesign Phase 1 — the keystone).
 *
 * Scores whether a turn actually reached a verified success, so that downstream learning can be driven by
 * real efficacy instead of the online per-artifact attribution proxies that never closed (use_skill=2%,
 * routing success-only ratchet, playbooks never measured). Every later engine depends on this one, which is
 * exactly why it must be adversarially trustworthy before it drives anything.
 *
 * ## Anti-sycophancy backbone: deterministic guard rails, LLM only in the middle
 *
 * A judge that is "an LLM reading the transcript and grading it" is trivially sycophantic — it will call a
 * fabricated success a success. So the clear-cut cases are decided WITHOUT the model, mirroring honesty_gate:
 *
 *   - An assistant claim of a produced RESULT on a turn that ran ZERO execution tools is a fabrication —
 *     `failure`, deterministically, no LLM call. (This is the exact production failure class of 2026-07-14.)
 *   - A turn on which honesty_gate fired can never be scored `success` (cross-check: distrust a "success"
 *     the honesty layer already flagged).
 *   - A turn that issued no tools at all and made no result claim is `could_not_verify` — nothing happened
 *     to judge.
 *
 * Only the genuinely ambiguous middle — real tool activity whose success is not self-evident — is sent to
 * the aux LLM, and even there the model is instructed to DEFAULT to could_not_verify and to cite the
 * specific tool result that proves success, or it does not count.
 *
 * ## Fails safe
 *
 * Aux unconfigured / errored / returned garbage → `could_not_verify`, never `success`. A judge that cannot
 * see must not manufacture a positive verdict — that would poison every downstream store. Re-judging costs
 * nothing; a false success corrupts memory (the constitution's own rule).
 *
 * ## Phase 1 = SHADOW
 *
 * This module only SCORES and returns a verdict. Wiring it to drive promotion/demotion/crystallization is
 * Phase 2+, gated on a shadow period proving the verdict distribution is trustworthy (agrees with
 * honesty_gate on clear cases, not ~100% could_not_verify). Do not wire it live before that gate.
 */

import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';
import { findExecutionClaim, isExecutionTool } from '@agent/memory';

export type RunOutcome = 'success' | 'failure' | 'could_not_verify';

export interface RunVerdict {
  outcome: RunOutcome;
  /** 'deterministic' = decided by a guard rail without the LLM; 'llm' = the ambiguous middle; 'fail_safe' = aux unusable. */
  basis: 'deterministic' | 'llm' | 'fail_safe';
  /** One line: what evidence decided it. For a success this MUST name the tool/action that proves it. */
  evidence: string;
}

/** A compact record of one tool call this turn (what the judge is allowed to reason over). */
export interface JudgeToolRecord {
  toolName: string;
  ok: boolean;
  /** short result/error text, already truncated by the caller */
  summary: string;
}

export interface JudgeRunInput {
  /** What the turn was trying to accomplish (the user goal / task). */
  goal: string;
  /** What actually happened — the turn's tool records. */
  trace: ReadonlyArray<JudgeToolRecord>;
  /** The assistant's final user-facing claim (what it said it did / concluded). */
  assistantClaim: string;
  /** Cross-check: did honesty_gate fire this turn? A success is not credible if it did. */
  honestyFired: boolean;
}

// Reuse honesty_gate's hardened, production-tested detectors rather than a home-grown regex. findExecutionClaim
// already handles the real fabrication phrasings (incl. the "TileRT 已在我的环境成功编译, 53/53" case) and
// screens out future/negated/hypothetical claims; isExecutionTool is the same execution-tool set the honesty
// layer uses, so the judge and the honesty gate agree by construction.
function ranAnyExecutionTool(trace: ReadonlyArray<JudgeToolRecord>): boolean {
  return trace.some((r) => isExecutionTool(r.toolName));
}

function claimsAResult(text: string): boolean {
  return findExecutionClaim(text ?? '') !== null;
}

const SYSTEM = [
  'You judge whether an AI agent turn actually ACHIEVED its goal. You are a skeptic, not a cheerleader.',
  '',
  'Reply in EXACTLY this format:',
  '  VERDICT: success | failure | could_not_verify',
  '  GROUNDS: tool #<N>   (REQUIRED for success — the 1-based index of the SUCCESSFUL tool that proves it)',
  '  WHY: <one short line>',
  '',
  '  success          — the goal was demonstrably achieved AND a specific SUCCESSFUL tool in the trace proves',
  '                     it. You MUST cite that tool by index in GROUNDS. The tool must be one that actually',
  '                     did/verified the thing (a file read or a web search does NOT prove a computation, a',
  '                     build, or a registration). If you cannot cite such a tool, it is NOT success.',
  '  failure          — the trace shows the goal was not achieved (the relevant tool failed, or the claim',
  '                     contradicts what the tools returned).',
  '  could_not_verify — you cannot tell from the trace. This is the DEFAULT. Prefer it over guessing.',
  '',
  'Hard rules:',
  '  - A claim is not evidence. "I computed X" / "accuracy is 92%" with no successful tool that produced it',
  '    is could_not_verify at best, failure if a relevant tool positively failed.',
  '  - A SUCCESSFUL bystander tool (readFile, search) does not ground a claim about something else.',
  '  - Never award success to be agreeable. A false success corrupts the agent\'s memory; re-judging is free.',
].join('\n');

/**
 * Tools whose ok===true can GROUND a success — they did or verified something. Deliberately narrower than
 * isExecutionTool: a file read or a web search is "execution" but proves nothing about whether a computation,
 * build, or registration succeeded. Grounding a success on an irrelevant successful bystander tool was the
 * red-team's critical Finding 1.
 */
const GROUNDING_TOOLS = new Set([
  'shell', 'execute', 'pariGp', 'z3Verify', 'leanCheck', 'magnitude', 'http',
]);

function hasSuccessfulGroundingTool(trace: ReadonlyArray<JudgeToolRecord>): boolean {
  return trace.some((r) => GROUNDING_TOOLS.has(r.toolName) && r.ok);
}

function renderTrace(trace: ReadonlyArray<JudgeToolRecord>): string {
  if (trace.length === 0) return '(no tools were called this turn)';
  return trace
    .map((r, i) => `${i + 1}. ${r.toolName} ${r.ok ? 'OK' : 'FAILED'}: ${r.summary}`)
    .join('\n');
}

/**
 * Score a turn. Deterministic guard rails first; the aux LLM only for the ambiguous middle; fail-safe to
 * could_not_verify. Never returns `success` without either a guard-rail proof or an LLM verdict that cited
 * evidence.
 */
export async function judgeRun(
  input: JudgeRunInput,
  deps: { call?: (req: { system: string; user: string; maxTokens: number }) => Promise<string> } = {},
): Promise<RunVerdict> {
  const ranExec = ranAnyExecutionTool(input.trace);
  const execClaim = claimsAResult(input.assistantClaim);
  const grounded = hasSuccessfulGroundingTool(input.trace);

  // ── Guard rail 1: fabricated EXECUTION. An execution claim ("已跑通 / compiled / ran") on a turn that ran
  // zero execution tools is the 2026-07-14 failure class. Decided without the LLM. ──
  if (execClaim && !ranExec) {
    return {
      outcome: 'failure',
      basis: 'deterministic',
      evidence: 'claimed an execution result on a turn that ran zero execution tools — fabrication',
    };
  }

  // ── Guard rail 2 (cross-check, now a bonus not the load-bearing defense): honesty gate fired. ──
  if (input.honestyFired) {
    return {
      outcome: 'failure',
      basis: 'deterministic',
      evidence: 'honesty_gate fired this turn — a success verdict would contradict the honesty layer',
    };
  }

  // ── THE CAP (the load-bearing fix for red-team Findings 1, 2, 3, H1c). `success` REQUIRES a successful
  // grounding tool (something that actually did/verified the thing — not a bystander readFile/search). With
  // no such tool, the verdict is capped: a fabricated numeric/passive result on a turn that only read a file
  // CANNOT be success, no matter how the claim is phrased or how sycophantic the aux is. Pure-reasoning
  // deliverables (proofs, analysis, writing) also land here → could_not_verify, NOT failure: we simply do
  // not crystallize skills from turns we cannot verify. This is the intended asymmetry — a missed learning
  // opportunity is cheap; a fabricated success poisons memory. ──
  if (!grounded) {
    // A positive execution claim while an execution tool actually FAILED is a real failure signal (H1c);
    // otherwise there is simply nothing verifiable → could_not_verify.
    const execFailed = input.trace.some((r) => GROUNDING_TOOLS.has(r.toolName) && !r.ok);
    if (execClaim && execFailed) {
      return {
        outcome: 'failure',
        basis: 'deterministic',
        evidence: 'claimed a result but the execution/verifier tool failed — not a success',
      };
    }
    return {
      outcome: 'could_not_verify',
      basis: 'deterministic',
      evidence: 'no successful execution/verifier tool to ground a success — cannot confirm the goal was met',
    };
  }

  // ── The ambiguous middle: a successful grounding tool IS present, so success is *possible*. Ask the aux,
  // default could_not_verify, and require it to CITE the grounding tool by index (validated below). ──
  const call = deps.call ?? callAuxLLM;
  if (!deps.call && !isAuxLLMConfigured()) {
    return {
      outcome: 'could_not_verify',
      basis: 'fail_safe',
      evidence: 'aux LLM not configured — cannot judge the ambiguous case; defaulting to could_not_verify',
    };
  }

  try {
    const user = [
      `Goal: ${input.goal}`,
      '',
      'Trace (what actually happened):',
      renderTrace(input.trace),
      '',
      `The agent's final claim: ${input.assistantClaim || '(none)'}`,
    ].join('\n');
    const raw = (await call({ system: SYSTEM, user, maxTokens: 96 })).trim();
    const verdict = parseVerdict(raw);
    const evidence = extractWhy(raw);

    if (verdict === 'success') {
      // Validate the citation: the aux must have pointed at a tool index that is a SUCCESSFUL grounding tool.
      // An uncited or mis-cited success is downgraded — this is what stops a sycophantic "success" that
      // gestures at an irrelevant/failed tool.
      const citedIdx = parseCitedToolIndex(raw);
      const cited = citedIdx !== null ? input.trace[citedIdx - 1] : undefined;
      if (!cited || !GROUNDING_TOOLS.has(cited.toolName) || !cited.ok) {
        return {
          outcome: 'could_not_verify',
          basis: 'fail_safe',
          evidence: 'aux said success but did not cite a successful execution/verifier tool — distrusted',
        };
      }
      return { outcome: 'success', basis: 'llm', evidence };
    }
    return { outcome: verdict, basis: 'llm', evidence };
  } catch (e) {
    return {
      outcome: 'could_not_verify',
      basis: 'fail_safe',
      evidence: `aux LLM error (${(e as Error)?.message ?? 'unknown'}) — never success on error`,
    };
  }
}

/** Parse the VERDICT token robustly (red-team Finding 5). Looks for the explicit marker, then a standalone
 * verdict word; never matches narrative prose like "Successfully verified…". Defaults could_not_verify. */
function parseVerdict(raw: string): RunOutcome {
  const marker = raw.match(/VERDICT\s*:\s*(success|failure|could[_\s-]?not[_\s-]?verify)/i);
  const token = (marker?.[1] ?? '').toLowerCase();
  if (token.startsWith('success')) return 'success';
  if (token.startsWith('failure')) return 'failure';
  if (token) return 'could_not_verify';
  // No marker (aux ignored the format). Fall back to a conservative scan of standalone verdict words.
  if (/\bcould[_\s-]?not[_\s-]?verify\b/i.test(raw)) return 'could_not_verify';
  if (/\bfailure\b|\bfailed\b/i.test(raw)) return 'failure';
  // Deliberately do NOT infer success from loose prose — success must come via the marker above.
  return 'could_not_verify';
}

function parseCitedToolIndex(raw: string): number | null {
  const m = raw.match(/GROUNDS\s*:[^\n]*?#?\s*(\d+)/i) ?? raw.match(/tool\s*#?\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function extractWhy(raw: string): string {
  const m = raw.match(/WHY\s*:\s*([^\n]+)/i);
  return (m?.[1] ?? raw.replace(/\n/g, ' ')).trim().slice(0, 240) || '(no evidence line)';
}
