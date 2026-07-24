/**
 * InitiativeStore 单测:CRUD + 24h 去重。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, InitiativeStore } from '../src/index.js';

function setup() {
  const handle = openMemoryDb(':memory:');
  const store = new InitiativeStore(handle.db);
  return { handle, store };
}

test('initiative: insert + getById', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: 'fact:abc',
    rationale: 'low confidence',
    utility: 0.7,
    budgetEstimate: 1500,
  });
  assert.equal(i.status, 'pending');
  assert.equal(i.kind, 'fact_gap');
  assert.equal(i.budgetActual, null);

  const back = store.getById(i.id);
  assert.ok(back);
  assert.equal(back!.id, i.id);
  assert.equal(back!.targetRef, 'fact:abc');
  handle.close();
});

test('initiative: markRunning 仅在 pending 时生效', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'k',
    driver: 'gap',
    targetRef: 't:1',
    rationale: 'r',
    utility: 0.5,
    budgetEstimate: 1000,
  });
  const r1 = store.markRunning(i.id);
  assert.ok(r1);
  assert.equal(r1!.status, 'running');
  // 重复 markRunning 应失败(已不在 pending)
  const r2 = store.markRunning(i.id);
  assert.equal(r2, null);
  handle.close();
});

test('initiative: markDone 写 outcome + 改 status', () => {
  const { handle, store } = setup();
  const i = store.insert({
    kind: 'k',
    driver: 'gap',
    targetRef: 't:done',
    rationale: 'r',
    utility: 0.5,
    budgetEstimate: 1000,
  });
  store.markRunning(i.id);
  const done = store.markDone(
    i.id,
    'looked it up, all good',
    { facts: ['f1'], notes: ['n1'], pursuits: [] },
    1234,
  );
  assert.ok(done);
  assert.equal(done!.status, 'done');
  assert.equal(done!.outcomeSummary, 'looked it up, all good');
  assert.deepEqual(done!.outcomeRefs, { facts: ['f1'], notes: ['n1'], pursuits: [] });
  assert.equal(done!.budgetActual, 1234);
  handle.close();
});

test('initiative: markFailed / markSkipped', () => {
  const { handle, store } = setup();
  const i1 = store.insert({
    kind: 'k', driver: 'd', targetRef: 't:f', rationale: 'r', utility: 0.5, budgetEstimate: 100,
  });
  store.markRunning(i1.id);
  const failed = store.markFailed(i1.id, 'llm timeout', 50);
  assert.equal(failed!.status, 'failed');
  assert.equal(failed!.error, 'llm timeout');

  const i2 = store.insert({
    kind: 'k', driver: 'd', targetRef: 't:s', rationale: 'r', utility: 0.5, budgetEstimate: 100,
  });
  const skipped = store.markSkipped(i2.id, 'budget exhausted');
  assert.equal(skipped!.status, 'skipped');
  assert.equal(skipped!.error, 'budget exhausted');
  handle.close();
});

test('initiative: 24h dedupe 集合(done + failed 都进,skipped 不进)', () => {
  const { handle, store } = setup();
  const now = Date.now();

  const a = store.insert({ kind: 'k', driver: 'd', targetRef: 't:A', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(a.id);
  store.markDone(a.id, 's', { facts: [], notes: [], pursuits: [] }, 100);

  // failed 也进集合 — 防垃圾 token 反复 propose
  const b = store.insert({ kind: 'k', driver: 'd', targetRef: 't:B', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(b.id);
  store.markFailed(b.id, 'failed', 0);

  // skipped 不进集合(没真试过,budget 解锁后应允许重试)
  const c = store.insert({ kind: 'k', driver: 'd', targetRef: 't:C', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markSkipped(c.id, 'skipped');

  const recent = store.listRecentSettledTargetRefs(24 * 60 * 60 * 1000, now + 1000);
  assert.ok(recent.has('t:A'));
  assert.ok(recent.has('t:B'), 'failed 应进 dedup ring');
  assert.ok(!recent.has('t:C'), 'skipped 不应进 dedup');

  // backwards-compat alias 应等价
  const recentLegacy = store.listRecentDoneTargetRefs(24 * 60 * 60 * 1000, now + 1000);
  assert.ok(recentLegacy.has('t:A'));
  assert.ok(recentLegacy.has('t:B'));
  handle.close();
});

test('initiative: listRecentDone since cutoff', () => {
  const { handle, store } = setup();
  const i = store.insert({ kind: 'k', driver: 'd', targetRef: 't:1', rationale: 'r', utility: 0.7, budgetEstimate: 100 });
  store.markRunning(i.id);
  store.markDone(i.id, 'first', { facts: [], notes: [], pursuits: [] }, 100);

  const list = store.listRecentDone(0, 10);
  assert.equal(list.length, 1);
  assert.equal(list[0].outcomeSummary, 'first');

  // sinceTs in the future filters out
  const future = store.listRecentDone(Date.now() + 100_000, 10);
  assert.equal(future.length, 0);
  handle.close();
});

// ── listRecent + countByStatusGroup(dashboard 用)──────────────────────

test('listRecent: 默认按 created_at DESC 限 30', () => {
  const { handle, store } = setup();
  for (let i = 0; i < 5; i++) {
    store.insert({
      kind: 'k', driver: 'gap', targetRef: `t:${i}`,
      rationale: 'r', utility: 0.5, budgetEstimate: 100,
    });
  }
  const list = store.listRecent();
  assert.equal(list.length, 5);
  // 最新的(t:4)在前
  assert.equal(list[0].targetRef, 't:4');
  handle.close();
});

test('listRecent: limit 截断', () => {
  const { handle, store } = setup();
  for (let i = 0; i < 5; i++) {
    store.insert({
      kind: 'k', driver: 'gap', targetRef: `t:${i}`,
      rationale: 'r', utility: 0.5, budgetEstimate: 100,
    });
  }
  const list = store.listRecent({ limit: 2 });
  assert.equal(list.length, 2);
  handle.close();
});

test('listRecent: 按 status 过滤', () => {
  const { handle, store } = setup();
  const i1 = store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);
  store.insert({ kind: 'k', driver: 'gap', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const done = store.listRecent({ status: 'done' });
  assert.equal(done.length, 1);
  assert.equal(done[0].id, i1.id);

  const pending = store.listRecent({ status: 'pending' });
  assert.equal(pending.length, 1);
  handle.close();
});

test('listRecent: 按 driver 过滤', () => {
  const { handle, store } = setup();
  store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.insert({ kind: 'k', driver: 'curiosity', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.insert({ kind: 'k', driver: 'pursuit', targetRef: 't:3', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const gap = store.listRecent({ driver: 'gap' });
  assert.equal(gap.length, 1);
  assert.equal(gap[0].driver, 'gap');
  handle.close();
});

test('listRecent: 同时 status + driver 过滤', () => {
  const { handle, store } = setup();
  const i1 = store.insert({ kind: 'k', driver: 'gap', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);
  store.insert({ kind: 'k', driver: 'curiosity', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });

  const r = store.listRecent({ status: 'done', driver: 'gap' });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, i1.id);

  const r2 = store.listRecent({ status: 'done', driver: 'curiosity' });
  assert.equal(r2.length, 0);
  handle.close();
});

test('countByStatusGroup: 全 5 档,缺省 0', () => {
  const { handle, store } = setup();
  // 0 condition
  const empty = store.countByStatusGroup();
  assert.deepEqual(empty, { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 });

  // 注入混合状态
  const i1 = store.insert({ kind: 'k', driver: 'd', targetRef: 't:1', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i1.id);
  store.markDone(i1.id, 's', { facts: [], notes: [], pursuits: [] }, 100);

  const i2 = store.insert({ kind: 'k', driver: 'd', targetRef: 't:2', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i2.id);
  store.markFailed(i2.id, 'err', 50);

  store.insert({ kind: 'k', driver: 'd', targetRef: 't:3', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  // pending

  const counts = store.countByStatusGroup();
  assert.equal(counts.done, 1);
  assert.equal(counts.failed, 1);
  assert.equal(counts.pending, 1);
  assert.equal(counts.running, 0);
  assert.equal(counts.skipped, 0);
  handle.close();
});

// ── Escalating dormancy (listDormantTargetRefs) ─────────────────────────────
//
// The flat 24h window re-armed everything daily. Production, two consecutive days: the same ~40 gap facts
// re-researched at the same clock positions, the same three article URLs fetched four times across two
// days — ~57k tokens in one 45-minute stretch, none of it new. A repeat that keeps settling without
// changing anything earns a longer sleep: min(30d, 24h × 2^(N−1)) from the last settle.

const DAY = 24 * 60 * 60 * 1000;

/** Settle one initiative for `ref` and backdate its completion. */
function settleAt(handle: ReturnType<typeof openMemoryDb>, store: InitiativeStore, ref: string, completedAt: number) {
  const i = store.insert({ kind: 'k', driver: 'd', targetRef: ref, rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markRunning(i.id);
  store.markDone(i.id, 's', { facts: [], notes: [], pursuits: [] }, 100);
  handle.db.prepare(`UPDATE memory_initiatives SET completed_at = ? WHERE id = ?`).run(completedAt, i.id);
}

test('dormancy: 第一次结算保持今天的行为 —— 睡一天', () => {
  const { handle, store } = setup();
  const now = Date.now();
  settleAt(handle, store, 't:once', now - 2 * DAY + 1000);
  assert.ok(!store.listDormantTargetRefs(now).has('t:once'), '一天后醒来,与旧 24h 窗口一致');

  settleAt(handle, store, 't:fresh', now - 3600_000);
  assert.ok(store.listDormantTargetRefs(now).has('t:fresh'), '刚结算的仍在休眠');
  handle.close();
});

test('dormancy: 无产出的重复按 2^n 退避 —— 生产里的每日重研究在第二次后就该停', () => {
  const { handle, store } = setup();
  const now = Date.now();
  // The production shape: settled yesterday AND the day before (two settles, nothing changed).
  settleAt(handle, store, 'fact:8a29010f', now - 2 * DAY + 3600_000);
  settleAt(handle, store, 'fact:8a29010f', now - 1 * DAY + 3600_000);

  // Under the flat window it would be proposable again now. Under backoff: N=2 → sleep 2 days from the
  // last settle → still dormant today AND tomorrow.
  assert.ok(store.listDormantTargetRefs(now).has('fact:8a29010f'), '第三天不该再研究同一个 gap fact');

  // Five settles → 16-day sleep. Nine → capped at 30, not 256.
  for (let d = 3; d <= 5; d++) settleAt(handle, store, 't:worn', now - (6 - d) * DAY);
  settleAt(handle, store, 't:worn', now - 3 * DAY);
  settleAt(handle, store, 't:worn', now - 2 * DAY);
  assert.ok(store.listDormantTargetRefs(now).has('t:worn'), '5 次结算 → 睡 16 天,2 天前的最后一次远未到期');
  handle.close();
});

test('dormancy: 30 天封顶 —— 永不变成永久拉黑', () => {
  const { handle, store } = setup();
  const now = Date.now();
  // Nine settles, the last one 29 days ago: 2^8 days would be forever; the cap says 30d, so one more day
  // and it wakes. At 29d it is still dormant; backdate the last to 31d and everything falls out of the
  // 30d lookback entirely.
  for (let k = 0; k < 9; k++) settleAt(handle, store, 't:cap', now - 29 * DAY - k * 3600_000);
  assert.ok(store.listDormantTargetRefs(now).has('t:cap'), '29 天 < 30 天封顶,仍休眠');

  const { handle: h2, store: s2 } = setup();
  for (let k = 0; k < 9; k++) settleAt(h2, s2, 't:old', now - 31 * DAY - k * 3600_000);
  assert.ok(!s2.listDormantTargetRefs(now).has('t:old'), '滑出 30 天回看窗后重新可提 —— 世界可能已经变了');
  h2.close();
  handle.close();
});

test('dormancy: skipped 不算结算 —— 端点宕机不是对目标的证据', () => {
  // A 503 storm during one tick made five untouched targets "failed" with 0 tokens and 0 tools. Under
  // escalating dormancy that would double their sleep for an event that says nothing about them; the loop
  // now marks endpoint-down failures as skipped, and skipped never enters the dormancy set.
  const { handle, store } = setup();
  const now = Date.now();
  const i = store.insert({ kind: 'fact_gap', driver: 'gap', targetRef: 'fact:outage', rationale: 'r', utility: 0.5, budgetEstimate: 100 });
  store.markSkipped(i.id, 'llm endpoint down — not an attempt');
  assert.ok(!store.listDormantTargetRefs(now).has('fact:outage'), '跳过的目标下个 tick 就该重试');
  handle.close();
});
