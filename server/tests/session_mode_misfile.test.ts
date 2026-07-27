/**
 * Production 2026-07-27, 21:58 → 22:05. The owner said 继续LRC深度推理. The round that followed ran
 * eleven webSearch/webFetch calls and one reason_decompose, proved nothing, hit the six-minute cap,
 * and he replied 我问的是LRC，你怎么又找回来其它的问题了？
 *
 * It was not wandering. The session's mode was `deliberate`, whose tool set is the web and memory —
 * pariGp, z3Verify and magnitude are not in it. A proof session had been created with no way to compute
 * anything, so browsing was the only work available to it.
 *
 * The mode came from the intent router: "LRC" is an acronym the aux model cannot resolve, and
 * `deliberate` is also what parseIntentDecision falls back to whenever the domain is missing or
 * unrecognised. buildForceStartInput passed that guess as an EXPLICIT mode, and an explicit mode
 * outranks classifyGoal — the detector that reads the goal text and would have said `formal`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForceStartInput, type IntentDecision } from '../src/intent_router.js';
import { classifyGoal, looksDeductive } from '../src/phase_gate.js';
import { renderSessionSubject } from '../src/deep_explore.js';

const ROUTER_SAID_DELIBERATE: IntentDecision = {
  route: 'deep_explore',
  domain: 'deliberate',
  confidence: 0.95,
  reason: 'analysis',
};

const LRC_GOAL =
  'Lonely Runner Conjecture 的证明突破口——基于已完成的小规模数值验证（k=3,4,5,6 精确有理枚举全部通过），找到有希望的证明方向。';

test('the router guess no longer outranks a goal that reads as a proof', () => {
  const input = buildForceStartInput(ROUTER_SAID_DELIBERATE, LRC_GOAL);
  assert.equal(input.mode, undefined, 'mode is left to the engine, not pinned to the guess');
  // and the engine's own detector gets it right
  assert.equal(classifyGoal(LRC_GOAL).mode, 'formal');
});

test('a genuinely deliberative goal still gets the router\'s deliberate', () => {
  const goal = '我们应该选 Postgres 还是 MySQL 来做主库？考虑运维成本和团队熟悉度。';
  assert.equal(looksDeductive(goal), false);
  assert.equal(buildForceStartInput(ROUTER_SAID_DELIBERATE, goal).mode, 'deliberate');
});

test('a router `formal` is a positive claim and is kept', () => {
  const dec: IntentDecision = { ...ROUTER_SAID_DELIBERATE, domain: 'formal' };
  assert.equal(buildForceStartInput(dec, '随便什么目标').mode, 'formal');
});

test('the round subject names the mode, so browsing has a visible reason', () => {
  const formal = renderSessionSubject(LRC_GOAL, 'sess-1', 'formal');
  assert.match(formal, /mode: formal/);
  assert.match(formal, /pariGp/);

  const deliberate = renderSessionSubject(LRC_GOAL, 'sess-1', 'deliberate');
  assert.match(deliberate, /mode: deliberate/);
  assert.match(deliberate, /NO pariGp/);
});

test('a proof goal filed as deliberate is flagged, with the one-line correction', () => {
  const s = renderSessionSubject(LRC_GOAL, 'sess-1', 'deliberate');
  assert.match(s, /cannot compute or verify/);
  assert.match(s, /mode:"formal"/);
});

test('no mismatch note when the pairing is coherent', () => {
  const research = '对比几家云厂商的托管 Postgres，给出选型建议。';
  assert.doesNotMatch(renderSessionSubject(research, 'sess-2', 'deliberate'), /cannot compute/);
  assert.doesNotMatch(renderSessionSubject(LRC_GOAL, 'sess-3', 'formal'), /cannot compute/);
});

test('the subject line stays usable when no mode is supplied', () => {
  const s = renderSessionSubject(LRC_GOAL, 'sess-4');
  assert.match(s, /^on: "/);
  assert.match(s, /session id: sess-4/);
  assert.doesNotMatch(s, /mode:/);
});
