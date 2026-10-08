/**
 * ConventionStore tests (2026-10-08): record/dedupe per environment, Jaccard selection with retirement
 * of misleading rules, ACE-style feedback counters, per-environment retention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, CONVENTION_RETIRE_MARGIN } from '../src/index.js';

test('record: one row per (env, rule); re-learning bumps seen; blank rejected; trigger defaults to rule tokens', () => {
  const { conventions } = openMemoryDb(':memory:');
  const a = conventions.record({ envKey: 'convstream', rule: 'When a task creates a status file, name it status.txt in the target directory.', source: 'test -f /opt/x/status.txt', trigger: 'create status file target directory' });
  assert.ok(a);
  assert.equal(a!.seen, 1);
  const b = conventions.record({ envKey: 'convstream', rule: '  when a task creates a status file, name it STATUS.TXT in the target directory.  '.replace('STATUS.TXT', 'status.txt') });
  assert.equal(b!.id, a!.id, 'same rule text (case/space-insensitive) is the same row');
  assert.equal(b!.seen, 2);
  assert.equal(conventions.record({ envKey: 'convstream', rule: '   ' }), null);
  const c = conventions.record({ envKey: 'lab', rule: 'Report files must be named <noun>.txt after the thing counted.' });
  assert.ok(c!.trigger.includes('report'));
  assert.equal(conventions.count('convstream'), 1);
  assert.equal(conventions.count('lab'), 1);
  assert.equal(conventions.count(), 2);
});

test('select: Jaccard over trigger+rule, env-scoped, zero overlap never returned, retired rules hidden', () => {
  const { conventions } = openMemoryDb(':memory:');
  const r1 = conventions.record({ envKey: 'e', rule: 'Create a status.txt file in the working directory when asked to record status.', trigger: 'record status directory' })!;
  const r2 = conventions.record({ envKey: 'e', rule: 'Backups must keep the .bak suffix.', trigger: 'backup copy' })!;
  conventions.record({ envKey: 'other', rule: 'Record status in status.txt.', trigger: 'record status' });
  const hits = conventions.select('e', 'please record the status of the job in the directory');
  assert.deepEqual(hits.map((h) => h.id), [r1.id]);
  assert.equal(conventions.select('e', 'completely unrelated words xyz').length, 0);
  // retire: harmful exceeds helpful by more than the margin
  for (let i = 0; i <= CONVENTION_RETIRE_MARGIN; i++) conventions.feedback([r1.id], false);
  assert.equal(conventions.select('e', 'record the status in the directory').length, 0, 'retired');
  conventions.feedback([r1.id], true);
  conventions.feedback([r1.id], true);
  assert.equal(conventions.select('e', 'record the status in the directory').length, 1, 'back once helpful catches up');
  assert.equal(conventions.get(r2.id)!.harmful, 0);
});

test('feedback: all shown rules credited with the task outcome; list orders by net helpfulness', () => {
  const { conventions } = openMemoryDb(':memory:');
  const a = conventions.record({ envKey: 'e', rule: 'Rule A about permissions 644 on created files.' })!;
  const b = conventions.record({ envKey: 'e', rule: 'Rule B about owner of created directories.' })!;
  conventions.feedback([a.id, b.id], true);
  conventions.feedback([b.id], false);
  assert.equal(conventions.get(a.id)!.helpful, 1);
  assert.equal(conventions.get(b.id)!.helpful, 1);
  assert.equal(conventions.get(b.id)!.harmful, 1);
  assert.deepEqual(conventions.list('e').map((c) => c.id), [a.id, b.id]);
});
