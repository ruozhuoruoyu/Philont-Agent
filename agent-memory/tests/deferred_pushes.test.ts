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

test('a kind that stopped being deferrable can be discarded wholesale', () => {
  const h = openMemoryDb(':memory:');
  h.deferredPushes.enqueue({ channel: 'wechat', peer: 'owner', severity: 'urgent', kind: 'deep_explore:auto_heartbeat',
    targetRef: 'a', text: '本轮已运行 5 分钟', expiresAt: 90_000 }, 1_000);
  h.deferredPushes.enqueue({ channel: 'wechat', peer: 'owner', severity: 'urgent', kind: 'deep_explore:auto_heartbeat',
    targetRef: 'b', text: '本轮已运行 10 分钟', expiresAt: 90_000 }, 2_000);
  h.deferredPushes.enqueue({ channel: 'wechat', peer: 'owner', severity: 'urgent', kind: 'deep_explore:auto_milestone',
    targetRef: 'c', text: 'proved 1', expiresAt: 90_000 }, 3_000);
  assert.equal(h.deferredPushes.discardKind('deep_explore:auto_heartbeat'), 2);
  assert.equal(h.deferredPushes.count(), 1, 'the milestone is still owed');
  assert.equal(h.deferredPushes.listPending('wechat', 'owner', 3, 4_000)[0]?.kind, 'deep_explore:auto_milestone');
  h.close();
});

test('a report series can be trimmed to its newest member by targetRef prefix, with LIKE wildcards escaped', () => {
  const h = openMemoryDb(':memory:');
  const row = (kind: string, targetRef: string, peer = 'owner') => h.deferredPushes.enqueue({
    channel: 'wechat', peer, severity: 'urgent', kind, targetRef, text: targetRef, expiresAt: 99_000,
  }, 1_000);
  row('m', 'deep_explore:progress:A:1');
  row('m', 'deep_explore:progress:A:2');
  const keep = row('m', 'deep_explore:progress:A:3');
  row('m', 'deep_explore:progress:AB:1'); // a different session whose id merely starts the same
  row('m', 'deep_explore:progress:B:1');
  row('other', 'deep_explore:progress:A:9'); // same series, different kind
  row('m', 'deep_explore:progress:A:1', 'someone-else');
  assert.equal(h.deferredPushes.discardSeries('wechat', 'owner', 'm', 'deep_explore:progress:A:', keep.id), 2);
  const left = h.deferredPushes.listPending('wechat', 'owner', 10, 2_000).map((p) => `${p.kind} ${p.targetRef}`).sort();
  assert.deepEqual(left, ['m deep_explore:progress:A:3', 'm deep_explore:progress:AB:1', 'm deep_explore:progress:B:1', 'other deep_explore:progress:A:9']);
  assert.equal(h.deferredPushes.listPending('wechat', 'someone-else', 10, 2_000).length, 1, 'another peer\'s mailbox is untouched');
  // No keepId: the whole series goes. Wildcards in the prefix are literal.
  row('m', 'x%y:1');
  row('m', 'xzy:1');
  assert.equal(h.deferredPushes.discardSeries('wechat', 'owner', 'm', 'x%y:'), 1);
  assert.equal(h.deferredPushes.discardSeries('wechat', 'owner', 'm', 'deep_explore:progress:A:'), 1);
  assert.equal(h.deferredPushes.discardSeries('wechat', 'owner', 'm', ''), 0, 'an empty prefix never matches everything');
  h.close();
});
