import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('deferred pushes upsert by semantic identity and acknowledge only explicitly', () => {
  const h = openMemoryDb(':memory:');
  const first = h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'digest', kind: 'health_selfcheck',
    targetRef: 'health:daily', text: 'old', expiresAt: 20_000,
  }, 1_000);
  const updated = h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'digest', kind: 'health_selfcheck',
    targetRef: 'health:daily', text: 'new', expiresAt: 30_000,
  }, 2_000);

  assert.equal(h.deferredPushes.count(), 1);
  assert.equal(updated.id, first.id);
  assert.equal(h.deferredPushes.peek('wechat', 'owner', 3_000)?.text, 'new');
  assert.equal(h.deferredPushes.count(), 1, 'peek must not consume before a confirmed send');
  assert.equal(h.deferredPushes.markDelivered(first.id), true);
  assert.equal(h.deferredPushes.count(), 0);
  h.close();
});

test('deferred pushes expire and urgent notices are selected before digests', () => {
  const h = openMemoryDb(':memory:');
  h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'digest', kind: 'old',
    targetRef: 'old', text: 'expired', expiresAt: 2_000,
  }, 1_000);
  h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'digest', kind: 'digest',
    targetRef: 'd', text: 'digest', expiresAt: 20_000,
  }, 1_100);
  h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'urgent', kind: 'urgent',
    targetRef: 'u', text: 'urgent', expiresAt: 20_000,
  }, 1_200);

  assert.equal(h.deferredPushes.pruneExpired(3_000), 1);
  assert.deepEqual(h.deferredPushes.listPending('wechat', 'owner', 3, 3_000).map((p) => p.text), ['urgent', 'digest']);
  assert.equal(h.deferredPushes.count(), 2, 'expired rows are pruned');
  h.close();
});
