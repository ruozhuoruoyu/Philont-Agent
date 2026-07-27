import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutputFormat } from '../src/output_format_gate.js';

test('evaluateOutputFormat: 短回复(< 500 字)→ 不触发', () => {
  const r = evaluateOutputFormat({ finalText: '好的,已完成。' });
  assert.equal(r.shouldRegenerate, false);
});

test('evaluateOutputFormat: 长文本含 `## 给用户` 段 → 不触发', () => {
  const text =
    '## 给用户\n注册完成 ✅\n\n## 工作日志\n' + 'a'.repeat(600);
  const r = evaluateOutputFormat({ finalText: text });
  assert.equal(r.shouldRegenerate, false);
  assert.equal(r.detail?.hasUserSection, true);
});

test('evaluateOutputFormat: 长文本无 `## 给用户` 段 → 触发 regen', () => {
  const text =
    '读完 feed,社区讨论丰富,聚焦量子测量...' + 'a'.repeat(600);
  const r = evaluateOutputFormat({ finalText: text });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'long_text_no_user_section');
  assert.equal(r.detail?.hasUserSection, false);
  assert.ok((r.detail?.finalTextLength ?? 0) > 500);
});

test('evaluateOutputFormat: 边界 500 字以内不触发', () => {
  const r = evaluateOutputFormat({ finalText: 'x'.repeat(500) });
  assert.equal(r.shouldRegenerate, false);
});

test('evaluateOutputFormat: 边界 501 字 + 无 user 段 → 触发', () => {
  const r = evaluateOutputFormat({ finalText: 'x'.repeat(501) });
  assert.equal(r.shouldRegenerate, true);
});

test('evaluateOutputFormat: ## 给用户 大小写 / 空格变化', () => {
  // 注意:正则用 i flag,但"给用户"是中文,大小写不变
  // 测试 heading 前后空格
  const r1 = evaluateOutputFormat({
    finalText: '##给用户\n短\n' + 'x'.repeat(550),
  });
  assert.equal(r1.shouldRegenerate, false); // ## 后无空格也认
  const r2 = evaluateOutputFormat({
    finalText: '##   给用户  \n内容\n' + 'x'.repeat(550),
  });
  assert.equal(r2.shouldRegenerate, false); // ## 后多个空格也认
});

// Production 2026-07-27 15:30:48. A deep_explore round ran for 6 minutes and returned
// `refuted 1; +1 dead ends; 10 still open`; the entire reply that followed was 17 characters of small
// talk — `你在看什么？你们那边的活动怎么样了…` — with no `## 给用户` section. The channel logged
// `output_filter fallback (no '## 给用户' section) { fullLen: 17 }` and sent it as-is. The gate never
// looked, because 17 < 500. The length exemption reads "short ⇒ simple query"; a finished reasoning
// round says otherwise, and the round's findings were the only reason the user waited.
test('reportable work: a short off-topic reply that drops the round is caught', () => {
  const r = evaluateOutputFormat({
    finalText: '你在看什么？你们那边的活动怎么样了…',
    reportableWork: true,
  });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'reportable_work_no_user_section');
  assert.ok((r.detail?.finalTextLength ?? 0) < 500, 'well under the length threshold');
});

test('reportable work: a short reply that DOES report through ## 给用户 passes', () => {
  const r = evaluateOutputFormat({
    finalText: '## 给用户\n这轮否证 1 条,新增 1 个死胡同,仍有 10 个开放节点。',
    reportableWork: true,
  });
  assert.equal(r.shouldRegenerate, false);
});

test('reportable work: absent, the length exemption still applies', () => {
  const r = evaluateOutputFormat({ finalText: '好的,我看一下。' });
  assert.equal(r.shouldRegenerate, false);
  assert.equal(r.detail?.reportableWork, false);
});

test('evaluateOutputFormat: minLengthToTrigger 可调', () => {
  const r1 = evaluateOutputFormat({
    finalText: 'x'.repeat(200),
    minLengthToTrigger: 100,
  });
  assert.equal(r1.shouldRegenerate, true);
  const r2 = evaluateOutputFormat({
    finalText: 'x'.repeat(200),
    minLengthToTrigger: 1000,
  });
  assert.equal(r2.shouldRegenerate, false);
});
