/**
 * Auto-advance loop (the deep_explore-body goal-loop driver, S2 P1). Round runner / push / ALS are mocked
 * — this verifies the branching: gate off → no-op; default ON; scoreTrajectory direction (switch_engine /
 * escalate); progress → milestone; solved → stop; rounds budget → pause + ask.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReasoningStore, ReasoningSession } from '@agent/memory';

// MAX_ROUNDS is captured at module load → set a small budget BEFORE importing, so the budget-cap test is fast.
process.env.PHILONT_GOAL_LOOP_MAX_ROUNDS = '2';
const { createAutoAdvanceLoop, autoAdvanceEnabled, episodeNoProgressRounds } = await import('../src/deep_explore_autoadvance.js');

function sess(over: Partial<ReasoningSession>): ReasoningSession {
  return {
    id: 's', goal: 'G', assumptions: [], status: 'active', ownerSessionId: 'u',
    rootNodeId: null, budgetSpent: 0, noProgressRounds: 0, autoAdvance: true,
    createdAt: 0, updatedAt: 0, ...over,
  };
}

function fakeStore(opts: { active: ReasoningSession[]; afterRound?: (id: string) => ReasoningSession | null }) {
  const calls = { setAutoAdvance: [] as Array<[string, boolean]> };
  const store = {
    listAutoAdvanceSessions: () => opts.active,
    setAutoAdvance: (id: string, on: boolean) => { calls.setAutoAdvance.push([id, on]); },
    getSession: (id: string) => (opts.afterRound ? opts.afterRound(id) : sess({ id })),
  } as unknown as ReasoningStore;
  return { store, calls };
}

const passthroughCtx = async <T>(_sid: string, fn: () => Promise<T>): Promise<T> => fn();

test('auto-advance: 默认 ON; =0 才关', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE;
  try {
    delete process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE;
    assert.equal(autoAdvanceEnabled(), true, '默认 ON (per-session commit is the real gate)');
    process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = '0';
    assert.equal(autoAdvanceEnabled(), false, '=0 关');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE;
    else process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = prev;
  }
});

test('auto-advance: 新 episode 不继承旧的无进展 streak', () => {
  assert.equal(episodeNoProgressRounds(9, 9), 0);
  assert.equal(episodeNoProgressRounds(10, 9), 1);
  assert.equal(episodeNoProgressRounds(0, 9), 0, '真实进展重置 persisted streak');
  assert.equal(episodeNoProgressRounds(2, 9), 2, '重置后的新 streak 直接计数');
});

test('auto-advance: 关闭(=0)→ 不推进', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = '0';
  let advanced = 0;
  const { store } = fakeStore({ active: [sess({ id: 'a' })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: () => {},
  });
  await loop.tickOnce();
  assert.equal(advanced, 0);
});

test('auto-advance: 旧 2 轮无进展不让刚启用的 episode 立即暂停', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ text: string; important?: boolean }> = [];
  const { store, calls } = fakeStore({ active: [sess({ id: 'a', noProgressRounds: 2 })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: (text, opts) => notes.push({ text, important: opts?.important }),
  });
  await loop.tickOnce();
  assert.equal(advanced, 1);
  assert.deepEqual(calls.setAutoAdvance, []);
  assert.equal(notes.length, 1, 'fresh session reset is reported as a milestone by this fake store');
});

test('auto-advance: 本 episode 累积到阈值后仍会暂停', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ text: string; important?: boolean }> = [];
  let noProgress = 3;
  const calls = { setAutoAdvance: [] as Array<[string, boolean]> };
  const store = {
    listAutoAdvanceSessions: () => [sess({ id: 'a', noProgressRounds: noProgress })],
    setAutoAdvance: (id: string, on: boolean) => { calls.setAutoAdvance.push([id, on]); },
    getSession: (id: string) => sess({ id, noProgressRounds: noProgress }),
  } as unknown as ReasoningStore;
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: (text, opts) => notes.push({ text, important: opts?.important }),
  });
  await loop.tickOnce(); // baseline=3, one round is allowed
  noProgress = 6;       // three flat automatic rounds relative to that baseline
  await loop.tickOnce();
  assert.equal(advanced, 1);
  assert.deepEqual(calls.setAutoAdvance, [['a', false]]);
  assert.equal(notes[0].important, true);
  assert.match(notes[0].text, /卡住|暂停/);
});

test('auto-advance: 有进展(counter 归零)→ 推进 + 里程碑(非 important)', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ important?: boolean }> = [];
  const { store } = fakeStore({
    active: [sess({ id: 'a', noProgressRounds: 0 })],
    afterRound: (id) => sess({ id, status: 'active', noProgressRounds: 0 }),
  });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: 'proved 1' }; },
    runInContext: passthroughCtx,
    notify: (_t, opts) => notes.push({ important: opts?.important }),
  });
  await loop.tickOnce();
  assert.equal(advanced, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].important, undefined);
});

test('auto-advance: rounds budget → 跑满 N 轮暂停 + 问加批', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const notes: Array<{ text: string; important?: boolean }> = [];
  const { store, calls } = fakeStore({
    active: [sess({ id: 'a', noProgressRounds: 0 })],
    afterRound: (id) => sess({ id, status: 'active', noProgressRounds: 0 }), // always progress → never stuck
  });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: 'progress' }; },
    runInContext: passthroughCtx,
    notify: (text, opts) => notes.push({ text, important: opts?.important }),
  });
  await loop.tickOnce(); // advance 1
  await loop.tickOnce(); // advance 2 (= MAX_ROUNDS)
  await loop.tickOnce(); // budget hit → pause, no 3rd advance
  assert.equal(advanced, 2, 'advanced exactly the budget (MAX_ROUNDS=2)');
  assert.deepEqual(calls.setAutoAdvance, [['a', false]]);
  assert.match(notes[notes.length - 1].text, /预算/);
});

test('auto-advance: 解出/闭合 → 停止 + important 通知', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const notes: Array<{ important?: boolean }> = [];
  const { store, calls } = fakeStore({
    active: [sess({ id: 'a' })],
    afterRound: (id) => sess({ id, status: 'solved' }),
  });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => ({ success: true, output: 'solved' }),
    runInContext: passthroughCtx,
    notify: (_t, opts) => notes.push({ important: opts?.important }),
  });
  await loop.tickOnce();
  assert.deepEqual(calls.setAutoAdvance, [['a', false]]);
  assert.equal(notes[0].important, true);
});
