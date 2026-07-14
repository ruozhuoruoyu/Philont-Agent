/**
 * renderDeterministicMaxIterSummary 单测。
 *
 * 关键不变量:
 *   - 至少含 "## 给用户" 段(让 output_filter 走策略 1 不 fallback)
 *   - 含已用次数 + 上限报告
 *   - 含最后 N 步(默认 5)的工具状态
 *   - 含给用户的下一步建议(让对话能继续)
 *   - 工具结果按 ✓/⚠ 自动加图标
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDeterministicMaxIterSummary } from '../src/max_iter_summary.js';

// 2026-07-14: this summary is now language-resolved (AGENT_LANGUAGE → observed → mirror). With nothing
// known about the owner it renders ENGLISH — the neutral default for an open-source build — and a Chinese
// owner is switched over as soon as their first message is observed. Pin BOTH, so neither can silently rot.
function withLang<T>(lang: string, fn: () => T): T {
  const prev = process.env.AGENT_LANGUAGE;
  process.env.AGENT_LANGUAGE = lang;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_LANGUAGE;
    else process.env.AGENT_LANGUAGE = prev;
  }
}

test('summary: 基本结构 — 含给用户段 + 计数 + 建议 (zh)', () => {
  const text = withLang('zh', () =>
    renderDeterministicMaxIterSummary(20, [
      { toolName: 'glob', content: '✓ Found 3 files' },
      { toolName: 'shell', content: '⚠ command not found' },
    ], 20),
  );
  assert.match(text, /^## For User/);
  assert.match(text, /20 轮工具调用上限/);
  assert.match(text, /共调用 20 次工具/);
  assert.match(text, /换个思路重试/);
});

test('summary: same structure in English', () => {
  const text = withLang('en', () =>
    renderDeterministicMaxIterSummary(20, [{ toolName: 'glob', content: '✓ Found 3 files' }], 20),
  );
  assert.match(text, /^## For User/);
  assert.match(text, /20-round tool-call limit/);
  assert.match(text, /20 tool calls in total/);
  assert.match(text, /retry with a different approach/);
  assert.doesNotMatch(text, /轮工具调用/, 'an English summary must not carry Chinese');
});

test('summary: 工具结果 ✓/⚠ 自动加图标', () => {
  const text = renderDeterministicMaxIterSummary(5, [
    { toolName: 'glob', content: '✓ ok' },
    { toolName: 'shell', content: '⚠ failed' },
    { toolName: 'readFile', content: 'unknown prefix' },
  ], 10);
  assert.match(text, /✅ glob/);
  assert.match(text, /❌ shell/);
  assert.match(text, /· readFile/);
});

test('summary: 多于 N 条只取最后 N(默认 5)', () => {
  const lots = Array.from({ length: 10 }, (_, i) => ({
    toolName: `tool${i}`,
    content: `✓ result ${i}`,
  }));
  const text = renderDeterministicMaxIterSummary(10, lots, 10);
  // 应包含 tool5..tool9,不含 tool0..tool4
  assert.match(text, /tool9/);
  assert.match(text, /tool5/);
  assert.doesNotMatch(text, /tool0/);
  assert.doesNotMatch(text, /tool4/);
});

test('summary: 空 recentResults → 占位行', () => {
  // withLang, not a bare env assignment — a leaked AGENT_LANGUAGE would silently retune every later test
  // in this process.
  const text = withLang('zh', () => renderDeterministicMaxIterSummary(0, [], 10));
  assert.match(text, /\(无可用工具结果记录\)/);
});

test('summary: 自定义 tailN', () => {
  const lots = Array.from({ length: 10 }, (_, i) => ({
    toolName: `t${i}`,
    content: `· r${i}`,
  }));
  const text = renderDeterministicMaxIterSummary(10, lots, 10, 3);
  // 只剩 t7/t8/t9
  assert.match(text, /t9/);
  assert.match(text, /t7/);
  assert.doesNotMatch(text, /t6/);
});

test('summary: tool result 内容超 100 字截断', () => {
  const longContent = '✓ ' + 'x'.repeat(500);
  const text = renderDeterministicMaxIterSummary(1, [
    { toolName: 'shell', content: longContent },
  ], 10);
  // preview 截 100 字
  const previewLine = text.split('\n').find((l) => l.includes('shell'));
  assert.ok(previewLine);
  assert.ok(previewLine!.length < 200, `preview line too long: ${previewLine!.length}`);
});

test('summary: 空 toolName 用 ? 兜底', () => {
  const text = renderDeterministicMaxIterSummary(1, [
    { toolName: '', content: '✓ something' },
  ], 10);
  assert.match(text, /\?: ✓ something/);
});

test('summary: ## 给用户 段保证 output_filter 命中策略 1', () => {
  // 之前 output_filter 没命中 ## 给用户 时走 fallback,现在 fallback 不再砍
  // 但确定性摘要应主动满足策略 1,sectionHit=true
  const text = renderDeterministicMaxIterSummary(5, [
    { toolName: 'glob', content: '✓ x' },
  ], 10);
  assert.equal(text.startsWith('## For User'), true);
});
