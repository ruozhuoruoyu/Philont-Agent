/**
 * PursuitProgressWriter — applies PursuitDriver initiative results to pursuit state.
 *
 * Background: PursuitDriver v1 limitation is that the executor does not write pursuit state.
 * As a result, the same stalled pursuit would be proposed again once the 24h dedup expires,
 * because lastTouchedAt was never refreshed. This module fills that gap:
 *
 *   pursuit:advance-question  done → addEvidence(pursuit, initiative.id) +
 *                                    bumpProgress(pursuit, turn=0, summary)
 *   pursuit:check-resolution  done → bumpProgress only (audit in nature, not counted as evidence)
 *
 * Both operations automatically refresh last_touched_ts (refreshed internally by bumpProgress /
 * addEvidence) and updated_at, so the next PursuitDriver tick won't immediately hit the same pursuit.
 *
 * Not handled here:
 *   - Automatically closing pursuit:check-resolution — even if the LLM marks shouldEscalate=true,
 *     closure is not done here. Closure is a heavy semantic decision, left to SelfReflector / user / LLM.
 *   - Closing openQuestion: same reason — requires strong semantic determination that "the question
 *     has been answered"; this module does not make that call.
 *
 * Factory `pursuitProgressWriter(pursuits)` returns a callback conforming to the OutcomeHook interface;
 * AutonomousLoop calls it after an initiative is persisted as done.
 */

import type { PursuitStore } from '../pursuit.js';
import { PursuitNotFoundError } from '../pursuit.js';
import type {
  Initiative,
  InitiativeRunResult,
  OutcomeHook,
} from './types.js';

/** Extracts pursuit id from targetRef. Returns null if not pursuit-shaped. */
export function parsePursuitTargetRef(targetRef: string): {
  pursuitId: string;
  kind: 'question' | 'resolve' | 'other';
  questionId?: string;
} | null {
  // pursuit:<id>:q:<qid>
  const q = targetRef.match(/^pursuit:([^:]+):q:(.+)$/);
  if (q) return { pursuitId: q[1], kind: 'question', questionId: q[2] };
  // pursuit:<id>:resolve
  const r = targetRef.match(/^pursuit:([^:]+):resolve$/);
  if (r) return { pursuitId: r[1], kind: 'resolve' };
  // pursuit:<id> — CuriosityDriver's dormant-pursuit branch. Credited via the cross-driver path in
  // applyPursuitProgress (evidence + touch only; no question/resolve semantics).
  const p = targetRef.match(/^pursuit:([^:]+)$/);
  if (p) return { pursuitId: p[1], kind: 'other' };
  return null;
}

/** Maximum safe iteration count for active research: if the question still isn't answered after this many advances, force convergence back to a normal pursuit. */
export const MAX_RESEARCH_ITERATIONS = 20;

/**
 * v24: Active research convergence. Only applies to isActiveResearch pursuits:
 *   - research_iterations += 1
 *   - If the iteration cap MAX_RESEARCH_ITERATIONS is reached, or there are no open questions
 *     left (all answered) → clear isActiveResearch (fall back to a normal pursuit;
 *     loop no longer actively advances it every tick).
 * The pursuit itself is **not** closed (closure is a heavy semantic decision, left to LLM / user).
 * Non-active-research pursuits: no-op.
 */
function maybeConvergeActiveResearch(pursuits: PursuitStore, pursuitId: string): void {
  const p = pursuits.get(pursuitId);
  if (!p || !p.isActiveResearch) return;
  const iters = pursuits.bumpResearchIterations(pursuitId);
  const fresh = pursuits.get(pursuitId);
  const noOpenLeft = !fresh || fresh.openQuestions.every((q) => q.status !== 'open');
  if (iters >= MAX_RESEARCH_ITERATIONS || noOpenLeft) {
    pursuits.setActiveResearch(pursuitId, false);
  }
}

export interface ApplyResult {
  applied: boolean;
  reason:
    | 'wrong_driver'
    | 'unparseable_target'
    | 'not_done'
    | 'pursuit_not_found'
    | 'applied_question'
    | 'applied_grant_request'
    | 'applied_resolve'
    | 'applied_cross_driver'
    | 'pursuit_gone';
}

/**
 * Applies a single done initiative to a pursuit. Synchronous, pure DB writes, no LLM.
 *
 * Does not throw — situations like a missing pursuit return a reason so the caller can decide whether to log.
 */
