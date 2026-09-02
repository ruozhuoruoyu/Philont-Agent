/**
 * An empty reply from the main model gets ONE retry with more room.
 *
 * Prod 2026-09-02, glm5.3-flash-b30t: inside a single turn the model emitted tool calls fine and then
 * returned an empty final text — twice in a row, each after ~80 seconds of generating, so it was
 * producing something the response never carried. The turn ended on the deterministic fallback
 * ("2 次工具调用…但未能生成可用结论。请回复继续"), which asks the owner for the one word that starts the
 * same loop over. The empty-conclusion gate does regenerate, but with the SAME parameters, and the log
 * shows it "stayed empty" both times.
 *
 * The aux path hit the identical failure and it went away the moment the budget grew (256 / 512 / 1024
 * all empty, 16384 fine).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMAdapter } from '../src/llm-adapter.js';

interface Captured { max_tokens: number; thinking?: { type: string } }

function withFakeFetch(replies: Array<{ content: string | null }>): { calls: Captured[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)) as Captured);
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function withEnv(fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  process.env.LLM_PROVIDER = 'glm';
  process.env.GLM_API_KEY = 'sk-test';
  process.env.GLM_MODEL = 'glm5.3-flash-b30t';
  process.env.PHILONT_LLM_MAX_TOKENS = '16000';
  delete process.env.PHILONT_LLM_EMPTY_RETRY_MAX_TOKENS;
  return fn().finally(() => { process.env = saved; });
}

test('an empty final text is retried once with a bigger budget, and the retry is what ships', async () => {
  await withEnv(async () => {
    const f = withFakeFetch([{ content: '' }, { content: 'the report' }]);
    try {
      const adapter = createLLMAdapter();
      const r = await adapter.send([{ role: 'user', content: 'go' }] as never);
      assert.equal(r.type, 'text');
      assert.equal((r as { content: string }).content, 'the report');
      assert.equal(f.calls.length, 2, 'exactly one retry');
      assert.equal(f.calls[0].max_tokens, 16000);
      assert.ok(f.calls[1].max_tokens > f.calls[0].max_tokens, 'the retry gets more room');
      assert.equal(f.calls[1].thinking?.type, 'disabled');
    } finally {
      f.restore();
    }
  });
});

test('it retries only once — an endpoint that only ever returns empty is reported, not hammered', async () => {
  await withEnv(async () => {
    const f = withFakeFetch([{ content: '' }]);
    try {
      const adapter = createLLMAdapter();
      const r = await adapter.send([{ role: 'user', content: 'go' }] as never);
      assert.equal((r as { content: string }).content, '', 'the empty result still comes back for the gates to handle');
      assert.equal(f.calls.length, 2);
    } finally {
      f.restore();
    }
  });
});

test('a normal reply is never retried', async () => {
  await withEnv(async () => {
    const f = withFakeFetch([{ content: 'fine' }]);
    try {
      const adapter = createLLMAdapter();
      await adapter.send([{ role: 'user', content: 'go' }] as never);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].thinking, undefined, 'and no thinking field is invented for a model that needs none');
    } finally {
      f.restore();
    }
  });
});
