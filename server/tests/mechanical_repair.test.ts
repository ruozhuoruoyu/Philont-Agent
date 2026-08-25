/**
 * Mechanism-initiated repair.
 *
 * The point of the module is that a learned rule stops being advice and becomes an action, WITHOUT the
 * framework knowing what any tool's arguments mean. So the tests pin two things: the shape guards that
 * make running a rewritten argument list safe, and the fact that two unrelated tools with unrelated
 * argument shapes travel the identical path — if a tool name ever has to appear in the module, one of
 * these goes red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptMechanicalRepair,
  buildRepairPrompt,
  classifyRecurrence,
  recurrenceMetricKey,
  mechanicalRepairEnabled,
  parseRepairedInput,
  repairOutputTokenBudget,
  readRepairStats,
  recordRepairOutcome,
  renderRepairNotice,
  MAX_REPAIRED_INPUT_BYTES,
  MECHANICAL_REPAIR_STATS_NAMESPACE,
} from '../src/mechanical_repair.js';

const ON = { PHILONT_MECHANICAL_REPAIR: '1' } as NodeJS.ProcessEnv;

function fakeFacts() {
  const store = new Map<string, unknown>();
  return {
    store,
    getFact: (namespace: string, key: string) =>
      store.has(`${namespace}/${key}`) ? { value: store.get(`${namespace}/${key}`) } : null,
    storeFact: (input: { namespace: string; key: string; value: unknown }) => {
      store.set(`${input.namespace}/${input.key}`, input.value);
      return input;
    },
  };
}

// ── the guards that make re-running a rewritten argument list safe ───────────────────────────────

test('a repair may not acquire an argument the original call never carried', () => {
  const original = { script: 'print(1', timeoutMs: 5000 };
  assert.equal(parseRepairedInput('{"script":"print(1)","timeoutMs":5000}', original)?.script, 'print(1)');
  assert.equal(
    parseRepairedInput('{"script":"print(1)","timeoutMs":5000,"cwd":"/etc"}', original),
    null,
    'a new key is a new decision, not a repair',
  );
});

test('a repair may not change an argument type', () => {
  const original = { script: 'x', timeoutMs: 5000, tags: ['a'] };
  assert.equal(parseRepairedInput('{"script":"y","timeoutMs":"9999"}', original), null, 'number → string');
  assert.equal(parseRepairedInput('{"script":"y","tags":"a"}', original), null, 'array → string');
  assert.ok(parseRepairedInput('{"script":"y","tags":["a","b"]}', original));
});

test('"try the same thing again" is not a repair, whatever the key order', () => {
  const original = { a: 1, script: 'same' };
  assert.equal(parseRepairedInput('{"script":"same","a":1}', original), null);
});

test('unusable model output is refused rather than guessed at', () => {
  const original = { script: 'x' };
  for (const raw of [null, undefined, '', 'NONE', 'NONE — the rules do not explain this', 'not json', '[1,2]', '"str"']) {
    assert.equal(parseRepairedInput(raw, original), null, JSON.stringify(raw));
  }
});

test('a fenced object is still accepted; an oversized one is not', () => {
  const original = { script: 'x' };
  assert.equal(parseRepairedInput('```json\n{"script":"y"}\n```', original)?.script, 'y');
  const huge = JSON.stringify({ script: 'y'.repeat(MAX_REPAIRED_INPUT_BYTES) });
  assert.equal(parseRepairedInput(huge, original), null);
});

// ── the counters, which are the only evidence a rule changes behaviour ───────────────────────────

test('counters accumulate per signature and survive a malformed stored value', () => {
  const facts = fakeFacts();
  assert.deepEqual(readRepairStats('t:sig', facts), { applied: 0, verified: 0, failed: 0 });

  recordRepairOutcome('t:sig', true, facts, '2026-08-23T00:00:00.000Z');
  recordRepairOutcome('t:sig', false, facts, '2026-08-23T00:01:00.000Z');
  const s = readRepairStats('t:sig', facts);
  assert.equal(s.applied, 2);
  assert.equal(s.verified, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.lastAppliedAt, '2026-08-23T00:01:00.000Z');
  assert.equal(s.lastVerifiedAt, '2026-08-23T00:00:00.000Z', 'a later failure does not move the last VERIFIED time');

  facts.store.set(`${MECHANICAL_REPAIR_STATS_NAMESPACE}/t:sig`, 'corrupt');
  assert.deepEqual(readRepairStats('t:sig', facts).applied, 0, 'a corrupt counter must not stop a repair');
});

test('recurrence is only counted against a rule that existed, and the two culprits stay apart', () => {
  assert.equal(classifyRecurrence(false, false), null, 'no rule ⇒ nothing recurred against anything');
  assert.equal(classifyRecurrence(false, true), null);
  assert.equal(classifyRecurrence(true, false), 'cross_turn', 'the rule did not survive into this turn');
  assert.equal(classifyRecurrence(true, true), 'intra_turn', 'the error text was in front of the model already');
  assert.equal(recurrenceMetricKey('cross_turn'), 'learning.recurrence_after_rule.cross_turn');
  assert.equal(recurrenceMetricKey('intra_turn'), 'learning.recurrence_after_rule.intra_turn');
});

test('the stats reader and the counter producer use the same keys', async () => {
  const { readFileSync } = await import('node:fs');
  const stats = readFileSync(new URL('../src/learning_stats.ts', import.meta.url), 'utf8');
  for (const bucket of ['cross_turn', 'intra_turn'] as const) {
    assert.ok(stats.includes(recurrenceMetricKey(bucket)), `learning-stats must read ${bucket}`);
  }
});

// ── the loop itself ──────────────────────────────────────────────────────────────────────────────

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    signature: 'toolA:some-error',
    toolName: 'toolA',
    toolInput: { script: 'bad' },
    errorText: 'some-error: unbalanced thing',
    rules: ['Balance the thing.'],
    facts: fakeFacts(),
    configured: true,
    env: ON,
    ask: async () => '{"script":"good"}',
    run: async () => ({ success: true, output: 'ok' }),
    ...overrides,
  } as Parameters<typeof attemptMechanicalRepair>[0];
}

test('kill switch off: nothing is asked and nothing is re-run', async () => {
  assert.equal(mechanicalRepairEnabled({ PHILONT_MECHANICAL_REPAIR: '0' } as NodeJS.ProcessEnv), false);
  let asked = 0;
  let ran = 0;
  const out = await attemptMechanicalRepair(
    baseOpts({
    env: { PHILONT_MECHANICAL_REPAIR: '0' } as NodeJS.ProcessEnv,
      ask: async () => { asked++; return '{"script":"good"}'; },
      run: async () => { ran++; return { success: true }; },
    }),
  );
  assert.deepEqual({ attempted: out.attempted, reason: out.reason, asked, ran }, { attempted: false, reason: 'disabled', asked: 0, ran: 0 });
});

test('mechanical repair is enabled by default for the production experiment', () => {
  assert.equal(mechanicalRepairEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(mechanicalRepairEnabled({ PHILONT_MECHANICAL_REPAIR: 'off' } as NodeJS.ProcessEnv), false);
});

test('repair output budget scales with the argument object it must reproduce', () => {
  assert.equal(repairOutputTokenBudget({ path: 'a' }), 2048);
  const medium = repairOutputTokenBudget({ content: 'x'.repeat(12_000) });
  assert.ok(medium > 4000 && medium < 5000, `unexpected medium budget ${medium}`);
  assert.equal(
    repairOutputTokenBudget({ content: 'x'.repeat(100_000) }),
    16_384,
    'large malformed inputs remain bounded',
  );
});

test('the aux repair call receives the size-derived output budget', async () => {
  let budget = 0;
  let requireComplete = false;
  const input = { content: 'x'.repeat(12_000) };
  await attemptMechanicalRepair(baseOpts({
    toolInput: input,
    ask: async (req: { maxTokens: number; requireComplete: boolean }) => {
      budget = req.maxTokens;
      requireComplete = req.requireComplete;
      return JSON.stringify({ content: 'y'.repeat(12_000) });
    },
  }));
  assert.equal(budget, repairOutputTokenBudget(input));
  assert.equal(requireComplete, true, 'a JSON argument rewrite must never accept partial output');
});

test('with no rule for the signature it does not guess — no aux call, no re-run', async () => {
  let asked = 0;
  let ran = 0;
  const out = await attemptMechanicalRepair(
    baseOpts({
      rules: [],
      ask: async () => { asked++; return '{"script":"good"}'; },
      run: async () => { ran++; return { success: true }; },
    }),
  );
  assert.deepEqual({ reason: out.reason, asked, ran }, { reason: 'no-rule', asked: 0, ran: 0 });
});

test('a rewrite the caller refuses to authorize is never executed, and the rule is not charged', async () => {
  const facts = fakeFacts();
  let ran = 0;
  // Async on purpose: the real caller re-runs the whole policy checker on the rewritten arguments.
  const out = await attemptMechanicalRepair(
    baseOpts({
      facts,
      isSafeToRerun: async () => false,
      run: async () => { ran++; return { success: true }; },
    }),
  );
  assert.equal(out.reason, 'unsafe-to-rerun');
  assert.equal(ran, 0, 'the authorization verdict has to land BEFORE the tool runs, not after');
  assert.equal(readRepairStats('toolA:some-error', facts).applied, 0, 'refused ≠ a repair that failed');
});

test('a successful repair runs the rewritten arguments and books a verified application', async () => {
  const facts = fakeFacts();
  const seen: Array<Record<string, unknown>> = [];
  const out = await attemptMechanicalRepair(
    baseOpts({
      facts,
      run: async (input: Record<string, unknown>) => { seen.push(input); return { success: true, output: '42' }; },
    }),
  );
  assert.equal(out.attempted, true);
  assert.equal(out.verified, true);
  assert.deepEqual(seen, [{ script: 'good' }], 'the REWRITTEN arguments are what runs');
  assert.deepEqual(
    { applied: readRepairStats('toolA:some-error', facts).applied, verified: readRepairStats('toolA:some-error', facts).verified },
    { applied: 1, verified: 1 },
  );
});

test('a repair that still fails is booked against the rule, not silently dropped', async () => {
  const facts = fakeFacts();
  const out = await attemptMechanicalRepair(
    baseOpts({ facts, run: async () => ({ success: false, error: 'same-error again' }) }),
  );
  assert.equal(out.attempted, true);
  assert.equal(out.verified, false);
  const s = readRepairStats('toolA:some-error', facts);
  assert.deepEqual({ applied: s.applied, verified: s.verified, failed: s.failed }, { applied: 1, verified: 0, failed: 1 });
});

test('an aux call that throws leaves the original failure standing', async () => {
  let ran = 0;
  const out = await attemptMechanicalRepair(
    baseOpts({
      ask: async () => { throw new Error('aux down'); },
      run: async () => { ran++; return { success: true }; },
    }),
  );
  assert.deepEqual({ attempted: out.attempted, reason: out.reason, ran }, { attempted: false, reason: 'ask-failed', ran: 0 });
});

// ── generality: two unrelated tools travel the identical path ────────────────────────────────────

test('two tools with unrelated argument shapes are handled identically — no tool knowledge anywhere', async () => {
  const cases = [
    { toolName: 'alpha', signature: 'alpha:x', toolInput: { script: '(((' }, fixed: { script: '()' } },
    { toolName: 'beta', signature: 'beta:y', toolInput: { path: '/a', oldText: 'p', newText: 'q' }, fixed: { path: '/a', oldText: 'p2', newText: 'q' } },
  ];
  for (const c of cases) {
    const facts = fakeFacts();
    const seen: Array<Record<string, unknown>> = [];
    const out = await attemptMechanicalRepair(
      baseOpts({
        signature: c.signature,
        toolName: c.toolName,
        toolInput: c.toolInput,
        facts,
        ask: async () => JSON.stringify(c.fixed),
        run: async (input: Record<string, unknown>) => { seen.push(input); return { success: true }; },
      }),
    );
    assert.equal(out.attempted, true, c.toolName);
    assert.deepEqual(seen, [c.fixed], c.toolName);
    assert.equal(readRepairStats(c.signature, facts).verified, 1, c.toolName);
  }
});

test('the prompt carries the known rules and the failed arguments, and names no tool it was not given', () => {
  const { system, user } = buildRepairPrompt({
    toolName: 'alpha',
    toolInput: { script: '(((' },
    errorText: 'unbalanced',
    rules: ['Balance the parens.'],
  });
  assert.match(user, /Balance the parens\./);
  assert.match(user, /\(\(\(/);
  assert.match(user, /^Tool: alpha$/m);
  assert.match(system, /never add a key/i);
  assert.match(system, /NONE/);
});

test('the model is told its call was repaired — a silent correction teaches the wrong lesson', () => {
  const ok = renderRepairNotice('alpha', ['Balance the parens.'], true);
  assert.match(ok, /corrected automatically and re-run/);
  assert.match(ok, /Balance the parens\./);
  const bad = renderRepairNotice('alpha', ['Balance the parens.'], false);
  assert.match(bad, /still failed/);
  assert.doesNotMatch(bad, /corrected automatically and re-run/);
});