export function applyPursuitProgress(
  pursuits: PursuitStore,
  initiative: Initiative,
  result: InitiativeRunResult,
): ApplyResult {
  if (result.status !== 'done') {
    return { applied: false, reason: 'not_done' };
  }

  // Cross-driver credit: work on a pursuit counts whoever proposed it.
  //
  // The driver filter below used to be the FIRST check, which meant the curiosity driver's two
  // pursuit-shaped branches — dormant pickup (`pursuit:<id>`) and goal-loop promotion
  // (`goal-loop:pursuit:<id>`) — completed real initiatives that were then recorded nowhere. Production
  // 2026-07-23: the owner's compass focus was picked up at 14:02, the initiative ran and produced a
  // discovery, and the daily self-check still reported "1 个焦点中推进了 0 个" — because last_touched never
  // moved, which ALSO made the dormancy branch re-propose the same pursuit the next day. The ledger
  // disagreed with the work, and both the health report and the scheduler read the ledger.
  //
  // The judgement is by TARGET, not by sender: a completed initiative whose targetRef names a pursuit
  // advanced that pursuit, whoever proposed it. (Same direction as the from_disk fix: decide by what a
  // thing IS, not by which component it came from.) Only the minimal credit is applied here — evidence +
  // progress touch; question/resolve semantics stay exclusive to the pursuit driver below, which is the
  // only producer that constructs those refs.
  if (initiative.driver !== 'pursuit') {
    const cross = initiative.targetRef.match(/^(?:goal-loop:)?pursuit:([^:]+)$/);
    if (!cross) return { applied: false, reason: 'wrong_driver' };
    const summary = (result.outcomeSummary ?? initiative.rationale).slice(0, 200);
    try {
      pursuits.addEvidence(cross[1], `autonomous:initiative-${initiative.id}`);
      pursuits.bumpProgress(cross[1], 0, summary, null);
      return { applied: true, reason: 'applied_cross_driver' };
    } catch (e) {
      if (e instanceof PursuitNotFoundError) return { applied: false, reason: 'pursuit_gone' };
      throw e;
    }
  }

  const parsed = parsePursuitTargetRef(initiative.targetRef);
  if (!parsed || parsed.kind === 'other') {
    return { applied: false, reason: 'unparseable_target' };
  }

  const summary = (result.outcomeSummary ?? initiative.rationale).slice(0, 200);
  const tag = `autonomous:initiative-${initiative.id}`;

  try {
    if (parsed.kind === 'question') {
      // Active research "request permission": executor reported needs-grant (must use an unauthorized
      // tool to continue answering) → record the request in question.pendingTool; does **not** count
      // as evidence and does **not** bumpProgress (nothing was actually advanced, just a request;
      // last_touched is also not refreshed to avoid falsely indicating progress).
      // After the user grants access, the driver will replay this question next tick, and only
      // that executor run will follow the normal evidence/close path.
      if (result.needsGrant === true && result.requestedTool && parsed.questionId) {
        try {
          pursuits.setQuestionPendingTool(parsed.pursuitId, parsed.questionId, result.requestedTool);
        } catch (e) {
          if (!(e instanceof PursuitNotFoundError)) throw e;
        }
        return { applied: true, reason: 'applied_grant_request' };
      }

      // advance-question: counts as both evidence and a progress marker
      pursuits.addEvidence(parsed.pursuitId, tag);
      pursuits.bumpProgress(parsed.pursuitId, 0, summary, null);

      // v24 convergence: LLM determined the question has been answered → close it
      // (question id is implied by targetRef; LLM only gives yes/no, no need to echo id).
      if (result.questionAnswered === true && parsed.questionId) {
        try {
          pursuits.closeOpenQuestion(parsed.pursuitId, parsed.questionId, 'resolved', tag, 0);
        } catch (e) {
          if (!(e instanceof PursuitNotFoundError)) throw e;
        }
      }

      // v24 active research convergence check: only for isActiveResearch pursuits — count iterations and stop when cap is reached or all questions answered.
      maybeConvergeActiveResearch(pursuits, parsed.pursuitId);

      return { applied: true, reason: 'applied_question' };
    }
    // resolve: only add a progress marker (check-resolution is audit in nature, not counted as evidence)
    pursuits.bumpProgress(parsed.pursuitId, 0, summary, null);
    return { applied: true, reason: 'applied_resolve' };
  } catch (e) {
    if (e instanceof PursuitNotFoundError) {
      return { applied: false, reason: 'pursuit_not_found' };
    }
    throw e;
  }
}

/**
 * Factory: binds PursuitStore to produce an OutcomeHook.
 *
 * AutonomousLoop calls the hook after markDone; failures are only logged and do not affect the main flow.
 */
export function pursuitProgressWriter(
  pursuits: PursuitStore,
  logger?: { log: (m: string) => void; warn: (m: string) => void },
): OutcomeHook {
  const log = logger ?? {
    log: (m) => console.log(`[pursuit-writer] ${m}`),
    warn: (m) => console.warn(`[pursuit-writer] ${m}`),
  };
  return (initiative, result) => {
    try {
      const r = applyPursuitProgress(pursuits, initiative, result);
      if (r.applied) {
        log.log(
          `applied ${r.reason} initiative=${initiative.id} target=${initiative.targetRef}`,
        );
      } else if (r.reason === 'pursuit_not_found') {
        log.warn(`pursuit gone: target=${initiative.targetRef}`);
      }
      // Other reasons (wrong_driver / unparseable_target / not_done) are normal branches;
      // no log needed
    } catch (e) {
      log.warn(`apply threw error for initiative=${initiative.id}: ${String(e)}`);
    }
  };
}
