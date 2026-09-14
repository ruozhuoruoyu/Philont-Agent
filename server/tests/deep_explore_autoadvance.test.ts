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
    rootNodeId: null, budgetSpent: 0, budgetGranted: 0, noProgressRounds: 0, autoAdvance: true,
    autoPauseReason: null, autoPauseAt: null, mode: 'formal',
    createdAt: 0, updatedAt: 0, ...over,
  };
}

function fakeStore(opts: { active: ReasoningSession[]; afterRound?: (id: string) => ReasoningSession | null }) {
  const calls = { setAutoAdvance: [] as Array<[string, boolean]> };
  const pauses = new Map<string, ReasoningSession['autoPauseReason']>();
  const store = {
    listAutoAdvanceSessions: () => opts.active,
    setAutoAdvance: (id: string, on: boolean) => { calls.setAutoAdvance.push([id, on]); },
    setAutoPause: (id: string, reason: ReasoningSession['autoPauseReason']) => { pauses.set(id, reason); },
    getSession: (id: string) => {
      const s = opts.afterRound ? opts.afterRound(id) : sess({ id });
      return s ? { ...s, autoPauseReason: pauses.get(id) ?? s.autoPauseReason } : null;
    },
  } as unknown as ReasoningStore;
  return { store, calls };
}

const passthroughCtx = async <T>(_sid: string, fn: () => Promise<T>): Promise<T> => fn();

test('exhausted lifetime budget neither runs twenty empty rounds nor asks for tool admission', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const exhausted = sess({ budgetSpent: 300_614 });
  const { store, calls } = fakeStore({ active: [exhausted], afterRound: () => exhausted });
  let advanced = 0;
  let admissions = 0;
  const notes: string[] = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    hasFormalAdmission: () => false,
    requestFormalAdmission: () => { admissions++; },
    notify: (text) => { notes.push(text); },
  });
  await loop.tickOnce();
  assert.equal(advanced, 0);
  assert.equal(admissions, 0);
  assert.equal(loop.rearm('s'), false);
  assert.ok(calls.setAutoAdvance.every(([, enabled]) => !enabled));
  assert.match(notes[0], /300614\/300000/);
  assert.doesNotMatch(notes[0], /跑满.*轮/);
});

test('a spent session raises the budget card and disarms; a granted one runs', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  // Until 2026-09-10 this branch sent one notice and cleared auto_advance — so it could never fire
  // again for the same session. The card path replaces the notice; the disarm stays (a card is the
  // owner's decision, and the loop must not spend while it is unanswered).
  const exhausted = sess({ budgetSpent: 300_614 });
  const { store, calls } = fakeStore({ active: [exhausted], afterRound: () => exhausted });
  const cards: string[] = [];
  const notes: string[] = [];
  let advanced = 0;
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    hasFormalAdmission: () => true,
    requestBudgetExtension: (s) => { cards.push(s.id); },
    notify: (text) => { notes.push(text); },
  });
  await loop.tickOnce();
  assert.deepEqual(cards, ['s'], 'the budget card is the owner-facing path, not a fire-once notice');
  assert.equal(notes.length, 0, 'the card replaces the notice; the owner is not told twice');
  assert.equal(advanced, 0);
  assert.ok(calls.setAutoAdvance.some(([, enabled]) => enabled === false));

  // The owner's 同意 lands as budgetGranted; the same numbers are no longer exhausted.
  const granted = sess({ budgetSpent: 300_614, budgetGranted: 300_000 });
  const g = fakeStore({ active: [granted], afterRound: () => granted });
  let advanced2 = 0;
  const loop2 = createAutoAdvanceLoop({
    reasoning: g.store, runInContext: passthroughCtx,
    advanceSession: async () => { advanced2++; return { success: true, output: '' }; },
    hasFormalAdmission: () => true,
    requestBudgetExtension: (s) => { cards.push(`again:${s.id}`); },
    notify: () => {},
  });
  await loop2.tickOnce();
  assert.equal(cards.length, 1, 'a granted session is not asked again');
  assert.equal(advanced2, 1, 'the grant reaches the round runner');
  assert.equal(loop2.rearm('s'), true);
});

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

