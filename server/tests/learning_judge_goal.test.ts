/**
 * What the learning judge scores a turn against.
 *
 * Production 2026-07-22: three verdicts in one session, all could_not_verify, one of them saying why in as
 * many words — 'The goal "ok" is too vague to determine what constitutes success'. "ok" was the reply to an
 * authorization card, not the task. The damage is directional: an execute-class tool is precisely what
 * raises an auth card, so the resumed turns are the ones carrying the most tool evidence — the highest
 * signal in the sample, poisoned wholesale. Phase 2 is gated on this distribution being trustworthy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExternalAcceptanceNode,
  isPureCompileAcceptanceNode,
  extractFormalVerificationEvidence,
  formalEvidenceAppliesToClaims,
  resolveJudgeGoal,
  resolveRecallInput,
  selectCompileAcceptanceNode,
  selectJudgeFrontierGoal,
} from '../src/chat-handler.js';

test('a fresh turn is judged against the user message', () => {
  assert.equal(resolveJudgeGoal(undefined, 'extract page 6-20 of the paper', false), 'extract page 6-20 of the paper');
});

test('formal evidence accepts real Lean builds but rejects version probes and generic shell success', () => {
  const scoped = extractFormalVerificationEvidence(
      'shell',
      { command: 'lake build Lrc.K13.Region3Sum' },
      { success: true, output: 'Built Lrc.K13.Region3Sum\nREGION3SUM-OK' },
    ) ?? '';
  assert.match(scoped, /^\[scope=target:Lrc\.K13\.Region3Sum\]/);
  assert.equal(formalEvidenceAppliesToClaims(scoped, ['Compile and prove Region3Sum']), true);
  assert.equal(formalEvidenceAppliesToClaims(scoped, ['Prove an unrelated Fourier bound']), false);
  const projectBuild = extractFormalVerificationEvidence(
    'shell', { command: 'lake build' }, { success: true, output: 'Build completed' },
  ) ?? '';
  assert.equal(formalEvidenceAppliesToClaims(projectBuild, ['Prove theorem foo']), false);
  assert.equal(formalEvidenceAppliesToClaims(projectBuild, ['Compile the whole project']), true);
  assert.equal(formalEvidenceAppliesToClaims(projectBuild, ['argmin_collapse \u7f16\u8bd1\u901a\u8fc7']), true);
  assert.equal(formalEvidenceAppliesToClaims(projectBuild, ['Lrc \u7684\u8bc1\u660e\u7f16\u8bd1\u901a\u8fc7']), true);
  assert.equal(formalEvidenceAppliesToClaims(projectBuild, ['region3_sum_bound_core \u5df2\u8bc1\u660e']), false);
  assert.equal(
    extractFormalVerificationEvidence('shell', { command: 'lean --version' }, { success: true, output: 'Lean 4' }),
    null,
  );
  assert.equal(
    extractFormalVerificationEvidence('shell', { command: 'echo ok' }, { success: true, output: 'ok' }),
    null,
  );
});

test('compile evidence auto-reconciles only one explicit matching acceptance node', () => {
  const nodes = [
    { id: 'root', parentId: null, status: 'open', claim: 'prove the theorem', depth: 0 },
    { id: 'compile', parentId: 'root', status: 'open', claim: '验收：用户在本机执行 lake build Lrc.K13.Region3Sum', depth: 1 },
    { id: 'math', parentId: 'root', status: 'open', claim: 'Prove Region3Sum lower bound', depth: 1 },
  ] as any;
  const evidence = '[scope=file:Lrc/K13/Region3Sum.lean] shell: lake env lean Lrc/K13/Region3Sum.lean → exit 0';
  assert.equal(selectCompileAcceptanceNode(nodes, evidence)?.id, 'compile');
  assert.equal(selectCompileAcceptanceNode([
    { id: 'root', parentId: null, status: 'open', claim: 'root', depth: 0 },
    { id: 'mixed', parentId: 'root', status: 'open', claim: 'region3_strict 成立，且 Region3Sum.lean 编译通过', depth: 1 },
  ] as any, evidence), null, 'a compiler run must never auto-prove a mixed mathematical assertion');
  assert.equal(selectCompileAcceptanceNode([
    { id: 'root', parentId: null, status: 'open', claim: 'root', depth: 0 },
    { id: 'mixed', parentId: 'root', status: 'open', claim: '验收：region3_strict 成立，且 Region3Sum.lean 编译通过', depth: 1 },
  ] as any, evidence), null, 'an acceptance prefix must not launder a mathematical assertion into proved');
  assert.equal(selectCompileAcceptanceNode(nodes, 'leanCheck: verified successfully'), null, 'unscoped proof evidence needs the reasoner');
  assert.equal(selectCompileAcceptanceNode([
    ...nodes,
    { id: 'compile2', parentId: 'root', status: 'open', claim: '验收：用户在本机执行 Region3Sum compile', depth: 1 },
  ] as any, evidence), null, 'ambiguous matches stay open for explicit reconciliation');
});

test('pure compile acceptance is narrower than a general external chore', () => {
  assert.equal(isPureCompileAcceptanceNode('验收：用户在本机执行 lake build Lrc.K13.Region3Sum'), true);
  assert.equal(isPureCompileAcceptanceNode('验收：region3_strict 成立，且 Region3Sum.lean 编译通过'), false);
  assert.equal(isExternalAcceptanceNode('请用户确认数学证明'), true);
  assert.equal(isPureCompileAcceptanceNode('请用户确认数学证明'), false);
});

test('an auth resume is judged against the ORIGINAL message, not the approval word', () => {
  assert.equal(resolveJudgeGoal('extract page 6-20 of the paper', 'ok', true), 'extract page 6-20 of the paper');
});

test('an auth resume with no recoverable goal emits no verdict at all', () => {
  // A skipped sample is honest. A could_not_verify about the word "ok" is noise that looks like data —
  // and it lands in the same distribution the Phase 2 decision reads.
  assert.equal(resolveJudgeGoal(undefined, 'ok', true), null);
  assert.equal(resolveJudgeGoal('   ', '同意', true), null);
});

test('an auth resume DOES recover the session goal when the router carried one', () => {
  // 2026-07-25: four "skipped (auth resume, original goal not recoverable)" in one evening, including the
  // best-grounded turn of the day — it downloaded the House of Graphs 4-critical set and verified all 80
  // graphs, and the judge said nothing about it. Skipping was the right fix for judging the word "ok";
  // it was never the right answer for a turn whose task the session plainly knows.
  const goal = '脊线前(short path)诱导 χ=4 + S2 辅助染色试探有机会吗';
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, goal), goal);
  // Still nothing when the session offers nothing either — no verdict beats a meaningless one.
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, '继续'), null, 'too short to be a goal');
  assert.equal(resolveJudgeGoal(undefined, 'ok', true, undefined), null);
});

test('a carried goal wins even on a fresh turn — it is the more specific signal', () => {
  assert.equal(resolveJudgeGoal('the original task', 'continue', false), 'the original task');
});

test('a fresh turn with no message at all is still judged (scheduled/proactive turns)', () => {
  assert.equal(resolveJudgeGoal(undefined, undefined, false), '');
});

test('a bare continuation word as a FRESH message inherits the last routed goal', () => {
  // 2026-07-24 16:50: 'The goal "ok" is too vague…' — the second production appearance of that exact
  // sentence. The auth-resume fix did not cover "ok" sent as a NEW message.
  assert.equal(resolveJudgeGoal(undefined, 'ok', false, '攻克 Gyárfás 路径染色问题'), '攻克 Gyárfás 路径染色问题');
  assert.equal(resolveJudgeGoal(undefined, '继续', false, 'find a counterexample'), 'find a counterexample');
});

test('a real short message with no session history stays itself', () => {
  assert.equal(resolveJudgeGoal(undefined, '继续', false, undefined), '继续');
});

test('a substantive fresh message is never overridden by history', () => {
  assert.equal(
    resolveJudgeGoal(undefined, '明天早上7点提醒我吃早饭', false, 'some older goal'),
    '明天早上7点提醒我吃早饭',
  );
});

test('a concrete active plan/tree step wins over a directional continuation goal', () => {
  assert.equal(
    resolveJudgeGoal('继续做 lrc 证明', '继续', false, undefined, 'Prove region3_chain and compile Region3Chain.lean'),
    'Prove region3_chain and compile Region3Chain.lean',
  );
});

test('a self-contained user request wins over stale active work', () => {
  assert.equal(
    resolveJudgeGoal('stale carried explore goal', '总结我们目前的证明状态', false, undefined, 'Prove stale frontier node'),
    '总结我们目前的证明状态',
  );
});

test('a short status question stays the judge goal only when the turn remained observational', () => {
  const active = 'Prove region3_chain and compile Region3Chain.lean';
  assert.equal(resolveJudgeGoal(undefined, '有进展吗？', false, undefined, active, false), '有进展吗？');
  assert.equal(resolveJudgeGoal(undefined, '有进展吗？', false, undefined, active, true), active);
});

test('skill recall for a continuation uses active work before a carried directional goal', () => {
  assert.equal(
    resolveRecallInput('继续', 'Complete plan step: prove region3 bound', '继续做 LRC 证明'),
    'Complete plan step: prove region3 bound',
  );
  assert.equal(resolveRecallInput('总结我们目前的 LRC 证明状态', 'stale work'), '总结我们目前的 LRC 证明状态');
});

test('judge frontier excludes owner acceptance chores and ranks actionable nodes like final report', () => {
  const nodes = [
    { id: 'root', parentId: null, status: 'open', claim: 'root', value: 0.1, depth: 0 },
    { id: 'accept', parentId: 'root', status: 'open', claim: '验收：用户在本机执行 lake build', value: 0.99, depth: 1 },
    { id: 'low', parentId: 'root', status: 'open', claim: 'prove low-value lemma', value: 0.2, depth: 1 },
    { id: 'best', parentId: 'root', status: 'open', claim: 'prove region3 bound', value: 0.8, depth: 2 },
  ] as any;
  assert.equal(isExternalAcceptanceNode(nodes[1].claim), true);
  assert.equal(selectJudgeFrontierGoal(nodes), 'prove region3 bound');
});
