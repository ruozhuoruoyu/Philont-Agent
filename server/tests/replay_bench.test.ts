/**
 * The sealed replay bench: pinning, run planning, and the keep-better decisions.
 *
 * Everything that could silently do the wrong thing is pure and pinned here: which failures earn a
 * seat, which fixtures a tick spends a run on, and what a run's outcome does to the rule ledger.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAfterRun,
  fixtureId,
  loadFixtures,
  pinFixture,
  REPLAY_BENCH_NAMESPACE,
  replayBenchEnabled,
  replayBenchRunsPerTick,
  replayBenchSize,
  rulesHash,
  runReplayBench,
  selectFixturesToPin,
  selectFixturesToRun,
  summarizeBench,
  type BenchFixture,
  type BenchStore,
  type SessionLedgerFailure,
} from '../src/replay_bench.js';
import {
  addCandidateLine,
  learnedCheatsheet,
  MECHANICAL_FIX_NAMESPACE,
  readCandidateLines,
} from '../src/mechanical_fix_learning.js';

const TOOLS = new Set(['alpha']);
const sigOf = (tool: string, err: string) => `${tool}:${err.split(':')[1]?.trim() ?? 'other'}`;

function fakeStore(): BenchStore & { _dump: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    getFact: (ns, key) => (m.has(`${ns}/${key}`) ? { value: m.get(`${ns}/${key}`) } : null),
    storeFact: (i) => { m.set(`${i.namespace}/${i.key}`, i.value); return i; },
    listFacts: (ns) => [...m.entries()].filter(([k]) => k.startsWith(`${ns}/`)).map(([k, value]) => ({ key: k.slice(ns.length + 1), value })),
    _dump: m,
  };
}

function failure(over: Partial<SessionLedgerFailure> = {}): SessionLedgerFailure {
  return { toolName: 'alpha', input: { script: 'bad' }, errorText: 'alpha: unbalanced thing', recordedAt: 1_000, sessionId: 's1', ...over };
}

function fixture(over: Partial<BenchFixture> = {}): BenchFixture {
  const input = over.input ?? { script: 'bad' };
  return {
    id: fixtureId('alpha', input), signature: 'alpha:unbalanced thing', toolName: 'alpha', input,
    errorText: 'alpha: unbalanced thing', pinnedAt: 0, sourceRecordedAt: 0, sessions: 2, status: 'active', runs: [],
    ...over,
  };
}

// ── env ───────────────────────────────────────────────────────────────────────

test('flags: on by default, size floor, per-tick parse', () => {
  assert.equal(replayBenchEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(replayBenchEnabled({ PHILONT_REPLAY_BENCH: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(replayBenchSize({} as NodeJS.ProcessEnv), 50);
  assert.equal(replayBenchSize({ PHILONT_REPLAY_BENCH_SIZE: '2' } as NodeJS.ProcessEnv), 5);
  assert.equal(replayBenchRunsPerTick({} as NodeJS.ProcessEnv), 2);
  assert.equal(replayBenchRunsPerTick({ PHILONT_REPLAY_BENCH_PER_TICK: '0' } as NodeJS.ProcessEnv), 0);
});

// ── pinning ───────────────────────────────────────────────────────────────────

test('a signature seen in two sessions earns a seat; one session without a rule does not', () => {
  const two = selectFixturesToPin({
    failures: [failure({ sessionId: 's1' }), failure({ sessionId: 's2', recordedAt: 2_000 })],
    existing: [], signatureOf: sigOf, rulesFor: () => [], eligibleTools: TOOLS, capacity: 50,
  });
  assert.equal(two.length, 1);
  assert.equal(two[0].sessions, 2);
  assert.equal(two[0].failure.recordedAt, 2_000, 'newest failure of the signature is the fixture');
  const one = selectFixturesToPin({
    failures: [failure()], existing: [], signatureOf: sigOf, rulesFor: () => [], eligibleTools: TOOLS, capacity: 50,
  });
  assert.deepEqual(one, []);
});

test('a signature that already has a rule is pinned even from one session — it is the rule\'s own fixture', () => {
  const picked = selectFixturesToPin({
    failures: [failure()], existing: [], signatureOf: sigOf, rulesFor: () => ['Balance it.'], eligibleTools: TOOLS, capacity: 50,
  });
  assert.equal(picked.length, 1);
});

test('one fixture per signature; a pinned signature is not pinned again; a full bench pins nothing', () => {
  const existing = [fixture()];
  const dup = selectFixturesToPin({
    failures: [failure({ sessionId: 's9', input: { script: 'other bad' } }), failure({ sessionId: 's8', input: { script: 'other bad' } })],
    existing, signatureOf: sigOf, rulesFor: () => [], eligibleTools: TOOLS, capacity: 50,
  });
  assert.deepEqual(dup, [], 'signature already on the bench');
  const full = selectFixturesToPin({
    failures: [failure({ errorText: 'alpha: other thing', sessionId: 'a' }), failure({ errorText: 'alpha: other thing', sessionId: 'b' })],
    existing, signatureOf: sigOf, rulesFor: () => [], eligibleTools: TOOLS, capacity: 1,
  });
  assert.deepEqual(full, [], 'capacity 1 already used');
});

test('tools off the allow-list and unusable rows never become fixtures', () => {
  const picked = selectFixturesToPin({
    failures: [
      failure({ toolName: 'gamma', sessionId: 'a' }), failure({ toolName: 'gamma', sessionId: 'b' }),
      failure({ errorText: ' ', sessionId: 'c' }), failure({ errorText: ' ', sessionId: 'd' }),
      failure({ input: {}, sessionId: 'e' }), failure({ input: {}, sessionId: 'f' }),
    ],
    existing: [], signatureOf: sigOf, rulesFor: () => [], eligibleTools: TOOLS, capacity: 50,
  });
  assert.deepEqual(picked, []);
});

test('pinFixture stores a loadable fixture with the error text capped', () => {
  const store = fakeStore();
  const f = pinFixture(store, { failure: failure({ errorText: 'alpha: ' + 'x'.repeat(5000) }), signature: 'alpha:x', sessions: 2 }, 123);
  assert.equal(f.errorText.length, 2000);
  const loaded = loadFixtures(store);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, f.id);
  assert.equal(loaded[0].pinnedAt, 123);
  assert.ok(store._dump.has(`${REPLAY_BENCH_NAMESPACE}/${f.id}`));
});

// ── run planning ──────────────────────────────────────────────────────────────

test('never-run fixtures go first; no rules at all ⇒ not planned', () => {
  const plans = selectFixturesToRun({
    fixtures: [fixture(), fixture({ input: { script: 'no-rule' }, signature: 'alpha:nothing' })],
    rulesFor: (sig) => (sig === 'alpha:unbalanced thing' ? ['Balance it.'] : []),
    candidatesFor: () => [], now: 10_000, limit: 5,
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].why, 'never-run');
  assert.equal(plans[0].withCandidates, false);
});

test('a changed rule set or a stale run is a reason to run again; an unchanged fresh run is not', () => {
  const accepted = ['Balance it.'];
  const fresh = fixture({ runs: [{ at: 9_000, transition: 'verified', rulesHash: rulesHash(accepted), withCandidates: false }] });
  assert.deepEqual(selectFixturesToRun({ fixtures: [fresh], rulesFor: () => accepted, candidatesFor: () => [], now: 10_000, limit: 5 }), []);
  const changed = selectFixturesToRun({ fixtures: [fresh], rulesFor: () => [...accepted, 'New line.'], candidatesFor: () => [], now: 10_000, limit: 5 });
  assert.equal(changed[0]?.why, 'rules-changed');
  const stale = selectFixturesToRun({ fixtures: [fresh], rulesFor: () => accepted, candidatesFor: () => [], now: 9_000 + 8 * 24 * 3600_000, limit: 5 });
  assert.equal(stale[0]?.why, 'stale');
});

test('candidates need a baseline run with the accepted rules alone before they are tried', () => {
  const accepted = ['Balance it.'];
  const f = fixture();
  const first = selectFixturesToRun({ fixtures: [f], rulesFor: () => accepted, candidatesFor: () => ['Also close braces.'], now: 1, limit: 5 });
  assert.equal(first[0].why, 'baseline-for-candidates');
  assert.deepEqual(first[0].rules, accepted);
  const withBaseline = fixture({ runs: [{ at: 0, transition: 'no_effect', rulesHash: rulesHash(accepted), withCandidates: false }] });
  const second = selectFixturesToRun({ fixtures: [withBaseline], rulesFor: () => accepted, candidatesFor: () => ['Also close braces.'], now: 1, limit: 5 });
  assert.equal(second[0].why, 'candidates');
  assert.deepEqual(second[0].rules, ['Balance it.', 'Also close braces.']);
  // No accepted rules at all: the candidate run needs no baseline.
  const bare = selectFixturesToRun({ fixtures: [f], rulesFor: () => [], candidatesFor: () => ['Only line.'], now: 1, limit: 5 });
  assert.equal(bare[0].why, 'candidates');
});

// ── decisions ─────────────────────────────────────────────────────────────────

test('decideAfterRun: candidate credited only for a change it caused', () => {
  const accepted = ['Balance it.'];
  const h = rulesHash(accepted);
  const redBaseline = fixture({ runs: [{ at: 0, transition: 'no_effect', rulesHash: h, withCandidates: false }] });
  assert.equal(decideAfterRun(redBaseline, { withCandidates: true, rules: [] }, 'verified', h, 0), 'promoted');
  const greenBaseline = fixture({ runs: [{ at: 0, transition: 'verified', rulesHash: h, withCandidates: false }] });
  assert.equal(decideAfterRun(greenBaseline, { withCandidates: true, rules: [] }, 'verified', h, 0), 'dropped-redundant');
  assert.equal(decideAfterRun(redBaseline, { withCandidates: true, rules: [] }, 'no_effect', h, 0), 'candidate-failed');
  assert.equal(decideAfterRun(redBaseline, { withCandidates: true, rules: [] }, 'no_effect', h, 1), 'dropped-failed');
  assert.equal(decideAfterRun(redBaseline, { withCandidates: true, rules: [] }, 'inconclusive', h, 1), 'none');
});

test('decideAfterRun: green then red under a changed accepted set demotes; under the same set only flags', () => {
  const oldHash = rulesHash(['Balance it.']);
  const green = fixture({ runs: [{ at: 0, transition: 'verified', rulesHash: oldHash, withCandidates: false }] });
  assert.equal(decideAfterRun(green, { withCandidates: false, rules: [] }, 'no_effect', rulesHash(['Balance it.', 'Bad line.']), 0), 'regression-demoted');
  assert.equal(decideAfterRun(green, { withCandidates: false, rules: [] }, 'no_effect', oldHash, 0), 'regression');
  const neverGreen = fixture({ runs: [{ at: 0, transition: 'no_effect', rulesHash: oldHash, withCandidates: false }] });
  assert.equal(decideAfterRun(neverGreen, { withCandidates: false, rules: [] }, 'no_effect', oldHash, 0), 'none');
});

// ── end to end on a fake executor ─────────────────────────────────────────────

const askRepair = async (req: { user: string }) => {
  // The fake rewriter: the input object with `script` fixed, as the repair prompt asks for a full object.
  const m = req.user.match(/"script":\s*"([^"]*)"/);
  return JSON.stringify({ script: `${m?.[1] ?? 'bad'} fixed` });
};

test('a candidate that turns a red fixture green is promoted into the accepted list', async () => {
  const store = fakeStore();
  const f = pinFixture(store, { failure: failure(), signature: 'alpha:unbalanced thing', sessions: 2 }, 1);
  store.storeFact({ namespace: MECHANICAL_FIX_NAMESPACE, key: f.signature, value: ['Balance it.'] });
  addCandidateLine(f.signature, 'Also close braces.', store);
  // Run 1: baseline with accepted rules only — the tool still fails.
  let toolSucceeds = false;
  const run = () => runReplayBench({
    store, signatureOf: sigOf, rulesFor: (sig) => learnedCheatsheet(sig, store),
    runTool: async () => (toolSucceeds ? { success: true, output: 'ok' } : { success: false, error: 'alpha: unbalanced thing' }),
    ask: askRepair, configured: true, limit: 5, now: 2, env: {} as NodeJS.ProcessEnv,
  });
  const r1 = await run();
  assert.equal(r1.outcomes[0].why, 'baseline-for-candidates');
  assert.equal(r1.outcomes[0].transition, 'no_effect');
  assert.equal(r1.outcomes[0].decision, 'none');
  // Run 2: with the candidate — the tool now succeeds.
  toolSucceeds = true;
  const r2 = await run();
  assert.equal(r2.outcomes[0].why, 'candidates');
  assert.equal(r2.outcomes[0].decision, 'promoted');
  assert.deepEqual(learnedCheatsheet(f.signature, store), ['Balance it.', 'Also close braces.']);
  assert.deepEqual(readCandidateLines(f.signature, store).lines, []);
  const s = summarizeBench(store);
  assert.equal(s.active, 1);
  assert.equal(s.pendingCandidates, 0);
});

test('a candidate that fails the bench twice is dropped, never shown to the agent', async () => {
  const store = fakeStore();
  const f = pinFixture(store, { failure: failure(), signature: 'alpha:unbalanced thing', sessions: 2 }, 1);
  addCandidateLine(f.signature, 'Useless line.', store);
  const run = (now: number) => runReplayBench({
    store, signatureOf: sigOf, rulesFor: () => [],
    runTool: async () => ({ success: false, error: 'alpha: unbalanced thing' }),
    ask: askRepair, configured: true, limit: 5, now, env: {} as NodeJS.ProcessEnv,
  });
  const r1 = await run(2);
  assert.equal(r1.outcomes[0].decision, 'candidate-failed');
  assert.equal(readCandidateLines(f.signature, store).failures, 1);
  // Same rule set already tried ⇒ not re-planned until something changes; add a second candidate to change it.
  addCandidateLine(f.signature, 'Another useless line.', store);
  const r2 = await run(3);
  assert.equal(r2.outcomes[0].decision, 'dropped-failed');
  assert.deepEqual(readCandidateLines(f.signature, store).lines, []);
  assert.deepEqual(learnedCheatsheet(f.signature, store), []);
});

test('an accepted-rule change that turns a green fixture red is reverted to candidate', async () => {
  const store = fakeStore();
  const f = pinFixture(store, { failure: failure(), signature: 'alpha:unbalanced thing', sessions: 2 }, 1);
  store.storeFact({ namespace: MECHANICAL_FIX_NAMESPACE, key: f.signature, value: ['Balance it.'] });
  let ok = true;
  const run = (now: number) => runReplayBench({
    store, signatureOf: sigOf, rulesFor: (sig) => learnedCheatsheet(sig, store),
    runTool: async () => (ok ? { success: true, output: 'ok' } : { success: false, error: 'alpha: unbalanced thing' }),
    ask: askRepair, configured: true, limit: 5, now, env: {} as NodeJS.ProcessEnv,
  });
  const r1 = await run(2);
  assert.equal(r1.outcomes[0].transition, 'verified');
  // Someone (the live path) appends a line straight into the accepted list; the fixture goes red.
  store.storeFact({ namespace: MECHANICAL_FIX_NAMESPACE, key: f.signature, value: ['Balance it.', 'Harmful line.'] });
  ok = false;
  const r2 = await run(3);
  assert.equal(r2.outcomes[0].why, 'rules-changed');
  assert.equal(r2.outcomes[0].decision, 'regression-demoted');
  assert.deepEqual(r2.outcomes[0].lines, ['Harmful line.']);
  assert.deepEqual(learnedCheatsheet(f.signature, store), ['Balance it.']);
  assert.deepEqual(readCandidateLines(f.signature, store).lines, ['Harmful line.']);
  assert.equal(summarizeBench(store).red, 1);
});

test('a fixture the checker refuses to re-run is retired, and the bench never throws', async () => {
  const store = fakeStore();
  const f = pinFixture(store, { failure: failure(), signature: 'alpha:unbalanced thing', sessions: 2 }, 1);
  store.storeFact({ namespace: MECHANICAL_FIX_NAMESPACE, key: f.signature, value: ['Balance it.'] });
  const r = await runReplayBench({
    store, signatureOf: sigOf, rulesFor: (sig) => learnedCheatsheet(sig, store),
    runTool: async () => { throw new Error('must not run'); },
    isSafeToRerun: async () => false,
    ask: askRepair, configured: true, limit: 5, now: 2, env: {} as NodeJS.ProcessEnv,
  });
  assert.equal(r.attempted, 0);
  assert.equal(r.outcomes[0].transition, 'not-attempted');
  assert.equal(r.outcomes[0].reason, 'unsafe-to-rerun');
  const loaded = loadFixtures(store);
  assert.equal(loaded[0].status, 'retired');
  assert.equal(summarizeBench(store).retired, 1);
});
