/**
 * Reflection runner — collectReflectionState 单测
 *
 * maybeRunReflection 端到端测试需要 mock LLM,会引入复杂度。本文件只覆盖
 * collectReflectionState 的纯函数行为,maybeRunReflection 留给 1.e 集成验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReflectionState } from '../src/reflection_runner.js';

test('collectState: 空 messages → turnCount=0 toolFailures=0', () => {
  const s = collectReflectionState([], '随便');
  assert.equal(s.turnCount, 0);
  assert.equal(s.toolFailures, 0);
  assert.equal(s.taskClosing, false);
});

test('collectState: 计 user role string content', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
  ] as const;
  const s = collectReflectionState(messages as any, 'q3');
  assert.equal(s.turnCount, 2);
});

test('collectState: tool_result 数组里的 ⚠ 算 failure', () => {
  const messages = [
    { role: 'user', content: 'q' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '⚠ TOOL FAILED: shell exit 1' },
        { type: 'tool_result', tool_use_id: 'b', content: '✓ OK' },
        { type: 'tool_result', tool_use_id: 'c', content: '⚠ another fail' },
      ],
    },
  ];
  const s = collectReflectionState(messages as any, '继续');
  assert.equal(s.toolFailures, 2);
});

test('collectState: TOOL FAILED 大小写不敏感', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'tool failed exit 1' },
      ],
    },
  ];
  const s = collectReflectionState(messages as any, 'x');
  assert.equal(s.toolFailures, 1);
});

test('collectState: tool_result 数组 user role 不计入 turnCount', () => {
  const messages = [
    { role: 'user', content: 'real q' },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: '✓' }],
    },
  ];
  const s = collectReflectionState(messages as any, 'x');
  assert.equal(s.turnCount, 1);
});

test('collectState: taskClosing 中文短语命中', () => {
  const cases = ['完成', '搞定了', '搞好', '没问题了', '可以了', '好了'];
  for (const c of cases) {
    const s = collectReflectionState([], c);
    assert.equal(s.taskClosing, true, `应命中: ${c}`);
  }
});

test('collectState: taskClosing 英文短语命中', () => {
  const cases = ['done', 'finished', 'all set', "that's it"];
  for (const c of cases) {
    const s = collectReflectionState([], c);
    assert.equal(s.taskClosing, true, `应命中: ${c}`);
  }
});

test('collectState: 普通对话不命中 taskClosing', () => {
  const s = collectReflectionState([], '帮我做个 X');
  assert.equal(s.taskClosing, false);
});

test('collectState: 默认 signals → 全 false/0', () => {
  const s = collectReflectionState([], 'x');
  assert.equal(s.honestyFired, false);
  assert.equal(s.interruptDrained, false);
  assert.equal(s.sameRootCauseFailures, 0);
  assert.equal(s.taskDurationMin, 0);
});

// D.2 (2026-05-06):turn-local signals 接入

test('collectState: signals.honestyFired=true → state.honestyFired=true', () => {
  const s = collectReflectionState([], 'x', { honestyFired: true });
  assert.equal(s.honestyFired, true);
});

test('collectState: signals.interruptDrained=true → state.interruptDrained=true', () => {
  const s = collectReflectionState([], 'x', { interruptDrained: true });
  assert.equal(s.interruptDrained, true);
});

test('collectState: turnStartTs 推算 taskDurationMin', () => {
  const past = Date.now() - 25 * 60_000;
  const s = collectReflectionState([], 'x', { turnStartTs: past });
  assert.ok(s.taskDurationMin >= 24 && s.taskDurationMin <= 26, `got ${s.taskDurationMin}`);
});

test('collectState: turnStartTs 在未来 → taskDurationMin 不可为负', () => {
  const s = collectReflectionState([], 'x', { turnStartTs: Date.now() + 60_000 });
  assert.ok(s.taskDurationMin >= 0);
});

test('collectState: turnStartTs=0 视为未设置', () => {
  const s = collectReflectionState([], 'x', { turnStartTs: 0 });
  assert.equal(s.taskDurationMin, 0);
});

test('collectState: sameRootCauseFailures 透传(暂未自动接入)', () => {
  const s = collectReflectionState([], 'x', { sameRootCauseFailures: 4 });
  assert.equal(s.sameRootCauseFailures, 4);
});

test('collectState: signals 各字段独立(只设 honesty 不影响 interrupt)', () => {
  const s = collectReflectionState([], 'x', { honestyFired: true });
  assert.equal(s.honestyFired, true);
  assert.equal(s.interruptDrained, false);
  assert.equal(s.taskDurationMin, 0);
});

// self_learning_redesign Phase 0.2: a lesson-playbook whose advice is now encoded in an executable
// artifact (same task_signature) is superseded and must be RETIRED. The old code only appended a note and
// left it injected forever alongside the rule that superseded it — detected, marked, never acted on.
import { playbooksSupersededBy } from '../src/reflection_runner.js';

test('playbooksSupersededBy: retires same-signature lesson playbooks', () => {
  const pbs = [
    { name: 'playbook-mycox-abc123', maturity: 'playbook' },
    { name: 'playbook-other-def456', maturity: 'playbook' },
  ];
  const hit = playbooksSupersededBy(pbs, 'mycox');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, 'playbook-mycox-abc123');
});

test('playbooksSupersededBy: does NOT touch plan-failure playbooks (stronger signal)', () => {
  // A plan-failure playbook is named playbook-<sig>-fail-<hash>; the sig regex extracts "<sig>-fail", so a
  // reflection for "mycox" never matches "mycox-fail". These curated failure lessons are not auto-retired.
  const pbs = [{ name: 'playbook-mycox-fail-abc123', maturity: 'playbook' }];
  assert.equal(playbooksSupersededBy(pbs, 'mycox').length, 0);
});

test('playbooksSupersededBy: skips already-deprecated and non-matching signatures', () => {
  const pbs = [
    { name: 'playbook-mycox-abc123', maturity: 'deprecated' }, // already retired
    { name: 'playbook-payments-xyz789', maturity: 'playbook' }, // different sig
  ];
  assert.equal(playbooksSupersededBy(pbs, 'mycox').length, 0);
});

// ── cross-turn evidence (2026-09-20) ───────────────────────────────────

import { buildCrossTurnEvidence, learningRequiresRecurrence, playbooksContradictedThisTurn } from '../src/reflection_runner.js';

const sig = (tool: string, err: string) => `${tool}:${err.split(':')[1]?.trim() ?? 'other'}`;

test('buildCrossTurnEvidence: counts distinct sessions per failure class of this turn, current session included', () => {
  const ev = buildCrossTurnEvidence({
    turnFailures: [{ toolName: 'shell', resultText: 'shell: cmd-not-found rg' }, { toolName: 'readFile', resultText: 'readFile: enoent' }],
    ledger: [
      { toolName: 'shell', result: 'shell: cmd-not-found rg', sessionId: 'cur' },
      { toolName: 'shell', result: 'shell: cmd-not-found rg', sessionId: 'other-1' },
      { toolName: 'shell', result: 'shell: cmd-not-found rg', sessionId: 'other-1' },
      { toolName: 'http', result: 'http: 401', sessionId: 'other-2' }, // not this turn's class → ignored
    ],
    signatureOf: sig,
    currentSessionId: 'cur',
  });
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0], { signature: 'shell:cmd-not-found rg', sessions: 2, occurrences: 3, sample: 'shell: cmd-not-found rg' });
  // Not in the ledger yet: still happened once, in this session.
  assert.deepEqual(ev[1], { signature: 'readFile:enoent', sessions: 1, occurrences: 1, sample: 'readFile: enoent' });
});

test('buildCrossTurnEvidence: no failures this turn → nothing; cap respected', () => {
  assert.deepEqual(buildCrossTurnEvidence({ turnFailures: [], ledger: [], signatureOf: sig }), []);
  const many = buildCrossTurnEvidence({
    turnFailures: [...'abcdefgh'].map((c) => ({ toolName: 't', resultText: `t: ${c}` })),
    ledger: [], signatureOf: sig, limit: 3,
  });
  assert.equal(many.length, 3);
});

test('recurrence gate flag: on by default, off on 0/off/false/no', () => {
  assert.equal(learningRequiresRecurrence({} as NodeJS.ProcessEnv), true);
  assert.equal(learningRequiresRecurrence({ PHILONT_LEARNING_REQUIRE_RECURRENCE: 'off' } as NodeJS.ProcessEnv), false);
});

test('buildCrossTurnEvidence: pairs a recurring failure with the same tool\'s later successful input', () => {
  const ev = buildCrossTurnEvidence({
    turnFailures: [{ toolName: 'pariGp', resultText: 'pariGp: gp-syntax' }],
    ledger: [
      { toolName: 'pariGp', result: 'pariGp: gp-syntax', sessionId: 'a' },
      { toolName: 'pariGp', result: 'pariGp: gp-syntax', sessionId: 'b' },
    ],
    allActions: [
      { toolName: 'pariGp', params: { code: 'for(n=1,3, print(n)' }, success: false, sessionId: 'a', timestamp: 10, result: 'pariGp: gp-syntax' } as never,
      { toolName: 'pariGp', params: { code: 'print(1)' }, success: true, sessionId: 'z', timestamp: 5 },   // before the failure → not a contrast
      { toolName: 'pariGp', params: { code: 'for(n=1,3, print(n))' }, success: true, sessionId: 'b', timestamp: 20 },
      { toolName: 'pariGp', params: { code: 'for(n=1,9, print(n))' }, success: true, sessionId: 'c', timestamp: 30 },
      { toolName: 'shell', params: { command: 'ls' }, success: true, sessionId: 'c', timestamp: 40 }, // other tool
    ],
    signatureOf: sig,
    currentSessionId: 'cur',
  });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].laterSuccess, { inputSample: '{"code":"for(n=1,9, print(n))"}', sessionId: 'c' });
  assert.equal(ev[0].sessions, 3);
});

test('buildCrossTurnEvidence: no success of that tool → no pair; the block renders the pair when present', async () => {
  const none = buildCrossTurnEvidence({
    turnFailures: [{ toolName: 'pariGp', resultText: 'pariGp: gp-syntax' }],
    ledger: [], allActions: [{ toolName: 'shell', params: {}, success: true, sessionId: 'z', timestamp: 1 }],
    signatureOf: sig, currentSessionId: 'cur',
  });
  assert.equal(none[0].laterSuccess, undefined);
  // This turn's failure is not in the ledger yet: an earlier success of the same tool still contrasts.
  const ev = buildCrossTurnEvidence({
    turnFailures: [{ toolName: 'pariGp', resultText: 'pariGp: gp-syntax' }],
    ledger: [], allActions: [{ toolName: 'pariGp', params: { code: 'ok' }, success: true, sessionId: 'z', timestamp: 1 }],
    signatureOf: sig, currentSessionId: 'cur',
  });
  assert.deepEqual(ev[0].laterSuccess, { inputSample: '{"code":"ok"}', sessionId: 'z' });
  const { renderCrossTurnEvidence } = await import('@agent/memory');
  const block = renderCrossTurnEvidence([{ signature: 'pariGp:gp-syntax', sessions: 2, occurrences: 2, sample: 'syntax error', laterSuccess: { inputSample: '{"code":"ok"}' } }]);
  assert.match(block, /LATER SUCCEEDED with: \{"code":"ok"\} — name what differs/);
});

test('playbooksContradictedThisTurn: only signature-tagged playbooks whose class failed this turn', () => {
  const offered = [
    { name: 'pb-rg', signature: 'shell:cmd-not-found:rg' },
    { name: 'pb-gp', signature: 'pariGp:gp-syntax' },
    { name: 'pb-untagged', signature: null },
    { name: 'pb-rg', signature: 'shell:cmd-not-found:rg' },
  ];
  assert.deepEqual(playbooksContradictedThisTurn(offered, ['shell:cmd-not-found:rg', 'readFile:enoent']), ['pb-rg']);
  assert.deepEqual(playbooksContradictedThisTurn(offered, []), []);
  assert.deepEqual(playbooksContradictedThisTurn([], ['shell:cmd-not-found:rg']), []);
});

test('rulesContradictedThisTurn: only signature-bearing rules whose class failed this turn', async () => {
  const { rulesContradictedThisTurn } = await import('../src/reflection_runner.js');
  const rules = [
    { id: 1, failureSignature: 'shell:cmd-not-found:rg' },
    { id: 2, failureSignature: null },
    { id: 3, failureSignature: 'pariGp:gp-syntax' },
  ];
  assert.deepEqual(rulesContradictedThisTurn(rules, ['shell:cmd-not-found:rg', 'readFile:enoent']), [1]);
  assert.deepEqual(rulesContradictedThisTurn(rules, []), []);
});
