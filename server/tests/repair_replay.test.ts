/**
 * Replaying a stored repair against the failure it was learned from.
 *
 * The selection is where this can go wrong quietly, so it is pure and pinned here: a replay that
 * guesses (no rule), repeats (a rule with evidence), or reaches a tool nobody allow-listed is worse
 * than no replay at all — it spends an unattended tool run to learn nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REPLAY_TOOLS,
  repairReplayEnabled,
  replayEligibleTools,
  replayFixtureKey,
  REPAIR_REPLAY_ATTEMPTS_NAMESPACE,
  runRepairReplay,
  selectReplayCandidates,
  type LedgerFailure,
} from '../src/repair_replay.js';

const TOOLS = new Set(['alpha', 'beta']);

function failure(over: Partial<LedgerFailure> = {}): LedgerFailure {
  return {
    toolName: 'alpha',
    input: { script: 'bad' },
    errorText: 'alpha: unbalanced thing',
    recordedAt: 1_000,
    ...over,
  };
}

function baseSelect(over: Record<string, unknown> = {}) {
  return {
    failures: [failure()],
    signatureOf: (tool: string, err: string) => `${tool}:${err.split(':')[1]?.trim() ?? 'other'}`,
    rulesFor: () => ['Balance the thing.'],
    statsFor: () => ({ applied: 0 }),
    eligibleTools: TOOLS,
    limit: 3,
    ...over,
  } as Parameters<typeof selectReplayCandidates>[0];
}

// ── selection ────────────────────────────────────────────────────────────────────────────────────

test('a failure with a known, never-applied rule is worth one run', () => {
  const picked = selectReplayCandidates(baseSelect());
  assert.equal(picked.length, 1);
  assert.equal(picked[0].signature, 'alpha:unbalanced thing');
  assert.deepEqual(picked[0].input, { script: 'bad' });
});

test('no rule for the signature ⇒ nothing to replay — a replay must not guess', () => {
  assert.deepEqual(selectReplayCandidates(baseSelect({ rulesFor: () => [] })), []);
});

test('a rule that already has evidence is not re-run', () => {
  assert.deepEqual(selectReplayCandidates(baseSelect({ statsFor: () => ({ applied: 1 }) })), []);
});

test('a tool nobody allow-listed is never replayed unattended', () => {
  assert.deepEqual(
    selectReplayCandidates(baseSelect({ failures: [failure({ toolName: 'gamma' })] })),
    [],
  );
});

test('unusable ledger rows are skipped rather than replayed as-is', () => {
  const rows = [
    failure({ errorText: '   ' }),
    failure({ input: {} as Record<string, unknown> }),
    failure({ input: [] as unknown as Record<string, unknown> }),
  ];
  assert.deepEqual(selectReplayCandidates(baseSelect({ failures: rows })), []);
});

test('one candidate per signature, newest first — a second run of the same rule teaches nothing', () => {
  const rows = [
    failure({ recordedAt: 10, input: { script: 'older' } }),
    failure({ recordedAt: 99, input: { script: 'newest' } }),
    failure({ recordedAt: 50, input: { script: 'middle' } }),
  ];
  const picked = selectReplayCandidates(baseSelect({ failures: rows }));
  assert.equal(picked.length, 1, 'the same signature three times is still one candidate');
  assert.deepEqual(picked[0].input, { script: 'newest' });
});

test('the limit is honoured across distinct signatures', () => {
  const rows = [
    failure({ errorText: 'alpha: one', recordedAt: 3 }),
    failure({ errorText: 'alpha: two', recordedAt: 2 }),
    failure({ errorText: 'alpha: three', recordedAt: 1 }),
  ];
  assert.equal(selectReplayCandidates(baseSelect({ failures: rows, limit: 2 })).length, 2);
});

// ── configuration ────────────────────────────────────────────────────────────────────────────────

test('off by default, and the allow-list is configuration rather than code', () => {
  assert.equal(repairReplayEnabled({} as NodeJS.ProcessEnv), false);
  assert.equal(repairReplayEnabled({ PHILONT_REPAIR_REPLAY: '1' } as NodeJS.ProcessEnv), true);
  assert.deepEqual(
    [...replayEligibleTools({} as NodeJS.ProcessEnv)],
    DEFAULT_REPLAY_TOOLS.split(','),
  );
  assert.deepEqual(
    [...replayEligibleTools({ PHILONT_REPAIR_REPLAY_TOOLS: ' one , two ' } as NodeJS.ProcessEnv)],
    ['one', 'two'],
  );
  assert.equal(replayEligibleTools({ PHILONT_REPAIR_REPLAY_TOOLS: '' } as NodeJS.ProcessEnv).size, 0);
});

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

function fakeFacts() {
  const store = new Map<string, unknown>();
  return {
    getFact: (ns: string, k: string) => (store.has(`${ns}/${k}`) ? { value: store.get(`${ns}/${k}`) } : null),
    storeFact: (i: { namespace: string; key: string; value: unknown }) => {
      store.set(`${i.namespace}/${i.key}`, i.value);
      return i;
    },
  };
}

function baseRun(over: Record<string, unknown> = {}) {
  return {
    ...baseSelect(),
    limit: 1,
    facts: fakeFacts(),
    env: { PHILONT_REPAIR_REPLAY: '1' } as NodeJS.ProcessEnv,
    configured: true,
    ask: async () => '{"script":"good"}',
    runTool: async () => ({ success: true, output: 'ok' }),
    ...over,
  } as Parameters<typeof runRepairReplay>[0];
}

test('disabled by default: no candidate is even selected', async () => {
  let ran = 0;
  const out = await runRepairReplay(
    baseRun({ env: {} as NodeJS.ProcessEnv, runTool: async () => { ran++; return { success: true }; } }),
  );
  assert.deepEqual({ attempted: out.attempted, skipped: out.skipped, ran }, { attempted: 0, skipped: 'disabled', ran: 0 });
});

test('a rewrite the caller refuses to authorize is never executed', async () => {
  let ran = 0;
  const out = await runRepairReplay(
    baseRun({
      isSafeToRerun: async () => false,
      runTool: async () => { ran++; return { success: true }; },
    }),
  );
  assert.equal(ran, 0, 'the replay path must go through the same authorization as a live repair');
  assert.equal(out.outcomes[0]?.transition, 'not-attempted');
  assert.equal(out.outcomes[0]?.reason, 'unsafe-to-rerun');
});

test('a replay that fixes the failure is booked as verified', async () => {
  const outcomes: string[] = [];
  const out = await runRepairReplay(
    baseRun({ onOutcome: (o: { transition: string }) => outcomes.push(o.transition) }),
  );
  assert.equal(out.attempted, 1);
  assert.deepEqual(outcomes, ['verified']);
});

test('a replay that changes the failure is progress, not a plain failure', async () => {
  const out = await runRepairReplay(
    baseRun({ runTool: async () => ({ success: false, error: 'alpha: a different thing' }) }),
  );
  assert.equal(out.outcomes[0]?.transition, 'different_failure');
});

test('a replay that hits the same wall is a demonstrated no-op', async () => {
  const out = await runRepairReplay(
    baseRun({ runTool: async () => ({ success: false, error: 'alpha: unbalanced thing' }) }),
  );
  assert.equal(out.outcomes[0]?.transition, 'no_effect');
});

test('a thrown tool leaves the idle path standing', async () => {
  const out = await runRepairReplay(
    baseRun({ runTool: async () => { throw new Error('boom'); } }),
  );
  assert.equal(out.outcomes[0]?.transition, 'not-attempted');
  assert.match(String(out.outcomes[0]?.reason), /boom/);
});

test('a declined rewrite is persisted and cooled down instead of spending aux every idle tick', async () => {
  const facts = fakeFacts();
  const now = 1_000_000;
  const attemptFor = (candidate: Parameters<typeof replayFixtureKey>[0]) =>
    facts.getFact(REPAIR_REPLAY_ATTEMPTS_NAMESPACE, replayFixtureKey(candidate))?.value as never ?? null;
  const first = await runRepairReplay(baseRun({ facts, now, attemptFor, ask: async () => 'NONE' }));
  assert.equal(first.outcomes[0]?.reason, 'model-declined');
  const second = await runRepairReplay(baseRun({ facts, now: now + 1_000, attemptFor, ask: async () => '{"script":"good"}' }));
  assert.equal(second.skipped, 'no-candidates');
});
