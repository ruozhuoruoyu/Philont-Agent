/**
 * phase_gate (Phase C) — transition truth table. This is the one asymmetric control point, so the
 * tests concentrate here: converge must EARN its turn; the only backward edge is "all dead".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePhaseTransition,
  goalNeedsDecision,
  looksDeductive,
  isGenerativeGoal,
  classifyGoal,
  MIN_CANDIDATES,
  MAX_CANDIDATES,
  MAX_CANDIDATES_DECISION,
  SATURATED_IDLE,
  SATURATED_IDLE_DECISION,
} from '../src/phase_gate.js';

const diverge = (over: Partial<Parameters<typeof decidePhaseTransition>[0]> = {}) =>
  decidePhaseTransition({
    phase: 'diverge',
    viableCandidates: MIN_CANDIDATES,
    divergeIdleRounds: 0,
    needsDecision: false,
    convergeAllDead: false,
    ...over,
  });

test('diverge: under-populated space never converges (asymmetric default = keep generating)', () => {
  for (let c = 0; c < MIN_CANDIDATES; c++) {
    const d = diverge({ viableCandidates: c, divergeIdleRounds: 99, needsDecision: true });
    assert.equal(d.phase, 'diverge');
    assert.equal(d.changed, false);
  }
});

test('diverge: populated but still productive (idle below bar) stays diverge', () => {
  // ideation: needs SATURATED_IDLE idle rounds
  assert.equal(diverge({ viableCandidates: 5, divergeIdleRounds: SATURATED_IDLE - 1, needsDecision: false }).phase, 'diverge');
  // decision: needs SATURATED_IDLE_DECISION; idle 0 is still below it → never converges on round 1
  assert.equal(diverge({ viableCandidates: 5, divergeIdleRounds: 0, needsDecision: true }).phase, 'diverge');
});

test('diverge: populated + saturated → converge (decision relaxes the idle bar but never to 0)', () => {
  assert.equal(SATURATED_IDLE_DECISION >= 1, true, 'decision bar is at least one idle round');
  const dec = diverge({ viableCandidates: 4, divergeIdleRounds: SATURATED_IDLE_DECISION, needsDecision: true });
  assert.equal(dec.phase, 'converge');
  assert.equal(dec.changed, true);
  const ide = diverge({ viableCandidates: 4, divergeIdleRounds: SATURATED_IDLE, needsDecision: false });
  assert.equal(ide.phase, 'converge');
  assert.equal(ide.changed, true);
});

test('diverge: a decision goal converges SOONER than open ideation at the same idle level', () => {
  // At idle = SATURATED_IDLE_DECISION, decision converges but ideation (needing more) does not.
  const at = SATURATED_IDLE_DECISION;
  if (SATURATED_IDLE > SATURATED_IDLE_DECISION) {
    assert.equal(diverge({ viableCandidates: 4, divergeIdleRounds: at, needsDecision: true }).phase, 'converge');
    assert.equal(diverge({ viableCandidates: 4, divergeIdleRounds: at, needsDecision: false }).phase, 'diverge');
  }
});

test('diverge: ceiling forces converge even when every round is productive (idle never accrues)', () => {
  // The runaway: a productive diverge round resets the idle counter, so idle stays 0 forever. Without
  // the ceiling this never converges (observed: 45 hypotheses, 5 rounds). The ceiling must fire anyway.
  const dec = diverge({ viableCandidates: MAX_CANDIDATES_DECISION, divergeIdleRounds: 0, needsDecision: true });
  assert.equal(dec.phase, 'converge');
  assert.equal(dec.changed, true);
  const ide = diverge({ viableCandidates: MAX_CANDIDATES, divergeIdleRounds: 0, needsDecision: false });
  assert.equal(ide.phase, 'converge');
  assert.equal(ide.changed, true);
});

test('diverge: a decision goal hits its (tighter) ceiling before open ideation does', () => {
  assert.equal(MAX_CANDIDATES_DECISION <= MAX_CANDIDATES, true, 'decision ceiling is no looser than ideation');
  // At the decision ceiling: a decision goal converges, but ideation (wider ceiling, idle still 0) does not.
  if (MAX_CANDIDATES_DECISION < MAX_CANDIDATES) {
    assert.equal(diverge({ viableCandidates: MAX_CANDIDATES_DECISION, divergeIdleRounds: 0, needsDecision: true }).phase, 'converge');
    assert.equal(diverge({ viableCandidates: MAX_CANDIDATES_DECISION, divergeIdleRounds: 0, needsDecision: false }).phase, 'diverge');
  }
});

test('diverge: the floor still gates the ceiling (no converge below MIN_CANDIDATES)', () => {
  // Pathological config where the ceiling would be below the floor must never fire under the floor.
  assert.equal(MAX_CANDIDATES_DECISION >= MIN_CANDIDATES, true, 'ceiling sits above the floor by construction');
  const d = diverge({ viableCandidates: MIN_CANDIDATES - 1, divergeIdleRounds: 0, needsDecision: true });
  assert.equal(d.phase, 'diverge');
});

test('converge: stays converge normally; only "all dead" reopens generation (no thrash)', () => {
  assert.equal(
    decidePhaseTransition({ phase: 'converge', viableCandidates: 2, divergeIdleRounds: 9, needsDecision: true, convergeAllDead: false }).phase,
    'converge',
  );
  const reopen = decidePhaseTransition({ phase: 'converge', viableCandidates: 0, divergeIdleRounds: 9, needsDecision: true, convergeAllDead: true });
  assert.equal(reopen.phase, 'diverge');
  assert.equal(reopen.changed, true);
});

test('goalNeedsDecision: formal always true; deliberate by goal shape', () => {
  assert.equal(goalNeedsDecision('prove P=NP', 'formal'), true);
  assert.equal(goalNeedsDecision('该不该接这个 offer', 'deliberate'), true);
  assert.equal(goalNeedsDecision('should I take this job', 'deliberate'), true);
  assert.equal(goalNeedsDecision('root cause of the outage', 'deliberate'), true);
  // pure ideation → no decision pressure
  assert.equal(goalNeedsDecision('ideas for a weekend project', 'deliberate'), false);
  assert.equal(goalNeedsDecision('有哪些可能的增长方向', 'deliberate'), false);
  // neutral deliberate defaults to needing a conclusion
  assert.equal(goalNeedsDecision('the market for X', 'deliberate'), true);
});

// ── Phase E: start-time goal classification (domain + initial phase) ─────────────────────────────

test('looksDeductive: math/proof goals true; real-world false', () => {
  assert.equal(looksDeductive('prove the twin prime conjecture'), true);
  assert.equal(looksDeductive('证明 n 为素数时 f(n) 为合数'), true);
  assert.equal(looksDeductive('∀n∈ℕ, P(n) 成立'), true);
  assert.equal(looksDeductive('该不该接这个 offer'), false);
  assert.equal(looksDeductive('ways to reduce customer churn'), false);
});

test('isGenerativeGoal: open-ended generation true; stated target false', () => {
  assert.equal(isGenerativeGoal('what are my options for growth'), true);
  assert.equal(isGenerativeGoal('有哪些可能的增长方向'), true);
  assert.equal(isGenerativeGoal('should I take this job'), false);
  assert.equal(isGenerativeGoal('prove P=NP'), false);
});

test('classifyGoal: domain + initial phase', () => {
  assert.deepEqual(classifyGoal('prove the twin prime conjecture'), { mode: 'formal', initialPhase: 'converge' });
  assert.deepEqual(classifyGoal('what are ways to reduce churn'), { mode: 'deliberate', initialPhase: 'diverge' });
  assert.deepEqual(classifyGoal('该不该接这个 offer'), { mode: 'deliberate', initialPhase: 'converge' });
});

test('looksDeductive: a proof REQUEST, not any message with a math noun (prod-shaped)', async () => {
  const { looksDeductive } = await import('../src/phase_gate.js');
  // Ordinary programming words that used to route into the formal proof engine.
  for (const t of [
    'how do I store integers in sqlite',
    'the modulo operator in JS behaves oddly',
    '素数筛法怎么写代码',
    '这个整除运算符怎么用',
    '不等式怎么在前端画出来',
  ]) {
    assert.equal(looksDeductive(t), false, `a math noun is not a proof request: ${t}`);
  }
  // Real deductive targets still route formal.
  for (const t of [
    'prove that every even n > 2 is a sum of two primes',
    '证明这个引理', '求证：n 为素数时恒成立', 'the Goldbach conjecture', 'disprove the theorem',
    '∀n ∃m such that…',
  ]) {
    assert.equal(looksDeductive(t), true, `must be deductive: ${t}`);
  }
});
