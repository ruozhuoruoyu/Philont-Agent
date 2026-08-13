import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../agent-memory/src/index.js';
import { maintainDeferredPushes } from '../src/deferred_push_maintenance.js';

test('mailbox maintenance expires and reports rows without any WeChat gateway', () => {
  const h = openMemoryDb(':memory:');
  h.deferredPushes.enqueue({
    channel: 'telegram:bot', peer: 'owner-secret', severity: 'urgent', kind: 'research_update',
    targetRef: 'private-target', text: 'private body', expiresAt: 2_000,
  }, 1_000);
  const warnings: Array<{ message: string; detail: unknown }> = [];
  const result = maintainDeferredPushes(
    h.deferredPushes, h.metrics,
    { warn: (message, detail) => warnings.push({ message, detail }) }, 3_000,
  );
  assert.deepEqual(result, {
    count: 1, byKind: { research_update: 1 }, byChannel: { 'telegram:bot': 1 },
  });
  assert.equal(h.deferredPushes.count(), 0);
  assert.equal(h.metrics.get('push.deferred_expired.day.1970-01-01'), 1);
  assert.doesNotMatch(JSON.stringify(warnings), /owner-secret|private-target|private body/);
  h.close();
});
