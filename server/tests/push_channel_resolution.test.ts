/**
 * A subscription's channel name must resolve to the registered channel.
 *
 * Production, 2026-07-22: an urgent deep_explore followup was skipped as `channel_not_found` for
 * `wechat:o9cq…@im.wechat` — a channel the same log had shown being registered at startup. The two sides
 * were written to different conventions: a channel registers as `wechat:<accountId>`, while a subscription
 * stores what parseDmPeerFromSessionId reads out of the session id, which is the bare `wechat`. Exact Map
 * lookup missed every time, so EVERY proactive push on both messaging channels was silently dropped, while
 * startup printed "proactive findings can reach you".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPushChannel,
  findPushChannel,
  describePushChannelMiss,
  _resetPushChannelsForTest,
  type PushChannel,
} from '../src/push/channel.js';

function chan(name: string): PushChannel {
  return { name, isReady: () => true, pushText: async () => ({ ok: true }) };
}

test('the bare channel a subscription stores resolves to the account-qualified registration', () => {
  _resetPushChannelsForTest();
  registerPushChannel(chan('wechat:o9cq801SI55LNCfpPkrmkUwB0hlU@im.wechat'));

  const found = findPushChannel('wechat');

  assert.ok(found, 'this is the production case — it must resolve');
  assert.equal(found!.name, 'wechat:o9cq801SI55LNCfpPkrmkUwB0hlU@im.wechat');
  _resetPushChannelsForTest();
});

test('telegram carries the identical convention split', () => {
  _resetPushChannelsForTest();
  registerPushChannel(chan('telegram:123456'));
  assert.equal(findPushChannel('telegram')?.name, 'telegram:123456');
  _resetPushChannelsForTest();
});

test('an exact name still wins over prefix resolution', () => {
  _resetPushChannelsForTest();
  registerPushChannel(chan('wechat'));
  registerPushChannel(chan('wechat:acct'));
  assert.equal(findPushChannel('wechat')?.name, 'wechat');
  _resetPushChannelsForTest();
});

test('two accounts under one prefix do NOT resolve — a bare name does not name a target', () => {
  _resetPushChannelsForTest();
  registerPushChannel(chan('wechat:a'));
  registerPushChannel(chan('wechat:b'));

  assert.equal(findPushChannel('wechat'), null, 'silently picking one would route a private digest through the wrong account');
  assert.match(describePushChannelMiss('wechat'), /ambiguous: 2 accounts/);
  _resetPushChannelsForTest();
});

test('the miss is explained, not just reported', () => {
  _resetPushChannelsForTest();
  assert.match(describePushChannelMiss('wechat'), /no push channel is registered at all/);
  registerPushChannel(chan('telegram:9'));
  assert.match(describePushChannelMiss('wechat'), /registered=\[telegram:9\]/);
  _resetPushChannelsForTest();
});

test('an unrelated prefix does not resolve', () => {
  _resetPushChannelsForTest();
  registerPushChannel(chan('wechat:a'));
  assert.equal(findPushChannel('slack'), null);
  assert.equal(findPushChannel('wecha'), null, 'prefix matching is on the separator, not on characters');
  _resetPushChannelsForTest();
});
