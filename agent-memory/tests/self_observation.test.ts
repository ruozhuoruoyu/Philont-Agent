/**
 * WS4 (selfhood_closure): SelfObservationWriter — ledger-evidenced obs.* self facts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  runSelfObservations,
  listSelfObservations,
  recordRecipeDecayObservation,
  SelfDescriptionWriteForbiddenError,
} from '../src/index.js';

function seedFailures(handle: ReturnType<typeof openMemoryDb>, n: number, result: string) {
  for (let i = 0; i < n; i++) {
    handle.actions.log({
      sessionId: 's1',
      toolName: 'webFetch',
      params: { url: 'https://x' },
      result,
      success: false,
    });
  }
}

test('WS4: repeated same-signature failures produce an evidence-backed observation; clearing works', () => {
  const handle = openMemoryDb(':memory:');
  seedFailures(handle, 4, 'fetch failed: ECONNREFUSED 10.0.0.1:443');

  const run = runSelfObservations({
    facts: handle.facts,
    actions: handle.actions,
    driveOutcomes: handle.driveOutcomes,
  });
  assert.ok(run.written.includes('obs.repeated-failures'), `written=${run.written}`);

  const obs = listSelfObservations(handle.facts);
  assert.equal(obs.length, 1);
  assert.match(obs[0].content, /4 of my tool calls failed/);

  // Evidence refs point at real action rows
  const fact = handle.facts.getFact('self', 'obs.repeated-failures')!;
  const refs = (fact.value as { sourceRefs: string[] }).sourceRefs;
  assert.ok(refs.length >= 3 && refs.every((r) => /^action:\d+$/.test(r)), `refs=${refs}`);

  // Evidence recedes (window moves past the failures) -> observation cleared
  const later = Date.now() + 8 * 86_400_000;
  const run2 = runSelfObservations(
    { facts: handle.facts, actions: handle.actions, driveOutcomes: handle.driveOutcomes },
    later,
  );
  assert.ok(run2.cleared.includes('obs.repeated-failures'));
  assert.equal(listSelfObservations(handle.facts).length, 0);
  handle.close();
});

test('WS4: handoff interventions observation; below threshold stays silent', () => {
  const handle = openMemoryDb(':memory:');
  for (let i = 0; i < 3; i++) {
    handle.driveOutcomes.append({
      driveId: 'task-commitment',
      triggerSnapshot: {},
      injectedAction: {},
      rootPursuitId: 'root',
    });
  }
  const run = runSelfObservations({
    facts: handle.facts,
    actions: handle.actions,
    driveOutcomes: handle.driveOutcomes,
  });
  assert.ok(run.written.includes('obs.handoff-tendency'));
  assert.ok(!run.written.includes('obs.repeated-failures'), 'no failures seeded');
  handle.close();
});

test('WS4: obs.* writes require evidence refs; ordinary storeFact still cannot write self.*', () => {
  const handle = openMemoryDb(':memory:');
  assert.throws(
    () => handle.facts.updateSelfFact('obs.fake', 'no evidence', [], 'self-observation'),
    SelfDescriptionWriteForbiddenError,
  );
  assert.throws(
    () => handle.facts.updateSelfFact('summary', 'not an obs key', ['x'], 'self-observation'),
    SelfDescriptionWriteForbiddenError,
  );
  assert.throws(() =>
    handle.facts.storeFact({ namespace: 'self', key: 'obs.x', value: { t: 1 }, confidence: 1 }),
  );
  // WS5 hook: recipe decay observation with a skill ref
  recordRecipeDecayObservation(handle.facts, 'deploy-flow', 'skill-123');
  const obs = listSelfObservations(handle.facts);
  assert.equal(obs.length, 1);
  assert.match(obs[0].content, /deploy-flow/);
  handle.close();
});
