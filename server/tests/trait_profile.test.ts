/**
 * WS1 (selfhood_closure): currentTraitProfile — two different lived histories must produce
 * different trait profiles (the design's acceptance criterion), and the kill switch must
 * restore the frozen defaults.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, InitiativeStore, DEFAULT_TRAITS } from '@agent/memory';
import { currentTraitProfile, TASK_COMMITMENT_DRIVE_ID } from '../src/trait_profile.js';

function seedCommitmentScores(handle: ReturnType<typeof openMemoryDb>, scores: number[]) {
  for (const s of scores) {
    const o = handle.driveOutcomes.append({
      driveId: TASK_COMMITMENT_DRIVE_ID,
      triggerSnapshot: {},
      injectedAction: {},
      rootPursuitId: 'root',
    });
    handle.driveOutcomes.setEffectivenessScore(o.id, s);
  }
}

test('currentTraitProfile: different histories -> different personalities; no history -> neutral', () => {
  const env = {} as NodeJS.ProcessEnv;

  // Instance A: pushing itself has consistently paid off
  const a = openMemoryDb(':memory:');
  seedCommitmentScores(a, [0.7, 0.8, 0.9]);
  const pa = currentTraitProfile({ driveOutcomes: a.driveOutcomes }, env);

  // Instance B: pushing itself has consistently failed
  const b = openMemoryDb(':memory:');
  seedCommitmentScores(b, [-0.7, -0.8, -0.9]);
  const pb = currentTraitProfile({ driveOutcomes: b.driveOutcomes }, env);

  // Instance C: no history at all
  const c = openMemoryDb(':memory:');
  const pc = currentTraitProfile({ driveOutcomes: c.driveOutcomes }, env);

  assert.ok(pa.competitiveness > 0.6, `A should be competitive, got ${pa.competitiveness}`);
  assert.ok(pb.competitiveness < 0.4, `B should not be, got ${pb.competitiveness}`);
  assert.notEqual(pa.competitiveness, pb.competitiveness);
  assert.equal(pc.competitiveness, DEFAULT_TRAITS.competitiveness);

  a.close(); b.close(); c.close();
});

test('currentTraitProfile: curiosity from settled initiatives; kill switch freezes to defaults', () => {
  const handle = openMemoryDb(':memory:');
  const initiatives = new InitiativeStore(handle.db);
  // Seed 6 settled curiosity initiatives: 5 done, 1 failed
  for (let i = 0; i < 6; i++) {
    const ini = initiatives.insert({
      kind: 'curiosity_token',
      driver: 'curiosity',
      targetRef: `token:t${i}`,
      rationale: 'test',
      utility: 0.5,
      budgetEstimate: 100,
      plan: [],
    });
    initiatives.markRunning(ini.id);
    if (i < 5) initiatives.markDone(ini.id, 'ok', { facts: [], notes: [], pursuits: [] }, 10);
    else initiatives.markFailed(ini.id, 'boom', 10);
  }
  const env = {} as NodeJS.ProcessEnv;
  const p = currentTraitProfile({ driveOutcomes: handle.driveOutcomes, initiatives }, env);
  assert.ok(p.curiosity > 0.6, `mostly-successful curiosity should exceed 0.6, got ${p.curiosity}`);

  const frozen = currentTraitProfile(
    { driveOutcomes: handle.driveOutcomes, initiatives },
    { PHILONT_TRAITS_LIVE: '0' } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(frozen, DEFAULT_TRAITS);
  handle.close();
});