test('auto-advance: formal episode without workflow admission pauses before spending a round', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const requested: string[] = [];
  const { store, calls } = fakeStore({ active: [sess({ id: 'formal-no-grant' })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: () => {},
    hasFormalAdmission: () => false,
    requestFormalAdmission: (s) => requested.push(s.id),
  });
  await loop.tickOnce();
  assert.equal(advanced, 0, 'no blind verifier-less round ran');
  assert.deepEqual(calls.setAutoAdvance, [['formal-no-grant', false]]);
  assert.deepEqual(requested, ['formal-no-grant']);
  assert.equal(loop.pauseReason('formal-no-grant'), 'auth');
});

test('auto-advance: deliberate episode does not request the formal local-tool bundle', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  let advanced = 0;
  const { store } = fakeStore({ active: [sess({ id: 'deliberate', mode: 'deliberate' })] });
  const loop = createAutoAdvanceLoop({
    reasoning: store,
    advanceSession: async () => { advanced++; return { success: true, output: '' }; },
    runInContext: passthroughCtx,
    notify: () => {},
    hasFormalAdmission: () => false,
    requestFormalAdmission: () => assert.fail('deliberate work must not ask for formal verifier admission'),
  });
  await loop.tickOnce();
  assert.equal(advanced, 1);
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
    setAutoPause: () => {},
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
  assert.equal(notes.at(-1)!.important, true);
  assert.match(notes.at(-1)!.text, /卡住|暂停/);
  assert.equal(loop.pauseReason('a'), 'stuck');
  loop.rearm('a');
  assert.equal(loop.pauseReason('a'), null, 'continue/auto advance buys a fresh automatic batch');
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

test('long background rounds report status to their owner and stop reporting after completion', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const { store } = fakeStore({ active: [sess({ id: 'a', ownerSessionId: 'wechat:account:owner' })] });
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  const reports: Array<{ text: string; progress?: string; owner?: string | null }> = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => { await wait; return { success: true, output: 'internal model directives must not be sent' }; },
    notify: (text, opts) => reports.push({ text, progress: opts?.progress, owner: opts?.ownerSessionId }),
  });
  const tick = loop.tickOnce();
  t.mock.timers.tick(300_000);
  assert.equal(reports[0].progress, 'heartbeat');
  assert.equal(reports[0].owner, 'wechat:account:owner');
  assert.match(reports[0].text, /尚未返回结果/);
  finish();
  await tick;
  assert.equal(reports.at(-1)!.progress, 'milestone');
  assert.doesNotMatch(reports.at(-1)!.text, /internal model directives/);
  const count = reports.length;
  t.mock.timers.tick(600_000);
  assert.equal(reports.length, count);
});

test('auto-advance: batch boundary continues without asking the owner again', async () => {
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
  await loop.tickOnce(); // new batch, same task consent
  assert.equal(advanced, 3);
  assert.deepEqual(calls.setAutoAdvance, []);
  assert.ok(notes.every((n) => !/回复.*再加一批/.test(n.text)));
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

test('a round the endpoint never answered is held, not scored as stagnation', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  // Prod 2026-09-12 10:54:12 → 10:55:40: breaker open, two "rounds" with itersUsed=0, session declared
  // stuck and the owner handed a blocking "回复继续" card 90 seconds into an outage.
  const live = sess({ budgetSpent: 0, noProgressRounds: 0 });
  const { store, calls } = fakeStore({ active: [live], afterRound: () => live });
  let advanced = 0;
  const notes: Array<{ text: string; opts: any }> = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => {
      advanced++;
      return { success: false, output: '', error: 'round_not_run: 429', data: { notRun: true, reason: 'API 429' } };
    },
    hasFormalAdmission: () => true,
    notify: (text, opts) => { notes.push({ text, opts }); },
  });
  await loop.tickOnce();
  assert.equal(advanced, 1);
  assert.ok(!calls.setAutoAdvance.some(([, on]) => on === false), 'an outage must not disarm the session');
  assert.ok(!notes.some((n) => n.opts?.blocking), 'no stuck card for an outage');
  assert.ok(!notes.some((n) => /本轮执行失败|连续无进展/.test(n.text)), 'not reported as a failed or stagnant round');
  const held = notes.filter((n) => /端点|endpoint/.test(n.text));
  assert.equal(held.length, 1, 'said once, on the milestone lane');
  assert.equal(held[0].opts?.progress, 'milestone', 'the heartbeat lane is what the round\'s own heartbeats saturate');
  // Inside the backoff the session is not even attempted; nothing is said again.
  await loop.tickOnce();
  assert.equal(advanced, 1, 'held sessions are skipped, not retried every 30s');
  assert.equal(notes.filter((n) => /端点|endpoint/.test(n.text)).length, 1);
});

