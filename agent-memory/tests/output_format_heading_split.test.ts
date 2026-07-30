/**
 * 2026-07-30, seven days of production: `output_format` fired 129 times — the most expensive controller
 * in the system, one full regeneration each.
 *
 * Every one of them was a reply that had already complied. The gate matched `/##\s*给用户/` and nothing
 * else, while every producer asks for `## For User` — the system prompt, the priming assistant turn,
 * max_iter_summary, viability_gate's rewrite instruction, CONTRACT 3/3 — and the WeChat delivery filter
 * accepts both headings. So the channel found the section and delivered it, and the gate simultaneously
 * declared it missing.
 *
 * Producer emits one convention, exact-match consumer accepts another: the split this repo keeps
 * re-shipping (channel ids, tool names, now section headings). The i18n pass flipped the prompts to
 * English and made the delivery filter bilingual; the gate was the consumer nobody re-read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutputFormat, hasUserSection, USER_SECTION_HEADING } from '../src/output_format_gate.js';

const LONG = 'x'.repeat(600);

test('the English heading every prompt asks for is accepted', () => {
  const r = evaluateOutputFormat({ finalText: `## For User\n${LONG}\n## Work Log\ndetail` });
  assert.equal(r.shouldRegenerate, false, 'this is the heading we told the model to write');
});

test('the legacy Chinese heading still works', () => {
  const r = evaluateOutputFormat({ finalText: `## 给用户\n${LONG}\n## 工作日志\ndetail` });
  assert.equal(r.shouldRegenerate, false);
});

test('a long reply with no section at all still fires', () => {
  const r = evaluateOutputFormat({ finalText: LONG });
  assert.equal(r.shouldRegenerate, true);
  assert.equal(r.reason, 'long_text_no_user_section');
});

// The 17-character small-talk turn that discarded a 6-minute reasoning round (2026-07-27 15:30:48).
test('reportable work still requires the section at any length — in either language', () => {
  for (const text of ['你在看什么？', 'what are you up to?']) {
    const r = evaluateOutputFormat({ finalText: text, reportableWork: true });
    assert.equal(r.shouldRegenerate, true, text);
    assert.equal(r.reason, 'reportable_work_no_user_section');
  }
  const ok = evaluateOutputFormat({ finalText: '## For User\n本轮否证了 1 个方向。', reportableWork: true });
  assert.equal(ok.shouldRegenerate, false);
});

// The gate exists to predict whether the delivery filter will find a section. A looser test here would
// pass replies the channel then falls back on — the exact failure the gate is for, arriving silently.
// So the heading match is line-anchored, identically to extractUserSection().
test('an inline mention of the heading is not a section', () => {
  assert.equal(hasUserSection('I will put it under ## For User later.'), false);
  assert.equal(hasUserSection('## For User\nbody'), true);
});

test('the heading regex tolerates the spacing and casing the model actually emits', () => {
  for (const line of ['## For User', '##For User', '##  for user  ', '## 给用户', '##给用户']) {
    assert.ok(USER_SECTION_HEADING.test(line), line);
  }
  assert.ok(!USER_SECTION_HEADING.test('### For User'), 'h3 is not the contract');
  assert.ok(!USER_SECTION_HEADING.test('## For Users'), 'a different heading is a different heading');
});
