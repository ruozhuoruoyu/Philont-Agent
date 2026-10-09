/**
 * A text reply the output limit cut is continued once and joined; a reply still cut after that is marked.
 *
 * Prod 2026-10-09, glm5.3-flash-b30t over the Anthropic protocol: thinking took most of the 16000-token
 * budget, the visible reply was cut mid-sentence at stop_reason=max_tokens, and the adapter's text path
 * dropped the stop reason — so the honesty gate, the output filter and the WeChat sender all handled a
 * half reply as a finished one. The owner read summaries that simply stopped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLLMAdapter,
  joinContinuation,
  CONTINUATION_PROMPT,
  TRUNCATION_MARKER,
  adapterStats,
} from '../src/llm-adapter.js';

interface OpenAIReply { content: string; finish_reason: string }

function withOpenAIFetch(replies: OpenAIReply[]): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const real = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.content }, finish_reason: reply.finish_reason }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

function withOpenAIEnv(fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  process.env.LLM_PROVIDER = 'glm';
  process.env.GLM_API_KEY = 'sk-test';
  process.env.GLM_MODEL = 'glm5.3-flash-b30t';
  process.env.PHILONT_LLM_MAX_TOKENS = '16000';
  delete process.env.PHILONT_LLM_CONTINUE_ON_CAP;
  return fn().finally(() => { process.env = saved; });
}

test('OpenAI-compat path: a reply cut at finish_reason=length is continued once and joined', async () => {
  await withOpenAIEnv(async () => {
    const f = withOpenAIFetch([
      { content: 'The wall is in the inner weights, and the three remaining ques', finish_reason: 'length' },
      { content: 'tions are open. Done.', finish_reason: 'stop' },
    ]);
    const before = adapterStats.continuations;
    try {
      const r = await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never);
      assert.equal(r.type, 'text');
      const t = r as { content: string; stopReason?: string | null; truncated?: boolean };
      assert.equal(t.content, 'The wall is in the inner weights, and the three remaining questions are open. Done.');
      assert.equal(t.stopReason, 'stop');
      assert.equal(t.truncated, undefined);
      assert.equal(f.bodies.length, 2, 'exactly one continuation request');
      const msgs = f.bodies[1].messages as Array<{ role: string; content: string }>;
      assert.equal(msgs[msgs.length - 2].role, 'assistant');
      assert.equal(msgs[msgs.length - 2].content, 'The wall is in the inner weights, and the three remaining ques');
      assert.equal(msgs[msgs.length - 1].role, 'user');
      assert.equal(msgs[msgs.length - 1].content, CONTINUATION_PROMPT);
      assert.equal(adapterStats.continuations, before + 1);
    } finally {
      f.restore();
    }
  });
});

test('OpenAI-compat path: still cut after the continuation → marker appended, truncated=true, no third request', async () => {
  await withOpenAIEnv(async () => {
    const f = withOpenAIFetch([
      { content: 'first half', finish_reason: 'length' },
      { content: ' second half', finish_reason: 'length' },
    ]);
    try {
      const t = (await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never)) as {
        content: string; stopReason?: string | null; truncated?: boolean;
      };
      assert.equal(t.content, 'first half second half' + TRUNCATION_MARKER);
      assert.equal(t.truncated, true);
      assert.equal(t.stopReason, 'length');
      assert.equal(f.bodies.length, 2);
    } finally {
      f.restore();
    }
  });
});

test('OpenAI-compat path: a finished reply is never continued, and carries its stop reason', async () => {
  await withOpenAIEnv(async () => {
    const f = withOpenAIFetch([{ content: 'fine', finish_reason: 'stop' }]);
    try {
      const t = (await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never)) as { content: string; stopReason?: string | null };
      assert.equal(t.content, 'fine');
      assert.equal(t.stopReason, 'stop');
      assert.equal(f.bodies.length, 1);
    } finally {
      f.restore();
    }
  });
});

test('PHILONT_LLM_CONTINUE_ON_CAP=0 keeps the cut reply as-is (no continuation request)', async () => {
  await withOpenAIEnv(async () => {
    process.env.PHILONT_LLM_CONTINUE_ON_CAP = '0';
    const f = withOpenAIFetch([{ content: 'first half', finish_reason: 'length' }]);
    try {
      const t = (await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never)) as { content: string; stopReason?: string | null };
      assert.equal(t.content, 'first half');
      assert.equal(t.stopReason, 'length');
      assert.equal(f.bodies.length, 1);
    } finally {
      f.restore();
    }
  });
});

// ── Anthropic protocol (the production path: ANTHROPIC_MODEL=glm5.3-flash-b30t behind a gateway) ──

interface AnthropicReply { text: string; stop_reason: string; thinking?: string }

function withAnthropicFetch(replies: AnthropicReply[]): { bodies: Array<Record<string, unknown>>; restore: () => void } {
  const real = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    const content: unknown[] = [];
    if (reply.thinking) content.push({ type: 'thinking', thinking: reply.thinking, signature: 'sig' });
    content.push({ type: 'text', text: reply.text });
    return new Response(
      JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'glm5.3-flash-b30t',
        content, stop_reason: reply.stop_reason, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

function withAnthropicEnv(fn: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/api';
  process.env.ANTHROPIC_MODEL = 'glm5.3-flash-b30t';
  process.env.PHILONT_LLM_MAX_TOKENS = '16000';
  delete process.env.PHILONT_LLM_CONTINUE_ON_CAP;
  return fn().finally(() => { process.env = saved; });
}

test('Anthropic path: the cut reply is continued with the assistant turn echoed (thinking block included)', async () => {
  await withAnthropicEnv(async () => {
    const f = withAnthropicFetch([
      { text: '本轮结论：墙在内权', stop_reason: 'max_tokens', thinking: 'long thought' },
      { text: '重，三个问题仍开放。', stop_reason: 'end_turn' },
    ]);
    try {
      const t = (await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never, undefined, { reasoning: { enabled: true, effort: 'low' } })) as {
        content: string; stopReason?: string | null; truncated?: boolean;
      };
      assert.equal(t.content, '本轮结论：墙在内权重，三个问题仍开放。');
      assert.equal(t.stopReason, 'end_turn');
      assert.equal(f.bodies.length, 2);
      // GLM profile pins the toggle: low effort = thinking off on the wire.
      assert.deepEqual(f.bodies[0].thinking, { type: 'disabled' });
      const msgs = f.bodies[1].messages as Array<{ role: string; content: unknown }>;
      const echoed = msgs[msgs.length - 2];
      assert.equal(echoed.role, 'assistant');
      const blocks = echoed.content as Array<{ type: string }>;
      assert.deepEqual(blocks.map((b) => b.type), ['thinking', 'text'], 'the thinking block rides along (echo contract)');
      assert.equal((msgs[msgs.length - 1] as { content: string }).content, CONTINUATION_PROMPT);
    } finally {
      f.restore();
    }
  });
});

test('Anthropic path: still cut after the continuation → marker + truncated', async () => {
  await withAnthropicEnv(async () => {
    const f = withAnthropicFetch([
      { text: 'first half', stop_reason: 'max_tokens' },
      { text: ' second half', stop_reason: 'max_tokens' },
    ]);
    try {
      const t = (await createLLMAdapter().send([{ role: 'user', content: 'go' }] as never, undefined, { reasoning: { enabled: false } })) as {
        content: string; stopReason?: string | null; truncated?: boolean;
      };
      assert.equal(t.content, 'first half second half' + TRUNCATION_MARKER);
      assert.equal(t.truncated, true);
      assert.equal(f.bodies.length, 2);
    } finally {
      f.restore();
    }
  });
});

// ── joining ───────────────────────────────────────────────────────────────────────────────────────

test('joinContinuation: a restarted last line is deduplicated once; a mid-word cut joins directly', () => {
  assert.equal(joinContinuation('alpha beta gamma delta epsilon', 'gamma delta epsilon zeta'), 'alpha beta gamma delta epsilon zeta');
  assert.equal(joinContinuation('the three remaining ques', 'tions are open'), 'the three remaining questions are open');
  assert.equal(joinContinuation('ends with a space ', 'next'), 'ends with a space next');
  assert.equal(joinContinuation('no overlap here.', '\n\nNew paragraph.'), 'no overlap here.New paragraph.'.replace('.New', '. New'));
  assert.equal(joinContinuation('head', '   '), 'head');
});