test('consecutive outages double the hold and are escalated once, as an important notice', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  // Prod 2026-09-13 18:06 → 21:06: thirteen not-run rounds twelve minutes apart, each a 7-minute hung
  // call plus a heartbeat to the owner, and the one explanatory notice rate-limited by those heartbeats.
  let now = 1_000_000;
  const live = sess({ budgetSpent: 0, noProgressRounds: 0 });
  const { store, calls } = fakeStore({ active: [live], afterRound: () => live });
  let advanced = 0;
  const notes: Array<{ text: string; opts: any }> = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx, now: () => now,
    advanceSession: async () => { advanced++; return { success: false, output: '', error: 'round_not_run: 300s', data: { notRun: true, reason: 'timeout' } }; },
    hasFormalAdmission: () => true,
    notify: (text, opts) => { notes.push({ text, opts }); },
  });
  const FIVE = 5 * 60_000;
  await loop.tickOnce();                       // strike 1 → hold 5min, milestone notice
  assert.equal(advanced, 1);
  now += FIVE - 1; await loop.tickOnce(); assert.equal(advanced, 1, 'inside the first hold');
  now += 2;        await loop.tickOnce(); assert.equal(advanced, 2, 'strike 2 → hold doubles to 10min');
  now += FIVE + 1; await loop.tickOnce(); assert.equal(advanced, 2, '5min is no longer enough');
  now += FIVE;     await loop.tickOnce(); assert.equal(advanced, 3, 'strike 3');
  const important = notes.filter((n) => n.opts?.important === true);
  assert.equal(important.length, 1, 'the third strike is said once, so it arrives');
  assert.match(important[0].text, /3|three/);
  assert.ok(!notes.some((n) => n.opts?.blocking), 'still no card: there is nothing for the owner to decide');
  assert.ok(!calls.setAutoAdvance.some(([, on]) => on === false), 'still armed');
  assert.equal(notes.filter((n) => /端点|endpoint/.test(n.text)).length, 2, 'first strike + escalation, nothing in between');
});

test('a retry after an outage is not narrated minute by minute', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  // Prod 2026-09-13 17:59 → 18:54: eight "本轮已运行 5/10 分钟" heartbeats for four rounds that all timed
  // out, while the notice that explained it was rate-limited by them.
  let now = 1_000_000;
  const live = sess({ budgetSpent: 0, noProgressRounds: 0 });
  const { store } = fakeStore({ active: [live], afterRound: () => live });
  const notes: string[] = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx, now: () => now, progressIntervalMs: 5,
    advanceSession: async () => {
      await new Promise((r) => setTimeout(r, 30)); // long enough for the ticker to fire if it is armed
      return { success: false, output: '', error: 'round_not_run: 300s', data: { notRun: true, reason: 'timeout' } };
    },
    hasFormalAdmission: () => true,
    notify: (text) => { notes.push(text); },
  });
  const heartbeats = () => notes.filter((t) => /本轮已运行/.test(t)).length;
  await loop.tickOnce();                 // first round: nothing known yet → heartbeats are legitimate
  const afterFirst = heartbeats();
  assert.ok(afterFirst >= 1, 'the ticker is armed on an ordinary round');
  now += 5 * 60_000 + 1; await loop.tickOnce();   // strike 2: a retry after an outage
  now += 10 * 60_000 + 1; await loop.tickOnce();  // strike 3
  assert.equal(heartbeats(), afterFirst, 'no minute-by-minute narration of a retry expected to fail');
});

function nodesFixture() {
  const mk = (id: string, parentId: string | null, status: string, claim: string, value: number | null) =>
    ({ id, parentId, status, claim, value, depth: parentId ? 1 : 0 }) as any;
  return [
    mk('root', null, 'open', 'G', null),
    mk('t', 'root', 'open', 'the pinned target', 0.4),
    mk('v', 'root', 'open', 'the most valuable leaf', 0.9),
    mk('done', 'root', 'proved', 'settled earlier', 0.5),
  ];
}

