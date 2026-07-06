/**
 * WS6 (selfhood_closure): first-contact push auto-subscribe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import {
  parseDmPeerFromSessionId,
  maybeAutoSubscribe,
  AUTO_SUBSCRIBE_NOTICE,
} from '../src/push/auto_subscribe.js';

test('parseDmPeerFromSessionId: DM formats parse, groups and non-channels do not', () => {
  assert.deepEqual(parseDmPeerFromSessionId('wechat:acct1:user42'), {
    channel: 'wechat',
    peer: 'user42',
  });
  assert.deepEqual(parseDmPeerFromSessionId('telegram:bot9:12345'), {
    channel: 'telegram',
    peer: '12345',
  });
  assert.equal(parseDmPeerFromSessionId('wechat:acct1:group:g1:user42'), null);
  assert.equal(parseDmPeerFromSessionId('telegram:bot9:group:g1:u'), null);
  assert.equal(parseDmPeerFromSessionId('7d4c2a-web-ui-uuid'), null);
  assert.equal(parseDmPeerFromSessionId('system:scheduled:daily'), null);
});

test('maybeAutoSubscribe: creates once, respects prior unsubscribe, honors kill switch', () => {
  const handle = openMemoryDb(':memory:');
  const store = handle.pushSubscriptions;
  const env = {} as NodeJS.ProcessEnv;

  // First contact creates the row and returns the notice
  const notice = maybeAutoSubscribe(store, 'wechat:acct1:user42', env);
  assert.equal(notice, AUTO_SUBSCRIBE_NOTICE);
  assert.equal(store.get('wechat', 'user42')?.enabled, true);

  // Second contact: row exists -> no-op
  assert.equal(maybeAutoSubscribe(store, 'wechat:acct1:user42', env), null);

  // Prior unsubscribe (soft-deleted row) is authoritative -> never re-subscribed here
  store.unsubscribe('wechat', 'user42');
  assert.equal(maybeAutoSubscribe(store, 'wechat:acct1:user42', env), null);
  assert.equal(store.get('wechat', 'user42')?.enabled, false);

  // Kill switch
  assert.equal(
    maybeAutoSubscribe(store, 'telegram:bot9:777', { PHILONT_PUSH_AUTOSUBSCRIBE: '0' } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(store.get('telegram', '777'), null);

  // Group session never subscribes
  assert.equal(maybeAutoSubscribe(store, 'wechat:acct1:group:g1:user42', env), null);
  handle.close();
});
