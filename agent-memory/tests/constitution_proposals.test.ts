/**
 * WS3 (selfhood_closure): constitution proposals — propose, dedup/suppress, surface rate-limit,
 * owner-ratified append-only amendment, red-line immutability, drive_reflector producer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  ConstitutionProposalStore,
  approveAndApply,
  renderProposalCard,
  SessionDriveReflector,
  ensureK8DriveConfigs,
  k8DriveConfigId,
  BOOTSTRAP_ROOT_PURSUIT_ID,
} from '../src/index.js';

const ROOT = BOOTSTRAP_ROOT_PURSUIT_ID;

function annotationInput(text = 'prefer arxiv sources for math topics') {
  return {
    rootPursuitId: ROOT,
    kind: 'value_annotation' as const,
    payload: { text },
    rationale: 'owner overrode default source ranking 3 times',
    evidenceRefs: ['action:1', 'action:2'],
  };
}

test('WS3: propose dedups pending; rejection suppresses identical content for 30d', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  const p1 = store.propose(annotationInput())!;
  const p2 = store.propose(annotationInput())!;
  assert.equal(p1.id, p2.id, 'identical pending content must not duplicate');

  store.decide(p1.id, 'rejected');
  assert.equal(store.propose(annotationInput()), null, 'rejected content suppressed');
  // After 30 days the same content may be proposed again
  const later = Date.now() + 31 * 86_400_000;
  assert.ok(store.propose(annotationInput(), later), 're-proposable after suppression window');
  handle.close();
});

test('WS3: surface rate limit — one proposal per 24h', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  const now = Date.now();
  const a = store.propose(annotationInput('a'), now)!;
  store.propose(annotationInput('b'), now);

  const first = store.nextToSurface(ROOT, now)!;
  assert.equal(first.id, a.id, 'oldest pending surfaces first');
  store.markSurfaced(first.id, now);
  assert.equal(store.nextToSurface(ROOT, now + 60_000), null, 'nothing else within 24h');
  assert.ok(store.nextToSurface(ROOT, now + 25 * 3_600_000), 'next one after 24h');
  assert.match(renderProposalCard(first), /I propose to append a value annotation/);
  handle.close();
});

test('WS3: approve appends annotation with provenance; red lines never change; hash audited', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  handle.pursuits.setConstitution(ROOT, {
    values: 'curiosity harnessed',
    redLines: ['never fabricate success'],
  });
  const hashBefore = handle.pursuits.computeConstitutionHash(ROOT);

  const events: Array<Record<string, unknown>> = [];
  const p = store.propose(annotationInput())!;
  const applied = approveAndApply(store, handle.pursuits, p.id, {
    append: (_kind: string, payload: unknown) => events.push(payload as Record<string, unknown>),
  } as never);
  assert.equal(applied.status, 'approved');

  const after = handle.pursuits.getConstitution(ROOT)!;
  assert.match(after.values!, /^curiosity harnessed\n\[amendment \d{4}-\d{2}-\d{2}/, 'append-only');
  assert.match(after.values!, /prefer arxiv sources/);
  assert.deepEqual(after.redLines, ['never fabricate success'], 'red lines untouched');
  assert.notEqual(handle.pursuits.computeConstitutionHash(ROOT), hashBefore);
  const amendEvent = events.find((e) => e.toolName === 'constitution_amend');
  assert.ok(amendEvent && typeof amendEvent.constitutionHash === 'string', 'hash audited');

  // Double-apply refused
  assert.throws(() => approveAndApply(store, handle.pursuits, p.id));
  handle.close();
});

test('WS3: approve widens drive bounds to include the proposed value', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  handle.pursuits.setConstitution(ROOT, {
    driveBounds: { 'k8-gap': { cooldownMs: [1000, 600_000] } },
  });
  const p = store.propose({
    rootPursuitId: ROOT,
    kind: 'drive_bounds',
    payload: { driveId: 'k8-gap', param: 'cooldownMs', currentRange: [1000, 600_000], proposedValue: 1_200_000 },
    rationale: 'sustained low EWMA',
    evidenceRefs: ['drive-config:k8-gap'],
  })!;
  approveAndApply(store, handle.pursuits, p.id);
  const bounds = handle.pursuits.getConstitution(ROOT)!.driveBounds!;
  assert.deepEqual(bounds['k8-gap'].cooldownMs, [1000, 1_200_000]);
  handle.close();
});

test('WS3: drive_reflector out-of-bounds tuning files a ratifiable proposal', async () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  ensureK8DriveConfigs(handle.driveConfigs, ROOT);
  // Tight bound so the doubling proposal (60s -> 120s) lands out of bounds
  // NOTE: the reflector looks bounds up by cfg.KIND ('gap'), not by config id ('k8-gap').
  handle.pursuits.setConstitution(ROOT, {
    driveBounds: { gap: { cooldownMs: [1000, 90_000] } },
  });
  for (let i = 0; i < 6; i++) {
    handle.driveOutcomes.append({
      driveId: k8DriveConfigId('gap'),
      triggerSnapshot: {},
      injectedAction: {},
      subsequentToolCalls: [{ ok: false }, { ok: false }],
      rootPursuitId: ROOT,
    });
  }
  const reflector = new SessionDriveReflector(
    handle.driveOutcomes,
    handle.driveConfigs,
    handle.pursuits,
    { rootPursuitId: ROOT, proposals: store },
  );
  const res = await reflector.reflect();
  assert.equal(res.tuneSkippedOutOfBounds, 1);
  const pending = store.listPending(ROOT);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'drive_bounds');
  assert.match(pending[0].rationale, /outside the constitution bound/);
  handle.close();
});
