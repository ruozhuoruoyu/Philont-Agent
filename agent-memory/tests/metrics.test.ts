/**
 * MetricsStore — atomic increment, set, get, snapshot. Backs the self-learning instrumentation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('increment creates then accumulates', () => {
  const h = openMemoryDb(':memory:');
  assert.equal(h.metrics.get('routing.inject.turns'), 0);
  h.metrics.increment('routing.inject.turns');
  h.metrics.increment('routing.inject.turns');
  h.metrics.increment('routing.inject.rules', 5);
  assert.equal(h.metrics.get('routing.inject.turns'), 2);
  assert.equal(h.metrics.get('routing.inject.rules'), 5);
  h.close();
});

test('set overwrites (gauge / day-stamp)', () => {
  const h = openMemoryDb(':memory:');
  h.metrics.increment('x', 10);
  h.metrics.set('x', 3);
  assert.equal(h.metrics.get('x'), 3);
  h.close();
});

test('snapshot returns all counters sorted by key', () => {
  const h = openMemoryDb(':memory:');
  h.metrics.increment('b.key', 2);
  h.metrics.increment('a.key', 1);
  const snap = h.metrics.snapshot();
  assert.deepEqual(snap.map((r) => r.key), ['a.key', 'b.key']);
  assert.equal(snap[0].count, 1);
  h.close();
});

test('get of unknown key is 0; never throws', () => {
  const h = openMemoryDb(':memory:');
  assert.equal(h.metrics.get('never.seen'), 0);
  h.close();
});

test('counters persist across reopen of the same file', () => {
  const tmp = `/tmp/philont_metrics_test_${process.pid}.sqlite`;
  const h1 = openMemoryDb(tmp);
  h1.metrics.increment('reflect.fire', 4);
  h1.close();
  const h2 = openMemoryDb(tmp);
  assert.equal(h2.metrics.get('reflect.fire'), 4);
  h2.close();
});
