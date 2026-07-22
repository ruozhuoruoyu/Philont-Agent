/**
 * Refutation pairing at session start.
 *
 * Guarantee under test: a session attacking a universally quantified goal never starts on a tree where
 * nothing is decidable. Proving needs an argument; disproving needs one witness — so the refutation side
 * is always checkable, and it is seeded before the first round rather than hoped for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import type { MiniLoopLLMClient } from '@agent/tools';
import { createDeepExploreTool } from '../src/deep_explore.js';

/** A stub that ends the round immediately — this suite is about what exists BEFORE the first round. */
const idleLLM: MiniLoopLLMClient = { async send() { return { type: 'text' as const, content: 'no action' }; } };

function makeTool(mem: ReturnType<typeof openMemoryDb>) {
  return createDeepExploreTool({
    reasoning: mem.reasoning,
    miniLoopLLM: idleLLM,
    subTurnToolRunner: async () => ({ ok: true, output: '' }),
    readOnlyToolDefs: [],
  }).tool;
}

test('a universally quantified goal is paired with a counterexample node', async () => {
  const mem = openMemoryDb(':memory:');
  const tool = makeTool(mem);

  await tool.execute({ action: 'start', goal: 'Prove the property holds for every even n > 2', mode: 'formal' });

  const session = mem.reasoning.getMostRecentActiveSession()!;
  const nodes = mem.reasoning.getNodes(session.id);
  const paired = nodes.filter((n) => n.kind === 'counterexample');
  assert.equal(paired.length, 1, 'exactly one refutation node');
  assert.equal(paired[0].status, 'open');
  assert.match(paired[0].claim, /No counterexample/);
  // It hangs off the root, so it is on the frontier from round one.
  assert.equal(paired[0].parentId, nodes.find((n) => n.parentId === null)!.id);
  mem.close();
});

test('a conjecture-shaped goal is paired too — no problem name is needed', async () => {
  const mem = openMemoryDb(':memory:');
  const tool = makeTool(mem);

  await tool.execute({ action: 'start', goal: '攻克某某猜想的三维情形', mode: 'formal' });

  const session = mem.reasoning.getMostRecentActiveSession()!;
  assert.equal(mem.reasoning.getNodes(session.id).filter((n) => n.kind === 'counterexample').length, 1);
  mem.close();
});

test('a decision goal is NOT paired — there is nothing a witness could refute', async () => {
  const mem = openMemoryDb(':memory:');
  const tool = makeTool(mem);

  await tool.execute({ action: 'start', goal: 'Which messaging channel should we prioritise next?', mode: 'deliberate' });

  const session = mem.reasoning.getMostRecentActiveSession()!;
  assert.equal(mem.reasoning.getNodes(session.id).filter((n) => n.kind === 'counterexample').length, 0);
  mem.close();
});

test('kill switch: PHILONT_DEEP_EXPLORE_REFUTATION_NODE=0 seeds nothing', async () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_REFUTATION_NODE;
  process.env.PHILONT_DEEP_EXPLORE_REFUTATION_NODE = '0';
  try {
    const mem = openMemoryDb(':memory:');
    const tool = makeTool(mem);
    await tool.execute({ action: 'start', goal: 'Prove the property holds for every even n > 2', mode: 'formal' });
    const session = mem.reasoning.getMostRecentActiveSession()!;
    assert.equal(mem.reasoning.getNodes(session.id).filter((n) => n.kind === 'counterexample').length, 0);
    mem.close();
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_REFUTATION_NODE;
    else process.env.PHILONT_DEEP_EXPLORE_REFUTATION_NODE = prev;
  }
});

test('the pairing survives a store failure — it can never break session start', async () => {
  const mem = openMemoryDb(':memory:');
  const original = mem.reasoning.addNodes.bind(mem.reasoning);
  let threw = false;
  (mem.reasoning as unknown as { addNodes: unknown }).addNodes = (...args: Parameters<typeof original>) => {
    threw = true;
    throw new Error('store unavailable');
  };
  const tool = makeTool(mem);

  const r = await tool.execute({ action: 'start', goal: 'Prove the property holds for every even n > 2', mode: 'formal' });

  assert.ok(threw, 'the pairing really was attempted');
  assert.equal(r.success, true, 'a failed pairing must not fail the session');
  assert.ok(mem.reasoning.getMostRecentActiveSession(), 'the session still exists');
  mem.close();
});
