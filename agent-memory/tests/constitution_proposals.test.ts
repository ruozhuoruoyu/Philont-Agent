/**
 * WS3 (selfhood_closure): constitution proposals — propose, dedup/suppress, surface rate-limit,
 * owner-ratified append-only amendment, red-line immutability, drive_reflector producer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SELF_REFERENCE_NOTE,
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

test('WS3: with NO configured driveBounds, the built-in 30min cap applies and over-cap tuning files a proposal', async () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  ensureK8DriveConfigs(handle.driveConfigs, ROOT);
  // No setConstitution call: driveBounds are absent (the prod condition).
  // Put the cooldown at the built-in cap so the doubling attempt must exceed it.
  handle.driveConfigs.updateParams(k8DriveConfigId('curiosity'), { cooldownMs: 1_800_000 });
  for (let i = 0; i < 6; i++) {
    handle.driveOutcomes.append({
      driveId: k8DriveConfigId('curiosity'),
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
  assert.equal(res.tuneSkippedOutOfBounds, 1, 'doubling past the built-in cap must be skipped');
  // cooldown unchanged (capped), and the owner got a ratifiable proposal instead
  const cd = handle.driveConfigs.get(k8DriveConfigId('curiosity'))!.params.cooldownMs;
  assert.equal(cd, 1_800_000);
  const pending = store.listPending(ROOT);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'drive_bounds');
  handle.close();
});

// ── the id we PRINT must be the id we ACCEPT (2026-07-14) ────────────────────────────────────────
//
// The /autonomy panel prints `id.slice(0, 8)` and tells the owner to reply "approve proposal <first 8
// chars>". Lookup was `WHERE id = ?` — exact. So an owner following our own on-screen instructions could
// NEVER approve a constitution amendment: the identifier we showed them was not one the store would accept,
// and nobody (human or LLM — it transposes hex digits) can retype a 36-char UUID from memory.
test('getByIdOrPrefix: the 8-char prefix we print on screen actually resolves', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  const p = store.propose(annotationInput())!;

  const printed = p.id.slice(0, 8); // exactly what the /autonomy panel shows the owner
  assert.equal(store.get(printed), null, 'exact lookup cannot resolve the printed prefix — this was the bug');
  assert.equal(store.getByIdOrPrefix(printed)?.id, p.id, 'the printed prefix must resolve');
  assert.equal(store.getByIdOrPrefix(p.id)?.id, p.id, 'a full id still resolves');
});

test('getByIdOrPrefix: refuses to guess rather than amend the wrong constitution', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  const p = store.propose(annotationInput())!;

  assert.equal(store.getByIdOrPrefix('zzzzzzzz'), null, 'no match → null');
  assert.equal(store.getByIdOrPrefix('a'), null, 'too short to be unambiguous → refuse, do not guess');
  assert.equal(store.getByIdOrPrefix(''), null);
  // Silently amending the WRONG proposal is far worse than asking the owner again.
  assert.ok(store.getByIdOrPrefix(p.id.slice(0, 8)), 'sanity: the unambiguous case still works');
});

test('decide: the reject path accepts the printed prefix too', () => {
  const handle = openMemoryDb(':memory:');
  const store = new ConstitutionProposalStore(handle.db);
  const p = store.propose(annotationInput())!;

  const rejected = store.decide(p.id.slice(0, 8), 'rejected');
  assert.equal(rejected?.id, p.id, 'reject had the same exact-match defect as approve');
  assert.equal(store.get(p.id)?.status, 'rejected');
  // A decided proposal is no longer pending, so the prefix no longer resolves — no double-decide.
  assert.equal(store.decide(p.id.slice(0, 8), 'approved'), null);
});

// 2026-07-15: the shared self-reference note that sub-agent prompts (deep_explore rounds, skeptics,
// grounding) prepend so a research sub-agent knows "philont" is its own name, not an external tool to search.
test('AGENT_SELF_REFERENCE_NOTE: states that philont means this agent itself', () => {
  const note = AGENT_SELF_REFERENCE_NOTE;
  assert.equal(typeof note, 'string');
  assert.match(note, /philont/);
  assert.match(note, /this agent itself|this very system/i);
  // General, not a symptom-enumerating patch — it must NOT list specific triggers like "benchmark".
  assert.doesNotMatch(note, /benchmark/i);
});
