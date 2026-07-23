/**
 * Every stored reference must resolve. See referential_integrity.ts for why a written lesson was not
 * enough — the class was documented after two instances, and the third shipped anyway.
 *
 * The cases below are the two real defects, reconstructed: a subscription naming a channel that does not
 * resolve (every proactive message dropped, for months), and a DB-only skill the disk prune treats as an
 * orphan (a failure lesson deleted by an unrelated file event).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntegrityChecks,
  runIntegrityChecks,
  renderIntegrityReport,
  KNOWN_REFERENCE_CLASSES,
  type IntegrityCheck,
  type IntegrityDeps,
} from '../src/referential_integrity.js';

const clean: IntegrityDeps = {
  listSubscriptions: () => [],
  resolvePushChannel: () => ({}),
  describePushChannelMiss: () => 'registered=[]',
  listExternalSkills: () => [],
  listDiskSkillNames: () => [],
  listCompassPursuits: () => [],
  compassFocusIds: () => [],
};

function run(over: Partial<IntegrityDeps>) {
  return runIntegrityChecks(buildIntegrityChecks({ ...clean, ...over }));
}

test('the push bug: a subscription whose channel does not resolve is caught', () => {
  const r = run({
    listSubscriptions: () => [{ channel: 'wechat', peer: 'o9cq801SI55@im.wechat' }],
    resolvePushChannel: (c) => (c === 'wechat:o9cq801SI55@im.wechat' ? {} : null),
    describePushChannelMiss: () => 'registered=[wechat:o9cq801SI55@im.wechat]',
  });

  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].check, 'push-subscription→channel');
  assert.match(r.violations[0].consequence, /silently dropped/);
});

test('the hot-reload bug: a DB-only skill the prune can delete is caught', () => {
  const r = run({
    listExternalSkills: () => [
      { name: 'playbook-recovery-009c8741-failed', source: 'auto-recovery:plan-123' },
      { name: 'mycox-service', source: 'clawhub' },
    ],
    listDiskSkillNames: () => ['mycox-service'],
  });

  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].ref, 'playbook-recovery-009c8741-failed');
  assert.match(r.violations[0].consequence, /file event deletes it/);
});

test('a compass pursuit the owner removed from their compass is caught', () => {
  const r = run({
    listCompassPursuits: () => [{ id: 'compass-old-abc12345', title: 'a focus I deleted' }],
    compassFocusIds: () => ['compass-philont-itself-deadbeef'],
  });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].consequence, /removed from your compass/);
});

test('a healthy system reports clean, and says how many checks ran', () => {
  const r = run({
    listSubscriptions: () => [{ channel: 'wechat', peer: 'p' }],
    resolvePushChannel: () => ({}),
    listExternalSkills: () => [{ name: 'ocr-local', source: 'clawhub' }],
    listDiskSkillNames: () => ['ocr-local'],
  });
  assert.equal(r.violations.length, 0);
  assert.match(renderIntegrityReport(r).join('\n'), /3\/3 reference checks pass/);
});

test('a check that throws is SKIPPED, never counted as passing', () => {
  // An integrity checker that reports "all clear" because it crashed is the failure it exists to catch.
  const boom: IntegrityCheck = {
    name: 'explodes',
    invariant: 'never holds',
    run: () => {
      throw new Error('store unavailable');
    },
  };
  const r = runIntegrityChecks([boom]);
  assert.equal(r.violations.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.checked, 0, 'a crashed check must not count as a check that ran');
  assert.match(renderIntegrityReport(r).join('\n'), /treated as UNKNOWN, not as passing/);
});

test('the registry covers every reference class we know about', () => {
  // "We forgot to check the new one" is itself the recurring defect, so it is made catchable.
  const names = buildIntegrityChecks(clean).map((c) => c.name).sort();
  assert.deepEqual(names, [...KNOWN_REFERENCE_CLASSES].sort());
});

test('every violation names a consequence, not just a broken pointer', () => {
  const r = run({
    listSubscriptions: () => [{ channel: 'ghost', peer: 'p' }],
    resolvePushChannel: () => null,
  });
  for (const v of r.violations) {
    assert.ok(v.consequence.length > 15, 'a broken pointer nobody can interpret gets ignored');
  }
});
