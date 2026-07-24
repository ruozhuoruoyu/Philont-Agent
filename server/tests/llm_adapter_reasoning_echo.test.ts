/**
 * DeepSeek thinking over the OpenAI-compat path: reasoning_content must round-trip.
 *
 * Production 2026-07-24 17:46: a 537-second math turn died with HTTP 400 "The reasoning_content in the
 * thinking mode must be passed back to the API". The Anthropic path got the echo contract in June; the
 * OpenAI-compat translation silently DROPPED thinking blocks on send and never captured
 * reasoning_content on receipt — the contract was unsatisfiable by construction. Same defect family as
 * the pairing repair this path was also missing: a fix applied to one of two parallel paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, hasToolUseWithoutThinking, stripThinkingBlocks } from '../src/llm-adapter.js';
import type { NativeMessage } from '../src/llm-adapter.js';

const assistantWithThinking: NativeMessage = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'the graph must contain an odd cycle', signature: '' },
    { type: 'text', text: 'checking parity' },
    { type: 'tool_use', id: 't1', name: 'pariGp', input: { code: '1+1' } },
  ] as never,
};

test('a thinking block is echoed back as reasoning_content, not dropped', () => {
  const out = anthropicToOpenAI([assistantWithThinking]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal((out[0] as { reasoning_content?: string }).reasoning_content, 'the graph must contain an odd cycle');
  assert.equal(out[0].tool_calls?.length, 1);
});

test('an assistant turn without thinking gains no reasoning_content field', () => {
  const out = anthropicToOpenAI([
    { role: 'assistant', content: [{ type: 'text', text: 'plain answer' }] as never },
  ]);
  assert.equal('reasoning_content' in (out[0] as object), false);
});

test('the synthetic-turn guard fires on a rebuilt tool_use with no thinking — the 17:46 shape', () => {
  // Compaction / auth-resume / force-start reconstructs assistant turns without their reasoning. The
  // reasoning is genuinely gone; the only honest send disables thinking and strips leftovers.
  const rebuilt: NativeMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't2', name: 'webSearch', input: {} }] as never,
  };
  assert.equal(hasToolUseWithoutThinking([assistantWithThinking, rebuilt]), true);
  const stripped = stripThinkingBlocks([assistantWithThinking, rebuilt]);
  const blocks = stripped[0].content as Array<{ type: string }>;
  assert.equal(blocks.some((b) => b.type === 'thinking'), false);
});
