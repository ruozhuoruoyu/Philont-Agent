import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatcher } from '../src/channels/wechat/index.js';
import { OutboundQueue, type RawSender } from '../src/channels/wechat/outbound.js';

const logger = { info() {}, warn() {}, error() {} };
const event = {
  messageId: 'm-in', fromUserId: 'owner', groupId: '', text: 'hi', contextToken: 'ctx', raw: {} as any,
};

test('next inbound appends one deferred notice to the normal reply in a single send and then acks', async () => {
  const calls: string[] = [];
  const sender: RawSender = async (_to, text) => {
    calls.push(text);
    return { ok: true, messageId: 'm-out' };
  };
  let acked = false;
  const dispatch = makeDispatcher({
    accountId: 'account', outbound: new OutboundQueue(sender), logger,
    chatSend: async (_sid, _text, onDelta) => { onDelta('## For User\nnormal reply'); },
    deferredPushes: {
      pruneExpired: () => 0,
      listPending: () => [{ id: 'd1', kind: 'health_selfcheck', text: 'daily health report' }],
      markManyDelivered: (ids) => { acked = ids.includes('d1'); return acked ? 1 : 0; },
    },
  });

  await dispatch(event);
  assert.equal(calls.length, 1, 'reply and deferred notice must share one iLink send allowance');
  assert.match(calls[0], /normal reply/);
  assert.match(calls[0], /daily health report/);
  assert.equal(acked, true);
});

test('a rejected combined reply does not consume the deferred notice', async () => {
  const sender: RawSender = async () => ({ ok: false, retry: 'next_inbound', code: -2 });
  let acked = false;
  const dispatch = makeDispatcher({
    accountId: 'account', outbound: new OutboundQueue(sender), logger,
    chatSend: async (_sid, _text, onDelta) => { onDelta('## For User\nnormal reply'); },
    deferredPushes: {
      pruneExpired: () => 0,
      listPending: () => [{ id: 'd1', kind: 'health_selfcheck', text: 'daily health report' }],
      markManyDelivered: () => { acked = true; return 1; },
    },
  });

  await dispatch(event);
  assert.equal(acked, false, 'peek is not consumption; only a complete send may acknowledge');
});

test('an authorization card takes priority and leaves deferred notices untouched', async () => {
  const calls: string[] = [];
  const sender: RawSender = async (_to, text) => { calls.push(text); return { ok: true }; };
  let acked = false;
  const dispatch = makeDispatcher({
    accountId: 'account', outbound: new OutboundQueue(sender), logger,
    chatSend: async (_sid, _text, _delta, onAuth) => {
      onAuth({ toolName: 'shell', capability: 'execute', domain: 'local', input: { command: 'echo ok' } });
    },
    deferredPushes: {
      pruneExpired: () => 0,
      listPending: () => [{ id: 'd1', kind: 'health_selfcheck', text: 'daily health report' }],
      markManyDelivered: () => { acked = true; return 1; },
    },
  });

  await dispatch(event);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /shell/);
  assert.doesNotMatch(calls[0], /daily health report/);
  assert.equal(acked, false);
});

test('bounded batching appends at most three notices and marks truncation explicitly', async () => {
  const calls: string[] = [];
  const sender: RawSender = async (_to, text) => { calls.push(text); return { ok: true }; };
  let requestedLimit = 0;
  let acked: readonly string[] = [];
  const dispatch = makeDispatcher({
    accountId: 'account', outbound: new OutboundQueue(sender), logger,
    chatSend: async (_sid, _text, onDelta) => { onDelta('## For User\nreply'); },
    deferredPushes: {
      pruneExpired: () => 2,
      listPending: (_c, _p, limit = 0) => {
        requestedLimit = limit;
        return [
          { id: 'u1', kind: 'urgent', text: 'x'.repeat(2000) },
          { id: 'd1', kind: 'digest', text: 'y'.repeat(200) },
        ];
      },
      markManyDelivered: (ids) => { acked = ids; return ids.length; },
    },
  });

  await dispatch(event);
  assert.equal(requestedLimit, 3);
  assert.match(calls[0], /通知内容已截断|notice truncated/);
  assert.deepEqual(acked, ['u1'], 'the item that did not fit remains pending');
});
