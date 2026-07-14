/**
 * research_grant 纯逻辑单测:渲染卡片 / sessionId 重构 / 用户回复确定性裁决。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGrantReply,
  renderResearchGrantPrompt,
  reconstructDmSessionId,
  decideResearchGrantAction,
  type PendingResearchGrant,
} from '../src/research_grant.js';

const NOW = 1_750_000_000_000;
const TTL = 2 * 60 * 60 * 1000; // 2h

function pending(over: Partial<PendingResearchGrant> = {}): PendingResearchGrant {
  return { pursuitId: 'p1', questionId: 'q1', tool: 'runLean', why: '验证', ts: NOW, ...over };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────────

test('renderResearchGrantPrompt: 含标题/工具/回复提示', () => {
  const t = renderResearchGrantPrompt('研究猜想 X', 'runLean', '跑形式化验证', TTL);
  assert.match(t, /后台研究请求授权/);
  assert.match(t, /研究猜想 X/);
  assert.match(t, /runLean/);
  assert.match(t, /跑形式化验证/);
  assert.match(t, /同意/);
  assert.match(t, /拒绝/);
  assert.match(t, /120 分钟/); // 2h ttl
});

test('renderResearchGrantPrompt: why 为空时不带括号', () => {
  const t = renderResearchGrantPrompt('研究 X', 'runZ3', '', TTL);
  assert.match(t, /runZ3/);
  assert.doesNotMatch(t, /\(\)/);
});

// ── sessionId 重构 ───────────────────────────────────────────────────────────

test('reconstructDmSessionId: 微信 DM → wechat:<acct>:<user>', () => {
  assert.equal(reconstructDmSessionId('wechat:acctA', 'userX'), 'wechat:acctA:userX');
});

test('reconstructDmSessionId: telegram DM → telegram:<bot>:<user>', () => {
  assert.equal(reconstructDmSessionId('telegram:bot1', 'u1'), 'telegram:bot1:u1');
});

test('reconstructDmSessionId: 未知渠道 → null', () => {
  assert.equal(reconstructDmSessionId('email', 'a@b.com'), null);
});

test('reconstructDmSessionId: 群订阅(peer group:) → null', () => {
  assert.equal(reconstructDmSessionId('wechat:acctA', 'group:g1'), null);
  assert.equal(reconstructDmSessionId('telegram:bot1', 'group:g1'), null);
});

// ── 确定性裁决 ───────────────────────────────────────────────────────────────

test('decide: 无 pending → passthrough', () => {
  assert.equal(decideResearchGrantAction(undefined, 'grant', NOW, TTL), 'passthrough');
});

test('decide: 未过期 + grant → grant', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + 1000, TTL), 'grant');
});

test('decide: 未过期 + deny → deny', () => {
  assert.equal(decideResearchGrantAction(pending(), 'deny', NOW + 1000, TTL), 'deny');
});

test('decide: 未过期 + unclear → passthrough(交 LLM)', () => {
  assert.equal(decideResearchGrantAction(pending(), 'unclear', NOW + 1000, TTL), 'passthrough');
});

test('decide: 超 TTL → expired(即便 intent=grant 也不消费)', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + TTL + 1, TTL), 'expired');
});

test('decide: 恰好 TTL 边界内 → 仍按 intent', () => {
  assert.equal(decideResearchGrantAction(pending(), 'grant', NOW + TTL, TTL), 'grant');
});

// ── bilingual card + deterministic matching of the words WE offered (2026-07-14) ──────────────────
test('renderResearchGrantPrompt: renders in the resolved language, offering that language\'s reply words', () => {
  const zh = renderResearchGrantPrompt('素数分布', 'pariGp', '需要计算', 30 * 60_000, 'zh');
  assert.match(zh, /同意/);
  assert.match(zh, /拒绝/);

  const en = renderResearchGrantPrompt('prime distribution', 'pariGp', 'needs computation', 30 * 60_000, 'en');
  assert.match(en, /approve/);
  assert.match(en, /reject/);
  assert.doesNotMatch(en, /同意/, 'an English card must not tell the owner to reply with a Chinese word');
  assert.match(en, /30 minutes/);
});

test('classifyGrantReply: our own offered words are matched exactly, in BOTH languages', () => {
  // The card handed the user a closed enum. Reading our own vocabulary back is an exact match, not a
  // semantic-classification problem — we have already shipped a bug where a user replied with one of OUR
  // OWN offered words and the general classifier read it as the opposite.
  assert.equal(classifyGrantReply('同意'), 'grant');
  assert.equal(classifyGrantReply('批准'), 'grant');
  assert.equal(classifyGrantReply('approve'), 'grant');
  assert.equal(classifyGrantReply('Approve.'), 'grant');
  assert.equal(classifyGrantReply('拒绝'), 'deny');
  assert.equal(classifyGrantReply('reject'), 'deny');
  assert.equal(classifyGrantReply('「拒绝」'), 'deny');

  // Both vocabularies are accepted regardless of which language the card was rendered in: a bilingual owner
  // will type 同意 at an English card, and being strict there punishes them for a setting they never saw.
  assert.equal(classifyGrantReply('同意'), 'grant');
  assert.equal(classifyGrantReply('no'), 'deny');
});

test('classifyGrantReply: genuinely open language falls through to the semantic classifier', () => {
  // Only OUR enum is matched here. Anything else is real natural language and belongs to the classifier —
  // the rule is "keywords are right when the vocabulary is ours, wrong when it is theirs".
  assert.equal(classifyGrantReply('嗯你先跑吧，我看看结果再说'), null);
  assert.equal(classifyGrantReply('what does pariGp even do?'), null);
  assert.equal(classifyGrantReply(''), null);
});
