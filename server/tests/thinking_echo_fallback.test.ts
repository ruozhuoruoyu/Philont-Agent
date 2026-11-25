/**
 * Thinking-echo 400 fallback decided by the endpoint, not only by the guard's prediction.
 *
 * Prod 2026-11-25: a turn died with `400 … The \`content[].thinking\` in the thinking mode must be passed
 * back to the API` even though hasToolUseWithoutThinking exists — the history had a shape the guard does
 * not predict. The reasoning the endpoint wants is not in the history either way, so the only request that
 * can succeed is the same one with thinking off and thinking blocks stripped. Both wire paths now take
 * that fallback once when the endpoint itself says so, and log the assistant-message layout that slipped
 * past the guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLLMAdapter,
  isThinkingEchoError,
  describeThinkingShape,
  adapterStats,
} from '../src/llm-adapter.js';

const ANTHROPIC_ECHO_400 = JSON.stringify({
  error: {
    type: '<nil>',
    message:
      'Invalid request parameters. Please check and try again. detail: The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: 77d7)',
  },
});
const OPENAI_ECHO_400 = JSON.stringify({
  error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' },
});

// A history the guard judges safe (every tool_use turn has its thinking block) — standing in for
// whatever shape the endpoint still rejects.
const history = [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 't1', name: 'webSearch', input: { q: 'x' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
  { role: 'assistant', content: 'interim text' },
  { role: 'user', content: 'continue' },
];

function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  Object.assign(process.env, env, { PHILONT_LLM_MAX_TOKENS: '16000' });
  return fn().finally(() => { process.env = saved; });
}

function stubFetch(responses: Array<{ status: number; body: string }>): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const real = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

const anthropicOk = JSON.stringify({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'deepseek-v4-flash',
  content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});
const openaiOk = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] });

const hasThinkingBlock = (msgs: unknown): boolean =>
  (msgs as Array<{ role: string; content: unknown }>).some(
    (m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'thinking'),
  );

test('isThinkingEchoError matches both wire shapes and nothing else', () => {
  assert.equal(isThinkingEchoError(new Error(`400 ${ANTHROPIC_ECHO_400}`)), true);
  assert.equal(isThinkingEchoError(OPENAI_ECHO_400), true);
  assert.equal(isThinkingEchoError(new Error('400 invalid tool_use id')), false);
  assert.equal(isThinkingEchoError(undefined), false);
});

test('describeThinkingShape names each assistant message layout', () => {
  assert.equal(describeThinkingShape(history as never), '#1[thinking:0,tool_use] #3"text"');
});

test('Anthropic path: echo 400 on a guard-approved history → one retry with thinking off and blocks stripped', async () => {
  await withEnv(
    { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_MODEL: 'deepseek-v4-flash' },
    async () => {
      // effort=medium keeps max_tokens under the SDK's streaming threshold, so the JSON stub applies.
      const f = stubFetch([{ status: 400, body: ANTHROPIC_ECHO_400 }, { status: 200, body: anthropicOk }]);
      const before = adapterStats.thinkingEchoFallbacks;
      try {
        const r = await createLLMAdapter().send(history as never, undefined, { reasoning: { enabled: true, effort: 'medium' } });
        assert.equal(r.type, 'text');
        assert.equal((r as { content: string }).content, 'done');
        assert.equal(f.bodies.length, 2, 'exactly one retry');
        assert.equal((f.bodies[0].thinking as { type: string }).type, 'enabled');
        assert.deepEqual(f.bodies[1].thinking, { type: 'disabled' });
        assert.equal(hasThinkingBlock(f.bodies[1].messages), false, 'thinking blocks stripped on the retry');
        assert.equal(adapterStats.thinkingEchoFallbacks, before + 1);
      } finally {
        f.restore();
      }
    },
  );
});

test('Anthropic path: a second echo 400 is not retried again (no loop)', async () => {
  await withEnv(
    { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_MODEL: 'deepseek-v4-flash' },
    async () => {
      const f = stubFetch([{ status: 400, body: ANTHROPIC_ECHO_400 }]);
      try {
        await assert.rejects(
          createLLMAdapter().send(history as never, undefined, { reasoning: { enabled: true, effort: 'high' } }),
          /must be passed back/,
        );
        assert.equal(f.bodies.length, 2);
      } finally {
        f.restore();
      }
    },
  );
});

test('OpenAI-compat path: echo 400 → one retry with thinking off and reasoning_content stripped', async () => {
  await withEnv({ LLM_PROVIDER: 'glm', GLM_API_KEY: 'sk-test', GLM_MODEL: 'glm-4.6' }, async () => {
    const f = stubFetch([{ status: 400, body: OPENAI_ECHO_400 }, { status: 200, body: openaiOk }]);
    try {
      const r = await createLLMAdapter().send(history as never, undefined, { reasoning: { enabled: true, effort: 'high' } });
      assert.equal((r as { content: string }).content, 'done');
      assert.equal(f.bodies.length, 2);
      assert.deepEqual(f.bodies[1].thinking, { type: 'disabled' });
      const msgs = f.bodies[1].messages as Array<Record<string, unknown>>;
      assert.equal(msgs.some((m) => 'reasoning_content' in m), false);
    } finally {
      f.restore();
    }
  });
});

test('a non-echo 400 still propagates untouched', async () => {
  await withEnv(
    { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_MODEL: 'deepseek-v4-flash' },
    async () => {
      const f = stubFetch([{ status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad tool schema' } }) }]);
      try {
        await assert.rejects(createLLMAdapter().send(history as never), /bad tool schema/);
        assert.equal(f.bodies.length, 1);
      } finally {
        f.restore();
      }
    },
  );
});
