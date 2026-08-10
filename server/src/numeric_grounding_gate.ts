/**
 * Numeric / computation grounding gate (2026-06-22).
 *
 * Fabrication post-mortem: the model reported concrete computed values — "r(N) vs Hardy-Littlewood
 * 比值…", "自由卷积比值膨胀到13.6", "谱半径≈12.3", "三轮探索跑完，全是真数据" — on turns where
 * ZERO compute tools succeeded (every pariGp/shell run failed, or none ran at all). The honesty gate
 * did not catch it: its claim taxonomy is completion / memory / size / arXiv — it has no category for
 * "I ran the computation and these are the numbers". So mathematical fabrication sailed through
 * `[honesty] passed (0 ok / 0 fail / 0 total)`.
 *
 * This gate fills exactly that hole. It fires when the reply ASSERTS it computed/verified/ran
 * something and reports numeric results, but the turn's tool ledger contains NO successful
 * compute/exec tool result to back it. Chat-handler then regenerates once (same mechanism as the
 * citation gate) to force an honest "could not verify" framing.
 *
 * Kept dependency-light (mirrors citation_gate.ts / viability_gate.ts) so it is unit-testable without
 * importing the heavy chat-handler module. Deliberately HIGH PRECISION: it only fires on the
 * unambiguous "claimed computation with no successful backing tool" pattern, not on per-number
 * matching (which over-blocks legitimate computed answers). Per-number cross-checking against ✓
 * outputs is a future tightening, noted but intentionally out of scope here.
 */

import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';
import { findNamedTools } from './announced_tool_gate.js';
import { INTERNAL_CORRECTION_FOOTER } from './internal_correction.js';

/** A tool result as produced by extractRecentToolResults: content starts with ✓ (ok) or ⚠ (failed). */
export interface GroundingToolResult {
  toolName: string;
  content: string;
}

/**
 * Tools whose SUCCESSFUL output legitimately backs a computed/verified numeric claim. A native
 * compute engine, or a generic shell/process that ran one (e.g. `python calc.py`, `gp script.gp`).
 */
const COMPUTE_TOOLS = new Set<string>([
  'pariGp',
  'z3Verify',
  'leanCheck',
  'magnitude',
  'shell',
  'process',
]);

// "I actually computed / verified / ran it and here is the result" — present/past tense assertions,
// bilingual. These are claims of accomplished empirical work, not intentions.
//
// The ENUMERATION-REPORT shape was missing until 2026-07-27. "共测试 10 个子集，全部通过，0 反例" asserts
// finished empirical work exactly as plainly as 跑通 does, but names no verb on this list — so two
// fabricated Lonely Runner verification reports (k=9 and k=10, both with tools=0) went straight to the
// owner, who had to catch them himself: 你真的做了吗？怎么这么快？ A pass/fail tally IS a computation claim.
const COMPUTE_CLAIM_RE =
  /(跑通|跑完|算完|计算完成|计算完毕|数值验证|实际计算|真实数据|真实计算|实测|算出|计算得到?|得出.*(比值|范数|谱半径|结果)|验证(通过|成立|了)|全部通过|均通过|全通过|无反例|\d+\s*个?反例|枚举(完成|完毕|通过)|verified numerically|numerically verified|computed (?:that|the|to|it)|the computation (?:shows|gives|yields|confirms)|simulation (?:shows|gives)|ran the (?:computation|calculation|script|numbers)|results? (?:show|confirm|give)|all\s+pass(?:ed)?\b|no counterexamples?\b|0\s+counterexamples?\b)/i;

