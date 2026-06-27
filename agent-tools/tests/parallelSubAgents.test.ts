/**
 * runParallelSubAgents (H1) — fan-out, isolation, shared budget, failure isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runParallelSubAgents,
  aggregateSubAgentResults,
  type SubTask,
  type SubAgentResult,
} from '../src/control/parallelSubAgents.js';
import type { MiniLoopLLMClient, MiniLoopToolRunResult } from '../src/utils/mini-agent-loop.js';

const noopRunner = async (): Promise<MiniLoopToolRunResult> => ({ ok: true, output: '' });

/** Mock LLM: echoes the child's OWN last user message back (proves isolation), 10 tokens; throws for a
 * task whose user message contains `boomOn` (→ a failed child). */
function mkLLM(boomOn?: string): MiniLoopLLMClient {
  return {
    send: async (_sys, msgs) => {
      const userText = String(msgs[msgs.length - 1]?.content ?? '');
      if (boomOn && userText.includes(boomOn)) throw new Error('mock LLM boom');
      return { type: 'text', content: `done:${userText}`, tokensUsed: 10 };
    },
  };
}

const tasks = (...ids: string[]): SubTask[] =>
  ids.map((id) => ({ id, systemPrompt: 'sys', userMessage: `task-${id}` }));

test('fan-out: children run isolated, results ordered, each sees only its own input', async () => {
  const r = await runParallelSubAgents(tasks('a', 'b', 'c'), { llm: mkLLM(), toolDefs: [], toolRunner: noopRunner });
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c']);
  assert.ok(r.every((x) => x.status === 'success'));
  assert.equal(r[0].finalText, 'done:task-a', 'child a saw only its own message');
  assert.equal(r[2].finalText, 'done:task-c');
});

test('a failing child is isolated — the batch never rejects; others succeed', async () => {
  const r = await runParallelSubAgents(tasks('a', 'b', 'c'), { llm: mkLLM('task-b'), toolDefs: [], toolRunner: noopRunner });
  assert.equal(r[1].status, 'failed');
  assert.match(r[1].error ?? '', /boom|llm_error/);
  assert.equal(r[0].status, 'success');
  assert.equal(r[2].status, 'success');
});

test('shared budget: children over the token ceiling are SKIPPED (not truncated)', async () => {
  // concurrency=1 → deterministic spend: a(→10), b(10<15→run→20), c(20≥15→skip).
  const r = await runParallelSubAgents(tasks('a', 'b', 'c'), {
    llm: mkLLM(),
    toolDefs: [],
    toolRunner: noopRunner,
    concurrency: 1,
    budgetTokens: 15,
  });
  assert.equal(r[0].status, 'success');
  assert.equal(r[1].status, 'success');
  assert.equal(r[2].status, 'skipped');
  assert.match(r[2].error ?? '', /budget/);
});

test('aborted batch → all failed; empty tasks → empty result', async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await runParallelSubAgents(tasks('a', 'b'), {
    llm: mkLLM(),
    toolDefs: [],
    toolRunner: noopRunner,
    abortSignal: ac.signal,
  });
  assert.ok(r.every((x) => x.status === 'failed' && x.error === 'aborted'));
  assert.deepEqual(await runParallelSubAgents([], { llm: mkLLM(), toolDefs: [], toolRunner: noopRunner }), []);
});

test('aggregateSubAgentResults: concats successful children, skips failed/empty', () => {
  const results: SubAgentResult[] = [
    { id: 'a', status: 'success', finalText: 'AAA', tokensSpent: 1 },
    { id: 'b', status: 'failed', finalText: '', tokensSpent: 0, error: 'x' },
    { id: 'c', status: 'success', finalText: 'CCC', tokensSpent: 1 },
  ];
  assert.equal(aggregateSubAgentResults(results), '### a\nAAA\n\n### c\nCCC');
});
