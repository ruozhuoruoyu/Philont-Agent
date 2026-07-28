/**
 * Claim grounding — ONE evaluator over the turn ledger, replacing four separately-wired gates.
 *
 * ── why this module exists ────────────────────────────────────────────────────────────────────────
 *
 * Four gates grew up separately and were asking versions of the same question: *the text asserts X — does
 * the ledger support X?*
 *
 *   session_claim   a reasoning session exists / advanced   vs   the reasoning store
 *   citation        arXiv:NNNN.NNNNN says Y                 vs   what was actually retrieved
 *   numeric         I ran it, here are the numbers          vs   successful compute/exec results
 *   announced_tool  I am about to call T                    vs   the tools actually called
 *
 * Each carried its own env switch, its own audit append, its own recordControllerFire, its own
 * assistant+directive message push, and its own regeneration. Each was then hand-wired at some subset of
 * the three places a turn can emit final text. The subset was never the same twice, and the drift was
 * invisible — the registry lists eleven controllers, but which ones ran depended on which exit the turn
 * took. Measured 2026-07-28, before this module:
 *
 *              zero-tool  tool-loop  maxIter-fallback
 *   honesty        ✓          ✓            ✗
 *   numeric        ✓          ✓            ✗
 *   announced      ✓          ✓            ✗
 *   citation       ✗          ✓            ✗
 *   empty_concl    ✗          ✓            ✗
 *   half_finished  ✗          ✓            ✗
 *   output_format  ✗          ✓            ✗
 *   viability      ✗          ✓            ✗
 *
 * Three defects were shipped in three days out of that table alone — the numeric gate missing from the
 * zero-tool path, the session-claim adjudicator missing from it, output_format never seeing a short
 * reply. Each was fixed by hand-wiring one more gate into one more site, which is the move that built
 * the table in the first place.
 *
 * So: one ordered chain, one call, one regeneration. Adding a rule is a list entry, not a wiring
 * expedition, and it is impossible for a rule to exist on one exit and not another.
 *
 * ── what this deliberately does NOT absorb ────────────────────────────────────────────────────────
 *
 * The honesty gate stays where it is. It is not a ledger predicate: it owns a cross-turn session latch,
 * a repeat-offence ladder that removes the apology exit on a second violation, and a regeneration that
 * can hand control to the tool loop. Folding it in would mean reproducing that state machine here for no
 * gain — it already runs at both interactive exits. The session-claim rule below used to be reported AS
 * an honesty verdict, so it still reports `armsHonestyLatch` and the caller feeds the latch exactly as
 * before; moving the wiring must not quietly disarm the counter that escalates repeat offenders.
 *
 * empty_conclusion / half_finished / output_format / viability are shape-and-counsel gates, not claim
 * checks; unifying the emit path itself is a separate piece of work.
 */

import { detectUngroundedComputation, buildNumericGroundingDirective, type GroundingToolResult } from './numeric_grounding_gate.js';
import { detectUngroundedArxivCitation, buildCitationGroundingDirective, type GroundingMessage } from './citation_gate.js';
import {
  adjudicateSessionClaim,
  shouldAdjudicateSessionClaim,
} from './session_claim_adjudicator.js';
import {
  announcedToolGateEnabled,
  detectAnnouncedToolStall,
  buildAnnouncedToolDirective,
} from './announced_tool_gate.js';

/** Controller ids, matching controller_registry.ts so recordControllerFire stays meaningful. */
export type ClaimGroundingRule =
  | 'session_claim'
  | 'citation_grounding'
  | 'numeric_grounding'
  | 'announced_tool';

export interface ClaimGroundingContext {
  /** The final text about to be emitted. */
  text: string;
  /** This turn's tool results, ✓/⚠-prefixed (extractRecentToolResults). */
  toolResults: GroundingToolResult[];
  /** The conversation, for the citation rule: an id is grounded iff it appears in a user-role message. */
  messages: GroundingMessage[];
  /** Tool names offered to the model this turn. */
  toolNames: readonly string[];
  /** Tool names actually invoked this turn (from the turn ledger). */
  calledToolNames: readonly string[];
  /** Ground truth from the reasoning store, not read off the text. */
  hasActiveReasoningSession: boolean;
  deepExploreSucceededThisTurn: boolean;
  /** This turn's ledger rendered for prompt injection, so the regen rewrites from what executed. */
  renderedLedger?: string;
}

export interface ClaimGroundingFinding {
  rule: ClaimGroundingRule;
  /** The offending phrase, for the log and the audit row. */
  claim: string;
  /** The intra-turn rewrite instruction pushed as a user message. */
  directive: string;
  /** Console line (the caller prefixes the session). */
  log: string;
  /** Rule-specific audit fields, merged into the audit row. */
  audit: Record<string, unknown>;
  /** Close the turn as `could_not_verify` rather than a plain response (numeric). */
  armsCouldNotVerify?: boolean;
  /** Count toward the honesty session latch — preserved from when this WAS an honesty verdict. */
  armsHonestyLatch?: boolean;
}

