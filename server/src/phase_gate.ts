/**
 * Phase transition gate (diverge/converge × domain redesign — Phase C).
 *
 * Pure + dependency-free (mirrors viability_gate.ts) so it unit-tests trivially. The caller
 * (runDivergeRound / runRound in deep_explore) gathers the tree-derived materials and passes them
 * in; this decides the phase the NEXT round should run.
 *
 * This is the ONE hard, ASYMMETRIC control point of the whole redesign:
 *   - DEFAULT stays diverge. converge must EARN its turn: premature convergence destroys the
 *     candidate space (the asymmetric cost), so converge requires the space to be POPULATED
 *     (≥ MIN_CANDIDATES viable candidates) AND generation to have SATURATED (≥ idle rounds with no
 *     NET-new candidate). A decision goal only RELAXES the saturation bar (to 1 idle round) — it
 *     never bypasses it, so we never converge on the very first productive round.
 *   - The only backward edge converge→diverge is the high bar `convergeAllDead` (every candidate
 *     was eliminated → the space was too small, regenerate). No other backward edge → no thrash.
 *
 * Inert unless PHILONT_DEEP_EXPLORE_PHASES is on (the caller guards the call).
 */

import type { ReasoningPhase, ReasoningSessionMode } from '@agent/memory';

/** Minimum viable candidates before converge may even be considered (space must be populated). */
export const MIN_CANDIDATES = 3;
/** Diverge idle rounds (no NET-new viable candidate) that count as "saturated" for open ideation. */
export const SATURATED_IDLE = 2;
/**
 * Under decision pressure the saturation bar is relaxed to this — but NEVER 0: at least one idle
 * round must pass, so a decision goal still gets a round of breadth and never converges on round 1.
 */
export const SATURATED_IDLE_DECISION = 1;

export interface PhaseInput {
  /** The phase the just-finished round ran in. */
  phase: ReasoningPhase;
  /** Open candidate nodes (construction/conjecture, not refuted/dead) currently alive. */
  viableCandidates: number;
  /** Consecutive diverge rounds with no NET-new viable candidate (saturation signal). */
  divergeIdleRounds: number;
  /** The goal requires picking ONE answer (decision/diagnosis) vs open-ended ideation. */
  needsDecision: boolean;
  /** In converge: every candidate has been eliminated (none open, none proved) → reopen generation. */
  convergeAllDead: boolean;
}

export interface PhaseDecision {
  phase: ReasoningPhase;
  changed: boolean;
  reason: string;
}

export function decidePhaseTransition(i: PhaseInput): PhaseDecision {
  if (i.phase === 'diverge') {
    if (i.viableCandidates < MIN_CANDIDATES) {
      return {
        phase: 'diverge',
        changed: false,
        reason: `space not yet populated (${i.viableCandidates}/${MIN_CANDIDATES} viable candidates) — keep generating`,
      };
    }
    const idleNeeded = i.needsDecision ? SATURATED_IDLE_DECISION : SATURATED_IDLE;
    if (i.divergeIdleRounds >= idleNeeded) {
      return {
        phase: 'converge',
        changed: true,
        reason: i.needsDecision
          ? `${i.viableCandidates} candidates gathered and a decision is needed (generation idle ${i.divergeIdleRounds} round(s)) — switch to evaluation`
          : `${i.viableCandidates} candidates gathered and generation has saturated (idle ${i.divergeIdleRounds} round(s)) — switch to evaluation`,
      };
    }
    return {
      phase: 'diverge',
      changed: false,
      reason: `${i.viableCandidates} candidates but generation is still productive (idle ${i.divergeIdleRounds}/${idleNeeded}) — keep opening the space`,
    };
  }

  // converge — the only backward edge is the high bar "all candidates eliminated".
  if (i.convergeAllDead) {
    return {
      phase: 'diverge',
      changed: true,
      reason: 'every candidate was eliminated — reopening generation for fresh options',
    };
  }
  return { phase: 'converge', changed: false, reason: 'continue evaluating' };
}

