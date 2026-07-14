/**
 * Phase 7 固化 1:autoClassify 启发式 classifier 单测
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoClassify, quickSignatureHash } from '../src/task_mode_classifier.js';
import { openMemoryDb } from '@agent/memory';

test('quickSignatureHash: 同消息稳定 hash,不同消息不同 hash', () => {
  const a = quickSignatureHash('帮我注册 mycox API');
  const b = quickSignatureHash('帮我注册 mycox API');
  const c = quickSignatureHash('查一下今天天气');
  assert.equal(a, b, '同消息应稳定');
  assert.notEqual(a, c, '不同消息应不同');
  assert.equal(a.length, 8);
});

test('quickSignatureHash: normalize 后等价(大小写/标点不敏感)', () => {
  const a = quickSignatureHash('Hello World!');
  const b = quickSignatureHash('hello world');
  assert.equal(a, b);
});

test('quickSignatureHash: 空消息也能生成 hash', () => {
  const h = quickSignatureHash('');
  assert.equal(h.length, 8);
});

// ── autoClassify 启发式规则 ──────────────────────────────────────────

test('autoClassify: 短查询(单工具调用)→ fast', () => {
  const r = autoClassify({
    userMessage: '查一下今天天气',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, false);
  // 可能命中 0 或 1 条规则(不到 2 条不触发 slow)
});

test('autoClassify: 闲聊 → fast', () => {
  const r = autoClassify({
    userMessage: '嗯',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, false);
});

test('autoClassify: 含 URL + 多步连接词 → slow', () => {
  const r = autoClassify({
    userMessage:
      'Read https://mycox.ai/mycox/guide.md, then register with invite_code "inv_xxx"',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, true);
  assert.ok(r.reasons.includes('contains-url'));
  // "then register" 命中 multi-step-connector 或 heavy-keyword(register)
  assert.ok(
    r.reasons.includes('multi-step-connector') ||
      r.reasons.includes('heavy-keyword'),
  );
});

test('autoClassify: 高复杂度 keyword + guide 提示 → slow', () => {
  const r = autoClassify({
    userMessage: '帮我接入 mycox API,按文档 guide 跑',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, true);
  assert.ok(r.reasons.includes('heavy-keyword'));
  assert.ok(r.reasons.includes('guide-hint'));
});

test('autoClassify: 仅 heavy-keyword 单独不触发 slow(需 2 条)', () => {
  const r = autoClassify({
    userMessage: '注册用户',
    taskSignatureCandidate: 'sig',
  });
  // 只命中 heavy-keyword 一条
  assert.equal(r.isSlow, false);
  assert.ok(r.reasons.includes('heavy-keyword'));
});

test('autoClassify: 仅 URL 单独不触发 slow', () => {
  const r = autoClassify({
    userMessage: 'https://example.com 是什么',
    taskSignatureCandidate: 'sig',
  });
  // 只命中 contains-url
  assert.equal(r.isSlow, false);
  assert.ok(r.reasons.includes('contains-url'));
});

test('autoClassify: 长消息(≥240 字)+ URL **不再** 单独触发 slow(Phase 13 收紧)', () => {
  // 两个都是 weak 信号,无 strong → 不应升 slow
  // Phase 13 之前两个 weak 也 ≥ 2 会升,现在要求 strong ≥ 1
  const longMsg =
    '这是一个很长的消息: ' + 'lorem ipsum dolor sit amet, '.repeat(15) +
    ' 看看 https://example.com';
  assert.ok(longMsg.length >= 240, `test fixture 长度 ${longMsg.length}`);
  const r = autoClassify({
    userMessage: longMsg,
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, false, '两个 weak 信号不应升 slow');
  assert.ok(r.reasons.includes('msg-long-240+'));
  assert.ok(r.reasons.includes('contains-url'));
});

test('autoClassify: 长消息 + URL + heavy keyword → slow(Phase 13 strong+weak 组合)', () => {
  const longMsg =
    '这是一个很长的注册任务: ' + 'lorem ipsum dolor sit amet, '.repeat(15) +
    ' 看看 https://example.com';
  assert.ok(longMsg.length >= 240, `test fixture 长度 ${longMsg.length}`);
  const r = autoClassify({
    userMessage: longMsg,
    taskSignatureCandidate: 'sig',
  });
  // strong(heavy=注册) + weak(msg-long + url) = 1 strong + 2 weak,触发 slow
  assert.equal(r.isSlow, true);
  assert.ok(r.reasons.includes('heavy-keyword'));
});

test('autoClassify: Phase 13 — 单 URL Read 任务不再升 slow(实战 ad-hoc 误升 fix)', () => {
  // 实测 mycox 之前的误升路径:`Read https://x.com/foo` → 升 slow → 强制 plan
  // 协议 → 简单 read 任务被卡。Phase 13 收紧后单 URL Read 应该回归 fast。
  const r = autoClassify({
    userMessage: 'Read https://example.com/post',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, false, '单 URL Read 应是 fast');
});

test('autoClassify: 多步连接词(中文) + heavy → slow', () => {
  const r = autoClassify({
    userMessage: '先注册,然后心跳,之后调研日志',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, true);
  assert.ok(r.reasons.includes('multi-step-connector'));
});

test('autoClassify: R6 同 sig 失败历史 → 单独触发 slow', () => {
  const mem = openMemoryDb(':memory:');
  // 种入 1 条失败 plan 用 sig='abc123'
  const p = mem.plans.create({
    sessionId: 's-prior',
    taskSignature: 'abc123',
    steps: [{ description: 'try' }],
  });
  mem.plans.close(p.id, 'failure', '上次失败了');

  const r = autoClassify({
    userMessage: '随便一句没规则命中的话', // 没有任何启发式规则触发
    taskSignatureCandidate: 'abc123',
    plans: mem.plans,
  });
  assert.equal(r.isSlow, true, '单独 R6 命中应触发 slow');
  assert.ok(r.reasons.includes('same-sig-history-failed'));
});

test('autoClassify: 历史只 completed/draft → 不触发 R6', () => {
  const mem = openMemoryDb(':memory:');
  const p = mem.plans.create({
    sessionId: 's',
    taskSignature: 'abc',
    steps: [{ description: 't' }],
  });
  mem.plans.close(p.id, 'success', 'ok');

  const r = autoClassify({
    userMessage: '没规则',
    taskSignatureCandidate: 'abc',
    plans: mem.plans,
  });
  assert.equal(r.isSlow, false, 'success plan 不触发 R6');
});

test('autoClassify: plans 查询抛错时降级跑其它规则', () => {
  const fakePlans = {
    listBySignature: () => {
      throw new Error('boom');
    },
  } as any;
  const r = autoClassify({
    userMessage: '帮我注册并接入 mycox API,按 guide 跑', // heavy + guide
    taskSignatureCandidate: 'x',
    plans: fakePlans,
  });
  // 其它规则正常工作
  assert.equal(r.isSlow, true);
  assert.ok(r.reasons.includes('heavy-keyword'));
  assert.ok(r.reasons.includes('guide-hint'));
});

// ── slowSessionAtTaskBoundary (per-task re-classification, 2026-07-01) ──────────────────────
import { slowSessionAtTaskBoundary } from '../src/task_mode_classifier.js';

test('slowSessionAtTaskBoundary: terminal/absent plan → true (new task starting)', () => {
  assert.equal(slowSessionAtTaskBoundary(undefined), true, 'no plan → boundary');
  assert.equal(slowSessionAtTaskBoundary(null), true, 'no plan → boundary');
  assert.equal(slowSessionAtTaskBoundary('completed'), true, 'prev task done → boundary');
  assert.equal(slowSessionAtTaskBoundary('failed'), true, 'prev task failed → boundary');
});

test('slowSessionAtTaskBoundary: active plan → false (mid-task, do not re-enter)', () => {
  assert.equal(slowSessionAtTaskBoundary('draft'), false);
  assert.equal(slowSessionAtTaskBoundary('reviewed'), false);
  assert.equal(slowSessionAtTaskBoundary('executing'), false);
});

test('autoClassify: mycox "read guide then register" is unambiguously slow (the prod under-classified task)', () => {
  const r = autoClassify({
    userMessage: 'Read https://mycox.ai/mycox/guide.md, then register with invite_code "inv_de9fbd"',
    taskSignatureCandidate: 'sig',
  });
  assert.equal(r.isSlow, true);
  // guide.md → guide-hint, register → heavy-keyword, "then" → multi-step-connector
  assert.ok(r.reasons.includes('guide-hint'));
  assert.ok(r.reasons.includes('heavy-keyword'));
  assert.ok(r.reasons.includes('multi-step-connector'));
});

test('GUIDE_HINT: an instruction to FOLLOW a guide — not the mere word 文档/spec (prod 2026-07-13)', async () => {
  const { autoClassify } = await import('../src/task_mode_classifier.js');
  const reasons = (t: string) => autoClassify({ userMessage: t, taskSignatureCandidate: 'sig' }).reasons;

  // The prod message: "导出word文档" tripped 文档 → STRONG slow → placeholder plan →
  // plan_protocol_gate rejected the very shell call the task needed.
  for (const t of ['导出word文档', '帮我看下这个文档', '写个 spec', '把文档发我', '这份手册在哪']) {
    assert.ok(!reasons(t).includes('guide-hint'), `a document NOUN must not be a guide hint: ${t}`);
  }
  // A real "follow the guide" instruction still trips it.
  for (const t of [
    '按文档要求把服务接入', '参考这个 guide 注册一下', '根据规范实现鉴权',
    '依照手册配置心跳', 'follow the spec and register the service',
  ]) {
    assert.ok(reasons(t).includes('guide-hint'), `a real guide instruction must trip: ${t}`);
  }
});
