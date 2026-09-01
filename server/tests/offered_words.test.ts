/**
 * The invariant behind this week's recurring defect: **every word we print is a word we listen for.**
 *
 * We kept handing the owner a closed enum — "reply 同意提案 <id>", "reply 取消推送", "reply 恢复推送" — and
 * then not listening. The phrases existed in exactly one place each: the card that printed them.
 *   · 同意提案 → nothing matched it, and the store did exact-UUID lookup on an id we only ever printed 8
 *     chars of, so an owner following our on-screen instructions could never approve a constitution change.
 *   · 取消推送 → nothing matched it, and PushSubscriptionStore.unsubscribe() had ZERO callers in the whole
 *     server. We opt people in automatically, tell them how to opt out, and did not listen. There was no way
 *     for a person to make us stop messaging them.
 *
 * These tests bind the promise to the mechanism: if someone edits a card's offered word without teaching the
 * matcher, this file fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  autoSubscribeNotice,
  classifyPushControlReply,
} from '../src/push/auto_subscribe.js';
import { renderCheckInText } from '../src/push/service_driver.js';
import { classifyProposalReply, renderSelfhoodStatusText } from '../src/autonomy_status.js';
import { matchOfferedAuthWord, offeredAuthWords } from '../src/auth_intent.js';
import { classifyGrantReply } from '../src/research_grant.js';
import { renderAuthPromptForWeChat } from '../src/channels/wechat/wechat_render.js';
import { renderAuthPrompt as renderAuthPromptForTelegram } from '../src/channels/telegram/index.js';
import { classifyExploreControlReply } from '../src/explore_control.js';

test('the off-switch we promise in the auto-subscribe notice actually works', () => {
  // We opt the owner IN automatically. The notice is where we promise them a way out.
  for (const lang of ['zh', 'en'] as const) {
    const notice = autoSubscribeNotice(lang);
    const offered = lang === 'zh' ? '取消推送' : 'stop pushing';
    assert.ok(notice.includes(offered), `the ${lang} notice must offer "${offered}"`);
    assert.equal(
      classifyPushControlReply(offered),
      'unsubscribe',
      `we printed "${offered}" — we must listen for it`,
    );
  }
});

test('the way back ON is real too — do not offer an option we ignore', () => {
  // The unsubscribe confirmation says "reply 恢复推送 to get them back". That is another word we printed.
  assert.equal(classifyPushControlReply('恢复推送'), 'resubscribe');
  assert.equal(classifyPushControlReply('resume pushing'), 'resubscribe');
});

test('the digest offers an off-switch, and it is the same one that works', () => {
  const zh = renderCheckInText(30, [], 'zh');
  assert.ok(zh.includes('别推送'));
  assert.equal(classifyPushControlReply('别推送'), 'unsubscribe');

  const en = renderCheckInText(30, [], 'en');
  assert.ok(en.includes('stop pushing'));
  assert.equal(classifyPushControlReply('stop pushing'), 'unsubscribe');
  assert.ok(!en.includes('别推送'), 'an English digest must not tell the owner to reply in Chinese');
});

test('push control words do not hijack ordinary conversation', () => {
  // This runs BEFORE the model on every turn. A false positive would silently switch off the owner's
  // proactive messages — or switch them back on against their wishes.
  assert.equal(classifyPushControlReply('推送这个功能是怎么做的？'), null);
  assert.equal(classifyPushControlReply('取消刚才那个任务'), null);
  assert.equal(classifyPushControlReply('别'), null);
  assert.equal(classifyPushControlReply(''), null);
  // Open-language versions ("你别老给我发消息了") are deliberately NOT matched here — they are intent, not
  // our enum, and belong to the model, which can act on them. What is guaranteed is that the EXACT words we
  // printed always work without depending on the model noticing.
  assert.equal(classifyPushControlReply('你别老给我发消息了'), null);
});

test('the constitution card offers words the matcher accepts, in both languages', () => {
  const s = {
    traits: { live: true, competitiveness: 0.5, curiosity: 0.5, conscientiousness: 0.5 },
    initiativesToday: { done: 0 },
    budget: { llmTokensUsed: 0, toolCallsUsed: 0 },
    pursuits: [],
    observations: [],
    proposals: [{ card: 'p · x', id: 'deadbeef' }],
  } as unknown as Parameters<typeof renderSelfhoodStatusText>[0];

  assert.ok(renderSelfhoodStatusText(s, Date.now(), 'zh').includes('同意提案'));
  assert.ok(classifyProposalReply('同意提案 deadbeef'));
  assert.ok(renderSelfhoodStatusText(s, Date.now(), 'en').includes('approve proposal'));
  assert.ok(classifyProposalReply('approve proposal deadbeef'));
});

function quotedDecisionWords(card: string): string[] {
  const line = card.split('\n').find((candidate) => /(?:Reply|回复).*(?:allow|允许|放行)/.test(candidate));
  assert.ok(line, `missing authorization decision line in:\n${card}`);
  return [...line.matchAll(/["「]([^"」]+)["」]/g)].map((match) => match[1]);
}

test('auth card renderers only print words accepted by the parser', () => {
  const req = { toolName: 'shell', capability: 'execute', domain: 'system', input: {} };
  for (const [lang, renderers] of [
    ['zh', [renderAuthPromptForWeChat, renderAuthPromptForTelegram]],
    ['en', [renderAuthPromptForWeChat, renderAuthPromptForTelegram]],
  ] as const) {
    const previous = process.env.AGENT_LANGUAGE;
    process.env.AGENT_LANGUAGE = lang;
    try {
      for (const render of renderers) {
        const words = quotedDecisionWords(render(req));
        assert.deepEqual(words, [
          ...offeredAuthWords(lang, 'grant'),
          ...offeredAuthWords(lang, 'deny'),
        ]);
        for (const word of words) {
          assert.ok(matchOfferedAuthWord(word), `card prints "${word}" but parser rejects it`);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.AGENT_LANGUAGE;
      else process.env.AGENT_LANGUAGE = previous;
    }
  }
});

test('web-ui authorization copy stays inside the accepted auth vocabulary', () => {
  const source = readFileSync(new URL('../../web-ui/src/chat.ts', import.meta.url), 'utf8');
  const authLines = source.split('\n').filter((line) => /(?:回复|Reply).*(?:批准|grant)/.test(line));
  assert.ok(authLines.length > 0);
  const words = authLines.flatMap((line) =>
    [...line.matchAll(/["「]([^"」]+)["」]/g)].map((match) => match[1]),
  ).filter((word) => !word.includes('${'));
  for (const word of words) {
    assert.ok(matchOfferedAuthWord(word), `web-ui prints "${word}" but parser rejects it`);
  }
});

test('the deep_explore cards offer words the control layer accepts, in both languages', () => {
  // The follow-up card: 「要清理某个说"放弃 <它>",或"全清"」 / 'abandon <name>' / 'clear all'.
  // The auto-advance pause card: 「回复"自动推进"再加一批,或"停"」 / 'auto advance' / 'stop'.
  // All four were words nobody listened for — the verbs behind them (setSessionStatus, setAutoAdvance) were
  // fully built and simply never plumbed to the words.
  for (const [word, kind] of [
    ['放弃', 'abandon'],
    ['abandon', 'abandon'],
    ['全清', 'abandon_all'],
    ['clear all', 'abandon_all'],
    ['自动推进', 'auto_advance'],
    ['auto advance', 'auto_advance'],
    ['继续', 'resume_batch'],
    ['continue', 'resume_batch'],
    ['停', 'stop_auto'],
    ['stop', 'stop_auto'],
  ] as const) {
    const r = classifyExploreControlReply(word);
    assert.ok(r, `we print "${word}" on a card — we must listen for it`);
    assert.equal(r!.kind, kind);
  }
});

test('the formal auto-advance admission card offers words the grant matcher answers', () => {
  // The card is raised by a background driver and answered in whatever conversation the owner is in,
  // so the words on it are the entire interface. 同意/拒绝 and approve/reject must all land.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const start = src.indexOf('function requestFormalAutoAdmission');
  assert.ok(start > 0, 'the admission card function still exists');
  const card = src.slice(start, start + 2500);
  for (const word of ['同意', '拒绝', 'approve', 'reject']) {
    assert.ok(card.includes(word), `the card offers "${word}"`);
  }
  assert.equal(classifyGrantReply('同意'), 'grant');
  assert.equal(classifyGrantReply('拒绝'), 'deny');
  assert.equal(classifyGrantReply('approve'), 'grant');
  assert.equal(classifyGrantReply('reject'), 'deny');
});
