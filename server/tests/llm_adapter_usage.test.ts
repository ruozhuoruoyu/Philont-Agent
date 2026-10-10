/**
 * Token usage is counted per provider response and summed process-wide, so a headless run can write a
 * cost column (calls, input/output/cached tokens) into result.json next to pass/fail.
 *
 * 2026-10-10: every benchmark run so far reported seconds per task and nothing about tokens, which is
 * the one number a reader needs to turn a pass rate into a cost-per-success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMAdapter, adapterStats, recordAdapterUsage } from '../src/llm-adapter.js';

interface OpenAIReply {
  content: string;
  finish_reason: string;
  usage?: Record<string, unknown>;
}

function withOpenAIFetch(replies: OpenAIReply[]): { restore: () => void } {
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async () => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: reply.content }, finish_reason: reply.finish_reason }],
        ...(reply.usage ? { usage: reply.usage } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; } };
}

function withOpenAIEnv(fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  process.env.LLM_PROVIDER = 'glm';
  process.env.GLM_API_KEY = 'sk-test';
  process.env.GLM_MODEL = 'glm5.3-flash-b30t';
  process.env.PHILONT_LLM_MAX_TOKENS = '16000';
  return fn().finally(() => { process.env = saved; });
}

function snapshot() {
  return { ...adapterStats };
}

test('OpenAI-compat path: reported usage is summed into adapterStats, cached prompt tokens included', async () => {
  await withOpenAIEnv(async () => {
    const f = withOpenAIFetch([
      { content: 'first', finish_reason: 'stop', usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } } },
      { content: 'second', finish_reason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 5 } },
    ]);
    const before = snapshot();
    try {
      const adapter = createLLMAdapter();
      await adapter.send([{ role: 'user', content: 'a' }] as never);
      await adapter.send([{ role: 'user', content: 'b' }] as never);
    } finally {
      f.restore();
    }
    assert.equal(adapterStats.calls - before.calls, 2);
    assert.equal(adapterStats.inputTokens - before.inputTokens, 1250);
    assert.equal(adapterStats.outputTokens - before.outputTokens, 35);
    assert.equal(adapterStats.cacheReadTokens - before.cacheReadTokens, 1000);
  });
});

test('a response without a usage block still counts as a call and adds no tokens', async () => {
  await withOpenAIEnv(async () => {
    const f = withOpenAIFetch([{ content: 'no usage here', finish_reason: 'stop' }]);
    const before = snapshot();
    try {
      await createLLMAdapter().send([{ role: 'user', content: 'a' }] as never);
    } finally {
      f.restore();
    }
    assert.equal(adapterStats.calls - before.calls, 1);
    assert.equal(adapterStats.inputTokens, before.inputTokens);
    assert.equal(adapterStats.outputTokens, before.outputTokens);
  });
});

test('recordAdapterUsage treats missing fields as zero (the Anthropic path passes null cache reads through as undefined)', () => {
  const before = snapshot();
  recordAdapterUsage({ input: 7, output: undefined, cacheRead: undefined });
  recordAdapterUsage(undefined);
  assert.equal(adapterStats.calls - before.calls, 2);
  assert.equal(adapterStats.inputTokens - before.inputTokens, 7);
  assert.equal(adapterStats.outputTokens, before.outputTokens);
  assert.equal(adapterStats.cacheReadTokens, before.cacheReadTokens);
});
