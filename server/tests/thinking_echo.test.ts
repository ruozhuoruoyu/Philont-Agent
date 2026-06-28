/**
 * Thinking-echo 400 guard: a tool_use assistant turn without a thinking block (harness-synthetic /
 * auth-resume) must disable thinking + strip thinking blocks for that send, else DeepSeek 400s with
 * "content[].thinking must be passed back".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasToolUseWithoutThinking, stripThinkingBlocks } from '../src/llm-adapter.js';

const A = (content: unknown) => ({ role: 'assistant' as const, content: content as never });
const U = (content: unknown) => ({ role: 'user' as const, content: content as never });

test('hasToolUseWithoutThinking: synthetic tool_use (no thinking) → true', () => {
  const msgs = [
    U('go'),
    A([{ type: 'tool_use', id: 't1', name: 'deep_explore', input: { action: 'continue' } }]),
  ];
  assert.equal(hasToolUseWithoutThinking(msgs as never), true);
});

test('hasToolUseWithoutThinking: real thinking+tool_use turn → false (normal turns untouched)', () => {
  const msgs = [
    U('go'),
    A([
      { type: 'thinking', thinking: '…', signature: 'sig' },
      { type: 'tool_use', id: 't1', name: 'webSearch', input: { q: 'x' } },
    ]),
  ];
  assert.equal(hasToolUseWithoutThinking(msgs as never), false);
});

test('hasToolUseWithoutThinking: text-only / string content → false', () => {
  assert.equal(hasToolUseWithoutThinking([U('go'), A('just text')] as never), false);
  assert.equal(hasToolUseWithoutThinking([A([{ type: 'text', text: 'hi' }])] as never), false);
});

test('stripThinkingBlocks: removes thinking from assistant, leaves user + others intact', () => {
  const msgs = [
    U([{ type: 'tool_result', tool_use_id: 't0', content: 'r' }]),
    A([
      { type: 'thinking', thinking: '…', signature: 's' },
      { type: 'redacted_thinking', data: 'd' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ]),
  ];
  const out = stripThinkingBlocks(msgs as never) as Array<{ role: string; content: Array<{ type: string }> }>;
  assert.deepEqual(out[1].content.map((b) => b.type), ['tool_use'], 'thinking + redacted_thinking dropped');
  assert.equal(out[0], msgs[0], 'user message unchanged (same ref)');
});
