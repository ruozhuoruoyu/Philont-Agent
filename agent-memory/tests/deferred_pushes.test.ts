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
  assert.equal(h.deferredPushes.listPending('wechat', 'owner', 1, 3_000)[0]?.text, 'new');
  assert.equal(h.deferredPushes.count(), 1, 'listing must not consume before a confirmed send');
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

  assert.deepEqual(h.deferredPushes.pruneExpired(3_000), {
    count: 1, byKind: { old: 1 }, byChannel: { wechat: 1 },
  });
  assert.deepEqual(h.deferredPushes.listPending('wechat', 'owner', 3, 3_000).map((p) => p.text), ['urgent', 'digest']);
  assert.equal(h.deferredPushes.count(), 2, 'expired rows are pruned');
  h.close();
});

test('an ordinary write never deletes an expired row, and never hands it out either', () => {
  const h = openMemoryDb(':memory:');
  h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'digest', kind: 'old',
    targetRef: 'old', text: 'expired', expiresAt: 2_000,
  }, 1_000);

  // Deleting an expiry is the exclusive right of the maintenance path that can persist the account of
  // it; a plain enqueue has nowhere to record what it removed, so it must remove nothing.
  h.deferredPushes.enqueue({
    channel: 'wechat', peer: 'owner', severity: 'urgent', kind: 'new',
    targetRef: 'n', text: 'fresh', expiresAt: 90_000,
  }, 80_000);
  assert.equal(h.deferredPushes.count(), 2, 'the expired row survives an unrelated write');

  // Correctness of reads does not depend on the row being gone: expiry is enforced by the query.
  assert.deepEqual(h.deferredPushes.listPending('wechat', 'owner', 3, 80_000).map((p) => p.text), ['fresh']);

  assert.equal(h.deferredPushes.pruneExpired(80_000).count, 1, 'maintenance is what reclaims it');
  assert.equal(h.deferredPushes.count(), 1);
  h.close();
});