/**
 * Lightweight goal-shape heuristic for `needsDecision` (Phase C placeholder; Phase E's classifyGoal
 * will supersede it). Formal goals are inherently convergent (a theorem is to be PROVED). A deliberate
 * goal needs a decision when it is a choice/diagnosis ("should I", "which", "该不该", "root cause");
 * pure ideation ("ways to", "ideas for", "有哪些") does not. Neutral deliberate goals default to true
 * (a hard open-ended question usually wants a conclusion) — but converge is still gated on saturation.
 */
export function goalNeedsDecision(goal: string, mode: 'formal' | 'deliberate'): boolean {
  if (mode === 'formal') return true;
  const g = goal.toLowerCase();
  const decisionCues = [
    'should i', 'should we', 'which ', 'whether ', 'decide', 'choose', 'pick ', 'better',
    'diagnos', 'root cause', 'why is', 'why did', 'is it worth',
    '该不该', '要不要', '是否', '选哪', '哪个', '诊断', '为什么', '值不值', '值得',
  ];
  const ideationCues = [
    'ways to', 'ideas for', 'brainstorm', 'options for', 'what are', 'explore the', 'possible',
    '有哪些', '头脑风暴', '点子', '可能的', '探索',
  ];
  if (decisionCues.some((c) => g.includes(c))) return true; // decision cues win ties
  if (ideationCues.some((c) => g.includes(c))) return false;
  return true;
}

/**
 * Does a goal read as a DEDUCTIVE (formal-math) target — a theorem/conjecture to be PROVED — vs an
 * empirical real-world question? Pure, conservative; the explicit `mode` param always overrides.
 */
export function looksDeductive(goal: string): boolean {
  const g = goal.toLowerCase();
  const cues = [
    'prove', 'proof of', 'conjecture', 'theorem', 'lemma', 'show that', 'p=np', 'p vs np', 'p versus np',
    'for all n', 'for every n', 'there exists', 'integer', 'integers', 'prime', 'primes', 'divisib',
    'modulo', 'q.e.d', 'riemann', 'goldbach', 'twin prime', 'irrational', 'inequality holds',
    '证明', '求证', '试证', '猜想', '定理', '引理', '素数', '整除', '不等式', '恒成立',
  ];
  if (cues.some((c) => g.includes(c))) return true;
  // Math symbols are a strong deductive signal.
  return /[∀∃∑∏∫≤≥≠≡⇒⇔√∞]/.test(goal);
}

/** Is a goal open-ended GENERATIVE (start in diverge: brainstorm/options) vs a stated target (converge)? */
export function isGenerativeGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  const cues = [
    'what are', 'ways to', 'ideas for', 'options for', 'brainstorm', 'explore the', 'possible ',
    'list of', 'approaches to', 'alternatives',
    '有哪些', '头脑风暴', '点子', '可能的', '探索', '罗列', '各种', '哪些方案', '哪些办法',
  ];
  return cues.some((c) => g.includes(c));
}

/**
 * Start-time goal classification (Phase E): infer the session's domain (mode) and initial phase from
 * the goal text, used when the caller did not pass them explicitly. Pure + deterministic — a default,
 * not an oracle; the explicit `mode`/`phase` params on `start` always win. Inert unless phases are on.
 *   - mode: deductive → 'formal', else 'deliberate'.
 *   - initialPhase: an open-ended generative goal starts in 'diverge'; a stated target/decision in
 *     'converge' (the back-compat default — today's `start` runs a converge/prove round).
 */
export function classifyGoal(goal: string): { mode: ReasoningSessionMode; initialPhase: ReasoningPhase } {
  return {
    mode: looksDeductive(goal) ? 'formal' : 'deliberate',
    initialPhase: isGenerativeGoal(goal) ? 'diverge' : 'converge',
  };
}
