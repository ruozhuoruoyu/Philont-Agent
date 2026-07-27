/**
 * Production 2026-07-27, 15:42 → 17:52. The owner asked four times for the LRC exploration to continue.
 * All four replies were a preamble with tools=0 — the turn closed, control yielded, nothing ran. He
 * eventually asked 你不是在推进LRC吗?
 *
 * honesty_gate's `announced_action_without_doing` branch was enabled and missed every one, because it
 * recognises the announcement by vocabulary (我先 / 首先 / "let me research"). 我现在看一下, 先看看,
 * 我现在就看 and "Calling deep_explore status" are each one word off the list.
 *
 * These tests pin the deterministic WINDOW — a tool named in the text that was never called this turn —
 * and the judge contract on top of it, with the aux caller injected so no live model is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findNamedTools,
  parseAnnouncedToolVerdict,
  detectAnnouncedToolStall,
} from '../src/announced_tool_gate.js';

const SCHEMA = ['deep_explore', 'search_notes', 'pariGp', 'shell', 'store_fact'];

// The four replies, as the turn log recorded them.
const REPLIES = [
  '## For User\n我现在看一下探索会话的状态，然后持续推进。\n\n## Work Log\nLet me check the deep_explore session status.',
  '## For User\n先看看当前探索会话里还剩下什么方向，然后推进。\n\n## Work Log\nLet me check the deep_explore tree.',
  '## For User\n先看探索会话的真实状态，说方向。\n\n## Work Log\nLet me check the current deep_explore session.',
  '## For User\n我现在就看。\n\n## Work Log\nCalling deep_explore status to see the current frontier.',
];

test('the window catches all four production replies regardless of phrasing', () => {
  for (const reply of REPLIES) {
    assert.deepEqual(findNamedTools(reply, SCHEMA), ['deep_explore'], reply.slice(0, 24));
  }
});

test('a tool name is matched as a whole identifier, not as a substring', () => {
  assert.deepEqual(findNamedTools('search_notes_v2 returned nothing', ['search_notes']), []);
  assert.deepEqual(findNamedTools('I will use search_notes now', ['search_notes']), ['search_notes']);
});

test('separators are normalised on both sides — the model writes deep explore / deep-explore', () => {
  assert.deepEqual(findNamedTools('starting deep explore now', SCHEMA), ['deep_explore']);
  assert.deepEqual(findNamedTools('starting Deep-Explore now', SCHEMA), ['deep_explore']);
});

test('a tool that WAS called this turn is not in the window', async () => {
  const r = await detectAnnouncedToolStall({
    finalText: 'Calling deep_explore status to see the current frontier.',
    toolNames: SCHEMA,
    calledToolNames: ['deep_explore'],
    call: async () => {
      throw new Error('the judge must not be consulted when the window is empty');
    },
  });
  assert.deepEqual(r.window, []);
  assert.equal(r.verdict, null);
  assert.equal(r.note, 'no_window');
});

test('inside the window, a pending verdict fires', async () => {
  const r = await detectAnnouncedToolStall({
    finalText: REPLIES[3],
    toolNames: SCHEMA,
    calledToolNames: [],
    call: async () => '{"pending": true, "tool": "deep_explore", "quote": "我现在就看"}',
  });
  assert.equal(r.verdict?.toolName, 'deep_explore');
  assert.equal(r.verdict?.quote, '我现在就看');
});

test('a text that only describes PAST work does not fire', async () => {
  const r = await detectAnnouncedToolStall({
    finalText: '昨天用 deep_explore 跑了 14 轮，树上还剩 10 个开放节点。',
    toolNames: SCHEMA,
    calledToolNames: [],
    call: async () => '{"pending": false}',
  });
  assert.deepEqual(r.window, ['deep_explore']);
  assert.equal(r.verdict, null);
  assert.equal(r.note, 'judge_says_not_pending');
});

test('an unreachable judge yields no verdict, and the window is still reported', async () => {
  const r = await detectAnnouncedToolStall({
    finalText: REPLIES[0],
    toolNames: SCHEMA,
    calledToolNames: [],
    call: async () => {
      throw new Error('aux down');
    },
  });
  assert.deepEqual(r.window, ['deep_explore']);
  assert.equal(r.verdict, null);
  assert.equal(r.note, 'judge_unavailable');
});

test('junk from the judge is treated as no verdict, never as a fire', async () => {
  for (const junk of ['', 'sure thing!', '{oops', '{"pending": "yes"}']) {
    const r = await detectAnnouncedToolStall({
      finalText: REPLIES[0],
      toolNames: SCHEMA,
      calledToolNames: [],
      call: async () => junk,
    });
    assert.equal(r.verdict, null, `junk: ${junk}`);
  }
});

test('a judge that echoes a tool we never offered falls back to the window', () => {
  const v = parseAnnouncedToolVerdict(
    '{"pending": true, "tool": "totally_made_up", "quote": "checking now"}',
    ['deep_explore'],
  );
  assert.equal(v?.toolName, 'deep_explore');
});
