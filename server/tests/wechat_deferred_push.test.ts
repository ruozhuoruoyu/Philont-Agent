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
      peek: () => ({ id: 'd1', kind: 'health_selfcheck', text: 'daily health report' }),
      markDelivered: (id) => { acked = id === 'd1'; return acked; },
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
      peek: () => ({ id: 'd1', kind: 'health_selfcheck', text: 'daily health report' }),
      markDelivered: () => { acked = true; return true; },
    },
  });

  await dispatch(event);
  assert.equal(acked, false, 'peek is not consumption; only a complete send may acknowledge');
});
