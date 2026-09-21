import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressRelay, startProgressTicker } from '../src/task_progress.js';

test('activity chatter cannot spend the milestone allowance; heartbeat reserves a milestone slot', async () => {
  const sent: string[] = [];
  const relay = createProgressRelay({ send: async (text) => { sent.push(text); return true; }, receipt() {} });
  for (let i = 0; i < 20; i++) relay.offer('checking');
  relay.offer('still running', { kind: 'heartbeat' });
  relay.offer('still running later', { kind: 'heartbeat' });
  relay.offer('compiled first lemma', { kind: 'milestone' });
  relay.offer('compiled second lemma', { kind: 'milestone' });
  assert.deepEqual(await relay.drain(), ['compiled second lemma']);
  assert.deepEqual(sent, ['still running', 'compiled first lemma']);
});

test('failed delivery retains a milestone and is not reported as delivered', async () => {
  const receipts: boolean[] = [];
  const relay = createProgressRelay({ send: async () => false, receipt: (_kind, ok) => receipts.push(ok) });
  relay.offer('stage one', { kind: 'milestone' });
  assert.deepEqual(await relay.drain(), ['stage one']);
  assert.deepEqual(receipts, [false]);
});

test('periodic reports stop when the task ends', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reports = 0;
  const stop = startProgressTicker(() => reports++, 300_000);
  t.mock.timers.tick(300_000);
  assert.equal(reports, 1);
  stop();
  t.mock.timers.tick(600_000);
  assert.equal(reports, 1);
});

test('a channel can refuse a heartbeat outright and hold a milestone for the final reply (2026-09-21)', async () => {
  const sent: string[] = [];
  const skipped: string[] = [];
  const relay = createProgressRelay({
    send: async (text) => { sent.push(text); return true; },
    receipt() {},
    canSend: (kind) => kind !== 'heartbeat' && kind !== 'milestone',
    skipped: (kind, reason) => skipped.push(`${kind}:${reason}`),
  });
  relay.offer('已运行 5 分钟', { kind: 'heartbeat' });
  relay.offer('闭合了一个节点', { kind: 'milestone' });
  const unsent = await relay.drain();
  assert.deepEqual(sent, []);
  assert.deepEqual(skipped, ['heartbeat:allowance_reserved', 'milestone:allowance_reserved']);
  assert.deepEqual(unsent, ['闭合了一个节点'], 'the milestone rides the final reply; the heartbeat is dropped');
});