/**
 * Evaluate the chain and return the FIRST finding, or null.
 *
 * Order is the pre-merge precedence, kept deliberately: the session-claim rule ran inside the honesty
 * gate and therefore ahead of everything; citation preceded numeric preceded announced in the tool loop.
 * Changing the order would change which directive a doubly-offending draft receives, which is a
 * behaviour change with no argument behind it.
 *
 * Never throws: a rule that fails is a rule that found nothing, and the reply goes out as it would have.
 */
export async function evaluateClaimGrounding(
  ctx: ClaimGroundingContext,
): Promise<ClaimGroundingFinding | null> {
  // ── session_claim ──────────────────────────────────────────────────────────────────────────────
  // Deterministic window (no session exists, no deep_explore succeeded) then one aux reading-
  // comprehension question. Outside the window a claim about a session cannot be a fabrication.
  try {
    if (
      shouldAdjudicateSessionClaim({
        hasActiveSession: ctx.hasActiveReasoningSession,
        deepExploreSucceededThisTurn: ctx.deepExploreSucceededThisTurn,
        textLength: ctx.text.length,
      }) &&
      (await adjudicateSessionClaim(ctx.text)) === 'asserts'
    ) {
      return {
        rule: 'session_claim',
        claim: '(adjudicated)',
        log: 'adjudicator caught a session claim the patterns missed',
        audit: { reason: 'fabricated_reasoning_session' },
        armsHonestyLatch: true,
        directive:
          '[drive Honesty/fabricated_reasoning_session] You stated that a reasoning session exists or ' +
          'advanced, but there is no active session and no deep_explore call succeeded this turn. If the ' +
          'call failed, say so and why; if you want one, call deep_explore(action=start). Do not describe ' +
          'rounds, frontiers or evaluations that did not happen.\n\n' +
          '**Rewrite your final reply** without the session narration, or call deep_explore now and report ' +
          'what it actually returns. This is an intra-turn internal correction; do not surface this ' +
          'reminder to the user.',
      };
    }
  } catch {
    /* a rule that fails found nothing */
  }

  // ── citation_grounding ─────────────────────────────────────────────────────────────────────────
  try {
    if (process.env.PHILONT_CITATION_GATE !== '0') {
      const id = detectUngroundedArxivCitation(ctx.text, ctx.messages);
      if (id) {
        return {
          rule: 'citation_grounding',
          claim: id,
          log: `fired: arXiv:${id} appears in no retrieved source`,
          audit: { arxivId: id },
          directive: buildCitationGroundingDirective(id),
        };
      }
    }
  } catch {
    /* ignore */
  }

  // ── numeric_grounding ──────────────────────────────────────────────────────────────────────────
  try {
    if (process.env.PHILONT_NUMERIC_GATE !== '0') {
      const ungrounded = detectUngroundedComputation(ctx.text, ctx.toolResults);
      if (ungrounded) {
        return {
          rule: 'numeric_grounding',
          claim: ungrounded.claim,
          log: `fired: computation claim "${ungrounded.claim}" with 0 successful compute/exec tools`,
          audit: { claim: ungrounded.claim, okCompute: ungrounded.okCompute },
          armsCouldNotVerify: true,
          directive: buildNumericGroundingDirective(ungrounded.claim, ctx.renderedLedger),
        };
      }
    }
  } catch {
    /* ignore */
  }

  // ── announced_tool ─────────────────────────────────────────────────────────────────────────────
  try {
    if (announcedToolGateEnabled()) {
      const stall = await detectAnnouncedToolStall({
        finalText: ctx.text,
        toolNames: ctx.toolNames,
        calledToolNames: ctx.calledToolNames,
      });
      if (stall.window.length && !stall.verdict) {
        // Visibility is the point of the window: a miss must be readable, not silent.
        return {
          rule: 'announced_tool',
          claim: '',
          log: `window=[${stall.window.join(',')}] uncalled → no fire (${stall.note})`,
          audit: {},
          directive: '',
        };
      }
      if (stall.verdict) {
        return {
          rule: 'announced_tool',
          claim: stall.verdict.quote,
          log: `window=[${stall.window.join(',')}] uncalled → PENDING "${stall.verdict.quote}"`,
          audit: { announcedTool: stall.verdict.toolName, quote: stall.verdict.quote },
          directive: buildAnnouncedToolDirective(stall.verdict),
        };
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/** A finding with an empty directive is a log-only observation, not a gate fire. */
export function isGroundingFire(f: ClaimGroundingFinding | null): f is ClaimGroundingFinding {
  return !!f && f.directive.length > 0;
}