test('a milestone names the pinned target as the next step, never the root goal', async () => {
  // Every milestone the owner read on 2026-09-13/14 ended "下一步：写严格证明，我来跑lean" — the goal.
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const live = sess({ frontierTargetNodeId: 't' } as any);
  const { store } = fakeStore({ active: [live], afterRound: () => live });
  (store as any).getNodes = () => nodesFixture();
  const notes: string[] = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => ({ success: true, output: '' }),
    hasFormalAdmission: () => true,
    notify: (text) => { notes.push(text); },
  });
  await loop.tickOnce();
  const milestone = notes.find((t) => /第 1 轮已返回/.test(t))!;
  assert.match(milestone, /下一步：the pinned target/);
  assert.doesNotMatch(milestone, /下一步：G。/);
  // Without a pinned target, the most valuable frontier node.
  const unpinned = sess({ frontierTargetNodeId: null } as any);
  const { store: store2 } = fakeStore({ active: [unpinned], afterRound: () => unpinned });
  (store2 as any).getNodes = () => nodesFixture();
  const notes2: string[] = [];
  const loop2 = createAutoAdvanceLoop({
    reasoning: store2, runInContext: passthroughCtx,
    advanceSession: async () => ({ success: true, output: '' }),
    hasFormalAdmission: () => true,
    notify: (text) => { notes2.push(text); },
  });
  await loop2.tickOnce();
  assert.match(notes2.find((t) => /第 1 轮已返回/.test(t))!, /下一步：the most valuable leaf/);
});

test('a round that recorded a lemma but did not advance the target says so, not "no progress"', async () => {
  // Prod 2026-09-13 23:26: "本轮未确认有效进展 … 本轮新增记录：ARITHMETIC LEMMA" read as a contradiction.
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const before = nodesFixture().map((n) => (n.id === 'done' ? { ...n, status: 'open' } : n));
  let phase = 0;
  const after = sess({ noProgressRounds: 1 });
  const { store } = fakeStore({ active: [sess({})], afterRound: () => after });
  (store as any).getNodes = () => (phase++ === 0 ? before : nodesFixture());
  const notes: string[] = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => ({ success: true, output: '' }),
    hasFormalAdmission: () => true,
    notify: (text) => { notes.push(text); },
  });
  await loop.tickOnce();
  const milestone = notes.find((t) => /第 1 轮已返回/.test(t))!;
  assert.match(milestone, /本轮有新记录（见下），但未推进当前目标节点；连续 1 轮无实质进展/);
  assert.match(milestone, /本轮新增记录：settled earlier/);
  assert.doesNotMatch(milestone, /本轮未确认有效进展/);
});

test('a milestone carries the mainline metric: the chain to the target and what closed on it', async () => {
  process.env.PHILONT_DEEP_EXPLORE_AUTO_ADVANCE = 'on';
  const mk = (id: string, parentId: string | null, status: string, claim: string, depth: number) =>
    ({ id, parentId, status, claim, value: 0.5, depth }) as any;
  const before = [mk('root', null, 'open', 'G', 0), mk('a', 'root', 'open', 'A', 1), mk('t', 'a', 'open', 'T', 2), mk('x', 'root', 'open', 'X', 1)];
  const after = [mk('root', null, 'open', 'G', 0), mk('a', 'root', 'open', 'A', 1), mk('t', 'a', 'proved', 'T', 2), mk('x', 'root', 'proved', 'X', 1)];
  let phase = 0;
  const live = sess({ frontierTargetNodeId: 't' } as any);
  const { store } = fakeStore({ active: [live], afterRound: () => live });
  (store as any).getNodes = () => (phase++ === 0 ? before : after);
  const notes: string[] = [];
  const loop = createAutoAdvanceLoop({
    reasoning: store, runInContext: passthroughCtx,
    advanceSession: async () => ({ success: true, output: '' }),
    hasFormalAdmission: () => true,
    notify: (text) => { notes.push(text); },
  });
  await loop.tickOnce();
  const milestone = notes.find((t) => /第 1 轮已返回/.test(t))!;
  assert.match(milestone, /主线：根到本轮目标共 3 个节点，仍有 2 个未闭合；本轮闭合 1 个（T）/, 'X closed too, but X is not on the chain');
});
