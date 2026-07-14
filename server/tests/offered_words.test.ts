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
import {
  autoSubscribeNotice,
  classifyPushControlReply,
} from '../src/push/auto_subscribe.js';
import { renderCheckInText } from '../src/push/service_driver.js';
import { classifyProposalReply, renderSelfhoodStatusText } from '../src/autonomy_status.js';
import { matchOfferedAuthWord } from '../src/auth_intent.js';

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

test('the auth card offers words the matcher accepts, in both languages', () => {
  // Rendered by renderResearchGrantPrompt / the channel auth cards: "回复「同意」/「拒绝」", "approve / reject".
  for (const w of ['同意', '拒绝', 'approve', 'reject']) {
    assert.ok(matchOfferedAuthWord(w), `we print "${w}" on the auth card — we must match it exactly`);
  }
});