// Hedges / negations / intentions that mean NO accomplished-computation claim is being made — suppress.
const ANTI_CLAIM_RE =
  /(我?(将|要|想|打算|计划|准备|会去?)\s*(计算|验证|跑|运行)|尚未|还没|没能|未能|没有机会(?:重跑|运行|验证|计算)|无法(验证|计算|跑)|不能(验证|计算)|待核实|未验证|无法确认|非本轮(?:运行|执行|验证|计算|在线核查)|(?:此前|上一轮|历史记录|既有记录)[^。！？\n]{0,24}(?:显示|记载|结果|运行|验证)|plan to|going to|will (?:compute|verify|run|try)|could not (?:verify|compute|run)|couldn'?t (?:verify|compute|run)|unable to (?:verify|compute|run)|was not able to|failed to (?:compute|verify|run)|did not (?:run|compute|verify)|not run this turn|from (?:an )?(?:earlier|previous) (?:turn|session|record))/i;

// Narrow whole-reply semantics for the model ceiling. Do not reuse ANTI_CLAIM_RE here: a genuine
// fabricated report can contain a local mathematical phrase such as “未能超过阈值” while still claiming
// that the run happened. Only explicit evidence-time or inability-to-run wording bypasses adjudication.
const EXPLICIT_NON_CURRENT_COMPUTE_RE =
  /(?:本轮|这(?:一)?轮)[^。！？\n]{0,18}(?:没有机会|未能|没能|无法|未|没有)(?:重跑|运行|执行|验证|计算)|非本轮(?:运行|执行|验证|计算|在线核查)|(?:此前|上一轮|历史记录|既有记录)[^。！？\n]{0,24}(?:显示|记载|结果|运行|验证)|not run this turn|from (?:an )?(?:earlier|previous) (?:turn|session|record)/i;

// Numeric RESULT tokens: a number attached to a result marker / math quantity. Avoids firing on
// incidental integers like "3 candidates" or "N=20 case" alone (those need a result context).
const RESULT_NUMBER_RE =
  /(?:[=＝≈≅~]\s*-?\d|\b\d+(?:\.\d+)?\s*(?:×|倍|x\b)|(?:比值|范数|谱半径|半径|矩|特征值|夹角|偏差|ratio|norm|radius|eigenvalue|spectral radius|cumulant|angle|deviation|σ|θ|δ|λ)\D{0,6}-?\d|-?\d+(?:\.\d+)?\s*(?:°|度))/i;

/**
 * Returns a short description of the offending claim when the reply asserts an accomplished
 * computation/verification with numeric results but NO successful compute/exec tool backs it this
 * turn; otherwise null.
 */
export function detectUngroundedComputation(
  text: string,
  toolResults: GroundingToolResult[],
): { claim: string; okCompute: number } | null {
  if (!text) return null;
  if (ANTI_CLAIM_RE.test(text)) return null;
  if (!COMPUTE_CLAIM_RE.test(text)) return null;
  if (!RESULT_NUMBER_RE.test(text)) return null;

  // Is there ANY successful compute/exec tool result this turn?
  const okCompute = toolResults.filter(
    (r) => r.content.startsWith('✓') && COMPUTE_TOOLS.has(r.toolName),
  ).length;
  if (okCompute > 0) return null; // genuinely backed — leave it (per-number check is future work)

  const m = COMPUTE_CLAIM_RE.exec(text);
  const claim = (m?.[0] ?? 'computed result').slice(0, 60);
  return { claim, okCompute };
}

/**
 * The intra-turn rewrite directive injected when an ungrounded computation claim is detected.
 * `ledger` (optional) is the rendered tool ledger for this turn — included so the model rewrites from
 * what actually executed (✓ citable / ⚠ produced nothing) rather than from memory.
 */
export function buildNumericGroundingDirective(claim: string, ledger?: string): string {
  const ledgerBlock = ledger
    ? `\n\nThis turn's tool ledger (the ONLY admissible source of empirical facts):\n${ledger}\n`
    : '';
  return (
    `[numeric-grounding] Your draft reports an accomplished computation/verification ("${claim}…") with ` +
    `numeric results, but the tool ledger for this turn shows NO successful compute or exec tool result ` +
    `(no ✓ from pariGp / z3Verify / leanCheck / shell / process). That means these numbers were not ` +
    `produced by any tool — stating them is fabrication, the exact failure mode being corrected.` +
    ledgerBlock +
    `\n**Rewrite your final reply.** Do NOT present any computed value, ratio, norm, spectral radius, ` +
    `angle, or "verified/跑通/数值验证" claim as real. Either (a) actually run the computation now via a ` +
    `compute tool and report ONLY the values it returns, or (b) state honestly that you could not verify ` +
    `it this turn — name what failed and what you would run next — and drop every unbacked number. Keep ` +
    `only claims grounded in a ✓ ledger entry. ` +
    INTERNAL_CORRECTION_FOOTER
  );
}


// ── Model ceiling over the pattern floor ─────────────────────────────────────────────────────────
//
// COMPUTE_CLAIM_RE is a vocabulary list, and in three days it has been one phrase short three times:
// 跑通 was there but 全部通过 was not (2026-07-27); 实际计算 was there but 实际执行 was not (2026-07-29
// 06:45:37, tools=0, reply opening "本轮实际执行：修正会话模式 → PARI/GP 验证假设 A … 结果：假设 A 在 k=6 上被证…"
// — the strongest possible phrasing of "I did this", with nothing behind it, and every gate passed it).
//
// Enumeration will keep losing to paraphrase; that is the treadmill this repo has written down twice.
// So the same floor-and-ceiling shape the session-claim and announced-tool rules already use: a
// DETERMINISTIC window made of facts we own, and inside it one reading-comprehension question for the aux
// model. The window here is strong — this turn ran no successful compute tool, and the reply names a
// compute tool by its own identifier — so a fabricated computation report is nearly the only thing it can
// contain.
//
// The question is what the TEXT asserts, never "did you fabricate". `unknown` on every failure path, so
// an unconfigured or broken aux leaves exactly the pattern floor rather than silently deleting the guard.

export type ComputationClaimVerdict = 'asserts' | 'does_not_assert' | 'unknown';

const CLAIM_SYSTEM = 'You judge what a piece of text asserts. Answer with one word.';

export function buildComputationClaimPrompt(text: string, tools: readonly string[]): string {
  return (
    'Below is an assistant\'s complete reply to its user. Two facts you can rely on: while producing it ' +
    'the assistant successfully ran NO computation or execution tool at all, and the reply mentions ' +
    `${tools.join(', ')}.\n\n` +
    'Judge ONLY what the text says — not whether it is correct, not whether the assistant did well.\n\n' +
    'Question: does the text tell the reader that a computation, verification, enumeration or program run ' +
    'was ACTUALLY CARRIED OUT (by the assistant, in this exchange), and report or rely on its outcome?\n\n' +
    'Answer ASSERTS for "I ran it and got X", "verified on k=6", "the search found no counterexample", ' +
    'and for any conclusion presented as resting on a run that just happened.\n' +
    'Answer DOES_NOT_ASSERT when the text only PROPOSES to compute, explains what a tool would do, ' +
    'reports what it could NOT run, quotes a result from a clearly earlier session while saying so, or ' +
    'discusses the mathematics without claiming to have executed anything.\n\n' +
    'Reply with exactly one word: ASSERTS or DOES_NOT_ASSERT.\n\n' +
    'The reply:\n"""\n' +
    text.slice(0, 3000) +
    '\n"""'
  );
}

export function parseComputationClaimVerdict(raw: string): ComputationClaimVerdict {
  const t = (raw ?? '').trim().toUpperCase();
  if (t.startsWith('ASSERTS')) return 'asserts';
  if (t.startsWith('DOES_NOT_ASSERT')) return 'does_not_assert';
  return 'unknown';
}

/** PHILONT_NUMERIC_ADJUDICATOR=0 disables the ceiling and leaves the pattern floor. */
export function computationClaimAdjudicatorEnabled(): boolean {
  const v = (process.env.PHILONT_NUMERIC_ADJUDICATOR ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** How many results this turn are a SUCCESSFUL compute/exec tool — the window's ground truth. */
export function countOkComputeResults(toolResults: readonly GroundingToolResult[]): number {
  return toolResults.filter((r) => r.content.startsWith('✓') && COMPUTE_TOOLS.has(r.toolName)).length;
}

/** Compute tools named in the text — our own identifiers, matched exactly (PARI/GP included). */
export function computeToolsNamedIn(text: string): string[] {
  return findNamedTools(text, [...COMPUTE_TOOLS]);
}

/**
 * Is the ceiling worth consulting? Both conditions are runtime ground truth, not readings of the text.
 * Outside this window a computation claim either has backing or names nothing we can check.
 */
export function shouldAdjudicateComputationClaim(input: {
  okComputeThisTurn: number;
  namedComputeTools: readonly string[];
  textLength: number;
}): boolean {
  if (!computationClaimAdjudicatorEnabled()) return false;
  if (input.okComputeThisTurn > 0) return false;
  if (input.namedComputeTools.length === 0) return false;
  // A one-line reply has no room to report a run it did not do.
  return input.textLength >= 80;
}

/** Never throws. Returns `unknown` when the judge is unreachable or answers junk. */
export async function adjudicateComputationClaim(
  text: string,
  tools: readonly string[],
  call?: (req: { system: string; user: string; maxTokens?: number }) => Promise<string>,
): Promise<ComputationClaimVerdict> {
  // The model ceiling must obey the same polarity/evidence-time semantics as the deterministic floor.
  if (EXPLICIT_NON_CURRENT_COMPUTE_RE.test(text)) return 'does_not_assert';
  const fn = call ?? (isAuxLLMConfigured() ? callAuxLLM : null);
  if (!fn) return 'unknown';
  try {
    return parseComputationClaimVerdict(
      await fn({ system: CLAIM_SYSTEM, user: buildComputationClaimPrompt(text, tools), maxTokens: 8 }),
    );
  } catch {
    return 'unknown';
  }
}

/** Directive for a claim the ceiling caught — the pattern found no phrase to quote back. */
export function buildAdjudicatedComputationDirective(tools: readonly string[], ledger?: string): string {
  const ledgerBlock = ledger
    ? `\n\nThis turn's tool ledger (the ONLY admissible source of empirical facts):\n${ledger}\n`
    : '';
  return (
    `[numeric-grounding] Your draft reports a computation involving ${tools.join(' / ')} as something that ` +
    `was carried out, and presents or relies on its outcome. This turn's ledger contains NO successful ` +
    `compute or exec result. Nothing ran, so there is no outcome to report.` +
    ledgerBlock +
    `\n**Rewrite your final reply.** Either (a) actually run it now and report ONLY what the tool returns, ` +
    `or (b) say plainly that it has not been run this turn, drop every result presented as obtained, and ` +
    `keep only what a ✓ ledger entry or an explicitly-dated earlier record supports. ` +
    INTERNAL_CORRECTION_FOOTER
  );
}
