/**
 * mini-agent-loop 单测。
 *
 * 用 stub LLM client + stub toolRunner 验证内核行为。不依赖真 LLM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopLLMResponse,
  type MiniLoopMessage,
  type MiniLoopToolRunResult,
} from '../src/utils/mini-agent-loop.js';
import type { ToolDefinition } from '@agent/policy';

// ── 测试辅助 ────────────────────────────────────────────────────────────

const NO_TOOLS: ToolDefinition[] = [];

function stubLLM(scripted: MiniLoopLLMResponse[]): MiniLoopLLMClient {
  let i = 0;
  return {
    async send() {
      if (i >= scripted.length) {
        throw new Error(`stub LLM exhausted at call ${i + 1}`);
      }
      return scripted[i++];
    },
  };
}

function textResponse(content: string, tokensUsed = 100): MiniLoopLLMResponse {
  return { type: 'text', content, tokensUsed };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  tokensUsed = 100,
): MiniLoopLLMResponse {
  return {
    type: 'toolCalls',
    calls,
    assistantMessage: {
      role: 'assistant',
      content: calls.map((c) => ({
        type: 'tool_use' as const,
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    },
    tokensUsed,
  };
}

// ── 测试 1:text-first response ─────────────────────────────────────────

test('text-first:LLM 直接出文本 → finalText 填充 + itersUsed=1', async () => {
  const llm = stubLLM([textResponse('done!')]);
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'hello',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: '' }),
  });

  assert.equal(r.finalText, 'done!');
  assert.equal(r.itersUsed, 1);
  assert.equal(r.hitCap, false);
  assert.equal(r.toolCallHistory.length, 0);
  assert.equal(r.toolCallsSpent, 0);
  assert.equal(r.error, undefined);
  assert.equal(r.llmTokensSpent, 100);
});

// ── 测试 2:tool cycle ─────────────────────────────────────────────────

test('tool cycle:LLM 调工具 → toolRunner ok → LLM 回文本结束', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'readFile', input: { path: '/x' } }]),
    textResponse('I read it: hello'),
  ]);
  const calls: string[] = [];
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'read /x',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async (name, input) => {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return { ok: true, output: 'hello' };
    },
  });

  assert.equal(r.finalText, 'I read it: hello');
  assert.equal(r.itersUsed, 2);
  assert.equal(r.hitCap, false);
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].name, 'readFile');
  assert.equal(r.toolCallHistory[0].ok, true);
  assert.match(r.toolCallHistory[0].outputPreview, /hello/);
  assert.equal(r.toolCallsSpent, 1);
  assert.deepEqual(calls, ['readFile:{"path":"/x"}']);
});

// ── 测试 3:iter cap ────────────────────────────────────────────────────

test('iter cap:LLM 死循环调工具 → 撞 cap 返回 hitCap=true,无 throw', async () => {
  // LLM 永远调 readFile,撞 cap=3
  const llm: MiniLoopLLMClient = {
    async send() {
      return toolCallResponse([
        { id: 'tc-' + Math.random(), name: 'readFile', input: {} },
      ]);
    },
  };
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm,
    toolDefs: NO_TOOLS,
    // Substantive output each round → the no-progress early exit does NOT fire, so this still exercises the
    // raw maxIters cap (a distinct no-progress test is added below).
    toolRunner: async () => ({ ok: true, output: 'a real, substantive result with plenty of information here' }),
    maxIters: 3,
  });

  assert.equal(r.hitCap, true);
  assert.equal(r.itersUsed, 3);
  assert.equal(r.finalText, '');
  assert.equal(r.toolCallHistory.length, 3);
  assert.equal(r.toolCallsSpent, 3);
  assert.equal(r.error, undefined); // hitCap 不算 error
});

// ── no-progress early exit (2026-07-15): consecutive empty tool rounds → stop before the cap ──────────
test('no-progress: repeated empty memory lookups stop early instead of burning the full budget', async () => {
  // The production churn: a deliberate deep_explore skeptic on a fresh topic calls memory tools that return
  // "no results" every round, and the loop ran its whole 6-iter budget in circles. It must now stop early.
  const isSalvage = (msgs: MiniLoopMessage[]) => {
    const last = msgs[msgs.length - 1];
    return typeof last?.content === 'string' && /FINAL answer/.test(last.content);
  };
  const llm: MiniLoopLLMClient = {
    async send(_sys, msgs) {
      if (isSalvage(msgs)) return textResponse('nothing found, concluding');
      return toolCallResponse([{ id: 'tc-' + Math.random(), name: 'search_notes', input: { q: 'x' } }]);
    },
  };
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'research a brand-new topic with nothing in memory',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: 'No matching notes found.' }), // ok, but empty
    maxIters: 6,
    synthesizeOnCap: true,
  });
  // Default NO_PROGRESS_ROUNDS=2 → stops after 2 unproductive rounds, well before maxIters=6.
  assert.ok(r.toolCallsSpent <= 2, `stopped early (spent ${r.toolCallsSpent}, not the full 6)`);
  assert.equal(r.finalText, 'nothing found, concluding', 'salvage synthesizes from what it has');
});

test('no-progress: a productive round resets the counter (does not stop on a single empty round)', async () => {
  let round = 0;
  const llm: MiniLoopLLMClient = {
    async send() {
      round++;
      if (round >= 5) return textResponse('finished after gathering enough');
      return toolCallResponse([{ id: 'tc-' + round, name: 'search_notes', input: {} }]);
    },
  };
  let call = 0;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm,
    toolDefs: NO_TOOLS,
    // empty, substantive, empty, substantive — never 2 empties in a row → never stops early.
    toolRunner: async () => {
      call++;
      return call % 2 === 1
        ? { ok: true, output: 'no results' }
        : { ok: true, output: 'a substantive finding with real content to report back' };
    },
    maxIters: 8,
  });
  assert.equal(r.finalText, 'finished after gathering enough', 'alternating empty/productive never trips early stop');
});

test('no-progress: tool authoring failures do not count as research stagnation', async () => {
  let round = 0;
  const llm: MiniLoopLLMClient = {
    async send() {
      round++;
      if (round === 4) return textResponse('repaired the script and obtained a result');
      return toolCallResponse([{ id: `tc-${round}`, name: 'pariGp', input: {} }]);
    },
  };
  const errors = ['variable name expected', 'run-away string', 'unexpected token'];
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'test a mathematical hypothesis',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: false, output: '', error: errors.shift() ?? 'syntax error' }),
    maxIters: 6,
  });
  assert.equal(r.finalText, 'repaired the script and obtained a result');
  assert.equal(r.toolCallsSpent, 3, 'distinct authoring errors remain repairable within the loop');
  assert.equal(r.error, undefined);
});

// ── 测试 4:whitelist 拦截 ──────────────────────────────────────────────

test('whitelist 拦截:LLM 调白名单外工具 → 返回 rejection,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'shell', input: { command: 'rm -rf /' } }]),
    textResponse('ok understood, will not'),
  ]);
  let runnerCalled = false;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'try shell',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      runnerCalled = true;
      return { ok: true, output: '' };
    },
    toolWhitelist: new Set(['readFile', 'listDir']),
  });

  assert.equal(runnerCalled, false, 'toolRunner should NOT be called for blocked tool');
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /sub-loop whitelist/);
  assert.equal(r.finalText, 'ok understood, will not');
  assert.equal(r.itersUsed, 2);
});

// ── 测试 5:blacklist 拦截 ──────────────────────────────────────────────

test('blacklist 拦截:LLM 调黑名单工具 → 返回 rejection,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'planAndExecute', input: { task: 'nest' } },
    ]),
    textResponse('cannot nest'),
  ]);
  let runnerCalled = false;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'try',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      runnerCalled = true;
      return { ok: true, output: '' };
    },
    toolBlacklist: new Set(['planAndExecute', 'askUserQuestion']),
  });

  assert.equal(runnerCalled, false);
  assert.equal(r.toolCallHistory.length, 1);
  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /sub-loop blacklist/);
  assert.equal(r.finalText, 'cannot nest');
});

// ── 测试 6:abortSignal ────────────────────────────────────────────────

test('abortSignal:中途 abort → 返回 error=aborted', async () => {
  const ac = new AbortController();
  // LLM 第一次调用前就 abort
  ac.abort();
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm: stubLLM([textResponse('never')]),
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: true, output: '' }),
    abortSignal: ac.signal,
  });

  assert.equal(r.error, 'aborted');
  assert.equal(r.finalText, '');
  assert.equal(r.itersUsed, 0);
});

// ── 测试 7(额外):tool runner throw → 优雅返回 tool error,loop 继续 ──

test('toolRunner throw:捕获并转 tool error,loop 继续', async () => {
  const llm = stubLLM([
    toolCallResponse([{ id: 'tc-1', name: 'shell', input: { command: 'oops' } }]),
    textResponse('handled'),
  ]);
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'go',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => {
      throw new Error('bug in runner');
    },
  });

  assert.equal(r.toolCallHistory[0].ok, false);
  assert.match(r.toolCallHistory[0].outputPreview, /tool runner threw/);
  assert.equal(r.finalText, 'handled');
});

test('same tool failure three times stops the sub-loop and requires a revised approach', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'pariGp', input: { script: '(bad' } },
      { id: 'tc-2', name: 'pariGp', input: { script: '(bad' } },
      { id: 'tc-3', name: 'pariGp', input: { script: '(bad' } },
    ]),
    textResponse('must not reach'),
  ]);
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'prove it',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async () => ({ ok: false, output: '', error: 'unclosed parenthesis at line 3' }),
    maxIters: 8,
  });

  assert.match(r.error ?? '', /repeated_tool_failure:pariGp/);
  assert.equal(r.itersUsed, 1);
  assert.equal(r.toolCallsSpent, 3);
  assert.equal(r.hitCap, false);
});

test('different HTTP status failures do not collapse into one repeated signature', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'webFetch', input: {} },
      { id: 'tc-2', name: 'webFetch', input: {} },
    ]),
    textResponse('reported both failures'),
  ]);
  let calls = 0;
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys', userMessage: 'fetch', llm, toolDefs: NO_TOOLS,
    toolRunner: async () => ({
      ok: false,
      output: '',
      error: calls++ === 0 ? 'HTTP 404 from endpoint' : 'HTTP 503 from endpoint',
    }),
    maxIters: 5,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.finalText, 'reported both failures');
});

// ── 测试 8(额外):多 tool calls 一轮 → 全部跑 ───────────────────────

test('单轮多 tool_use:全部跑完再下一轮', async () => {
  const llm = stubLLM([
    toolCallResponse([
      { id: 'tc-1', name: 'readFile', input: { path: '/a' } },
      { id: 'tc-2', name: 'readFile', input: { path: '/b' } },
    ]),
    textResponse('both read'),
  ]);
  const calls: string[] = [];
  const r = await runMiniAgentLoop({
    systemPrompt: 'sys',
    userMessage: 'multi',
    llm,
    toolDefs: NO_TOOLS,
    toolRunner: async (_n, input) => {
      calls.push(input.path as string);
      return { ok: true, output: `read ${input.path}` };
    },
  });

  assert.equal(r.toolCallHistory.length, 2);
  assert.equal(r.toolCallsSpent, 2);
  assert.equal(r.itersUsed, 2);
  assert.deepEqual(calls, ['/a', '/b']);
});
