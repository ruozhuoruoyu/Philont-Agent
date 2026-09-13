/**
 * A round the endpoint never answered did not happen.
 *
 * Prod 2026-09-12: the main endpoint returned 429 / the breaker opened / `fetch failed` hung; each
 * "round" came back with itersUsed=0, was logged as "the model wrote instead of working the tree",
 * counted as no-progress, and after three the session was declared stuck and the owner got a blocking
 * card — six times in one day, for an outage. Nothing about the model or the tree was learned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import type { MiniLoopLLMClient } from '@agent/tools';

// Value-guided scoring makes its own LLM call before the round; keep the test about the round.
process.env.PHILONT_DEEP_EXPLORE_VALUE_GUIDED = '0';
const { createDeepExploreTool, roundNotRun } = await import('../src/deep_explore.js');

function harness(llm: MiniLoopLLMClient) {
  const mem = openMemoryDb(':memory:');
  const de = createDeepExploreTool({
    reasoning: mem.reasoning, miniLoopLLM: llm,
    subTurnToolRunner: async () => ({ ok: true, output: '' }), readOnlyToolDefs: [],
  });
  return { mem, de };
}

test('roundNotRun: zero iterations with an endpoint error is not a round', () => {
  assert.deepEqual(roundNotRun({ itersUsed: 0, error: 'llm_error: OpenAI-compatible API 429: too many requests' }), { reason: 'OpenAI-compatible API 429: too many requests' });
  assert.ok(roundNotRun({ itersUsed: 0, error: 'aborted' }), 'a first call that hung until the round deadline is the endpoint too');
  assert.equal(roundNotRun({ itersUsed: 2, error: 'llm_error: boom' }), null, 'the model answered twice — that round happened');
  assert.equal(roundNotRun({ itersUsed: 0 }), null, 'no error, no iterations is the loop\'s own business');
});

test('an endpoint that never answers charges nothing to the model', async () => {
  const { mem, de } = harness({ async send() { throw new Error('OpenAI-compatible API 429: {"error":{"code":"rate_limit_exceeded"}}'); } });
  await de.tool.execute({ action: 'start', goal: 'Prove every even n > 2 has property P', mode: 'formal' });
  const before = mem.reasoning.getMostRecentActiveSession()!;
  const out = await de.advanceSession(before);
  assert.equal(out.success, false);
  assert.equal(out.data?.notRun, true, 'the caller must be told the round did not run');
  assert.match(out.error ?? '', /round_not_run/);
  assert.doesNotMatch(out.output + (out.error ?? ''), /committed NOTHING|wrote instead/, 'not the model\'s doing, not worded as such');
  const after = mem.reasoning.getSession(before.id)!;
  assert.equal(after.noProgressRounds, before.noProgressRounds, 'an outage is not a stuck round');
  assert.equal(after.roundsRun, before.roundsRun, 'an outage is not a round');
  assert.equal(after.budgetSpent, before.budgetSpent);
  mem.close();
});

test('a model that answered and did nothing is still a real (barren) round', async () => {
  const { mem, de } = harness({ async send() { return { type: 'text' as const, content: 'I will think about it.' }; } });
  await de.tool.execute({ action: 'start', goal: 'Prove every even n > 2 has property P', mode: 'formal' });
  const before = mem.reasoning.getMostRecentActiveSession()!;
  const out = await de.advanceSession(before);
  assert.notEqual(out.data?.notRun, true);
  const after = mem.reasoning.getSession(before.id)!;
  assert.equal(after.noProgressRounds, before.noProgressRounds + 1, 'this one IS charged to the model');
  assert.equal(after.roundsRun, before.roundsRun + 1);
  mem.close();
});
