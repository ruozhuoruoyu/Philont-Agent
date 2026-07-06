/**
 * WS2 (selfhood_closure): drive_config read-back — the full circle:
 * seed rows -> initiative outcomes -> reflector scores/tunes cooldownMs -> loop throttles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  startAutonomousLoop,
  GapDriver,
  StandardExecutor,
  SessionDriveReflector,
  ensureK8DriveConfigs,
  readK8DriverCooldowns,
  k8DriveOutcomeInput,
  k8DriveConfigId,
  DEFAULT_K8_COOLDOWN_MS,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type ExtractorLlmClient,
  type ToolRunResult,
  type ToolRunner,
} from '../src/index.js';

function llmReturning(out: string): ExtractorLlmClient {
  return { async complete() { return { text: out, tokensUsed: 200 }; } };
}
function tools(map: Record<string, ToolRunResult>): ToolRunner {
  return { async run(name) { return map[name] ?? { ok: false, output: '', error: `unstubbed: ${name}` }; } };
}

test('WS2: ensure seeds idempotently; readK8DriverCooldowns returns seeded values', () => {
  const handle = openMemoryDb(':memory:');
  ensureK8DriveConfigs(handle.driveConfigs, BOOTSTRAP_ROOT_PURSUIT_ID);
  ensureK8DriveConfigs(handle.driveConfigs, BOOTSTRAP_ROOT_PURSUIT_ID); // idempotent
  const cds = readK8DriverCooldowns(handle.driveConfigs);
  assert.equal(cds.gap, DEFAULT_K8_COOLDOWN_MS);
  assert.equal(cds.curiosity, DEFAULT_K8_COOLDOWN_MS);
  assert.equal(cds.pursuit, DEFAULT_K8_COOLDOWN_MS);
  // Manually tuned value is read back
  const id = k8DriveConfigId('gap');
  handle.driveConfigs.updateParams(id, { cooldownMs: 20 * 60_000 });
  assert.equal(readK8DriverCooldowns(handle.driveConfigs).gap, 20 * 60_000);
  handle.close();
});

test('WS2: loop skips a driver inside its cooldown window and runs it after expiry', async () => {
  const handle = openMemoryDb(':memory:');
  handle.facts.storeFact({ namespace: 'project', key: 'k', value: { x: 1 }, confidence: 0.1 });
  const llmOut = JSON.stringify({
    summary: 'ok',
    facts: [{ namespace: 'project', key: 'k-verified', value: { t: 1 }, confidence: 0.8, sourceRefs: ['https://s'] }],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut),
    tools: tools({ webSearch: { ok: true, output: 'r' } }),
  });
  const COOLDOWN = 10 * 60_000;
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
    driverCooldowns: () => ({ gap: COOLDOWN }),
  });

  const t0 = Date.now();
  const first = await loop.tickOnce(t0);
  assert.equal(first.initiativesRun, 1, 'first tick runs');

  // Seed another gap so the driver WOULD propose if not throttled
  handle.facts.storeFact({ namespace: 'project', key: 'k2', value: { x: 2 }, confidence: 0.1 });
  const second = await loop.tickOnce(t0 + 5 * 60_000);
  assert.equal(second.proposalsCollected, 0, 'inside cooldown -> driver skipped');

  const third = await loop.tickOnce(t0 + COOLDOWN + 60_000);
  assert.ok(third.proposalsCollected >= 1, 'after cooldown -> driver proposes again');
  await loop.stop();
  handle.close();
});

test('WS2: settled initiatives feed the reflector, which tunes cooldownMs within the circle', async () => {
  const handle = openMemoryDb(':memory:');
  ensureK8DriveConfigs(handle.driveConfigs, BOOTSTRAP_ROOT_PURSUIT_ID);

  // Simulate 6 FAILED gap initiatives -> negative scores -> reflector doubles cooldownMs.
  const fakeInit = (i: number) => ({
    id: `init-${i}`,
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: `fact:f${i}`,
    rationale: 'r',
    utility: 0.5,
    status: 'failed' as const,
    budgetEstimate: 100,
    createdAt: Date.now(),
    plan: [],
  });
  for (let i = 0; i < 6; i++) {
    const outcome = k8DriveOutcomeInput(
      // Initiative shape: only fields used by the mapper matter
      fakeInit(i) as never,
      { status: 'failed', error: 'x', llmTokensSpent: 10, toolCallsSpent: 2 },
      BOOTSTRAP_ROOT_PURSUIT_ID,
    );
    assert.ok(outcome, 'gap driver maps to an outcome');
    handle.driveOutcomes.append(outcome!);
  }

  const reflector = new SessionDriveReflector(
    handle.driveOutcomes,
    handle.driveConfigs,
    handle.pursuits,
    { rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
  );
  const res = await reflector.reflect();
  assert.equal(res.outcomesScored, 6);
  assert.ok(res.driveParamsTuned >= 1, 'sustained failure should tune params');
  const tuned = readK8DriverCooldowns(handle.driveConfigs).gap!;
  assert.equal(tuned, DEFAULT_K8_COOLDOWN_MS * 2, 'ineffective driver -> cooldown doubled');
  handle.close();
});
