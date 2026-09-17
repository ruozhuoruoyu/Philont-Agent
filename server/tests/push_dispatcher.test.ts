/**
 * PushDispatcher 单测:全局 kill / 订阅检查 / 频次 / 静默 / dedup / fan-out。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../agent-memory/src/index.js';
import {
  PushDispatcher,
  isInQuietHours,
  type PushRequest,
} from '../src/push/dispatcher.js';
import {
  registerPushChannel,
  unregisterPushChannel,
  _resetPushChannelsForTest,
  type PushChannel,
  type PushTextResult,
} from '../src/push/channel.js';

function fakeChannel(name = 'wechat:test', ready = true): {
  channel: PushChannel;
  sent: Array<{ peer: string; text: string }>;
  setReady: (v: boolean) => void;
  setReturn: (r: PushTextResult) => void;
} {
  const sent: Array<{ peer: string; text: string }> = [];
  let isReady = ready;
  let nextResult: PushTextResult = { ok: true, messageIds: ['m1'] };
  const channel: PushChannel = {
    name,
    isReady: () => isReady,
    pushText: async (peer, text) => {
      sent.push({ peer, text });
      return nextResult;
    },
  };
  return {
    channel,
    sent,
    setReady: (v) => {
      isReady = v;
    },
    setReturn: (r) => {
      nextResult = r;
    },
  };
}

function setup(opts: { globalEnabled?: boolean; now?: () => number } = {}) {
  _resetPushChannelsForTest();
  const h = openMemoryDb(':memory:');
  const dispatcher = new PushDispatcher({
    subscriptions: h.pushSubscriptions,
    deferredPushes: h.deferredPushes,
    isGloballyEnabled: () => opts.globalEnabled ?? true,
    now: opts.now ?? (() => Date.now()),
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  return { h, dispatcher };
}

const URGENT_REQ: PushRequest = {
  severity: 'urgent',
  kind: 'autonomous_finding',
  targetRef: 'initiative:abc',
  text: 'urgent text',
};

const DIGEST_REQ: PushRequest = {
  severity: 'digest',
  kind: 'service:dormancy-checkin',
  targetRef: 'service:checkin:day-1',
  text: 'digest text',
};

test('task heartbeat and milestone bypass the routine hourly budget without starving each other', async () => {
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  await dispatcher.enqueue(URGENT_REQ);
  const heartbeat = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb', progress: 'heartbeat' });
  assert.equal(heartbeat.delivered, 1);
  const milestone = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'stage1', progress: 'milestone' });
  assert.equal(milestone.delivered, 1);
  const held = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'stage2', progress: 'milestone' });
  assert.equal(held.delivered, 0);
  assert.equal(held.deferred, 1, 'rate-limited成果必须进入下次来信的待送队列');
  assert.equal(h.deferredPushes.listPending(f.channel.name, 'p1').length, 1);
  now += 300_000;
  assert.equal((await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb2', progress: 'heartbeat' })).delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 全局 kill ───────────────────────────────────────────────────────────

test('dispatcher: 全局 kill → skip global_disabled', async () => {
  const { h, dispatcher } = setup({ globalEnabled: false });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(r.skipped[0].reason, 'global_disabled');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 无订阅 ──────────────────────────────────────────────────────────────

// 2026-07-22 behaviour change (deliberate, not a silenced test). This used to assert that having no
// subscription produced an EMPTY skip list — a silent drop, described as "normal state". It is the most
// common way a push dies and it was the quietest: a channel nobody had opted into looked exactly like a
// channel with nothing to say, and the owner's report was "it never tells me anything". Not delivering
// is still correct (opt-in is consent); being unable to find out why is not.
test('dispatcher: 无订阅 → 不投递,但要说明原因(不再静默丢)', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0, 'still delivers nothing — opt-in is consent, not a bug');
  assert.equal(r.skipped.length, 1, 'but the reason is now recorded');
  assert.equal(r.skipped[0].reason, 'no_active_subscription');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── channel 不存在 / 不 ready ───────────────────────────────────────────

test('dispatcher: 订阅了但 channel 未注册 → skip channel_not_found', async () => {
  const { h, dispatcher } = setup();
  h.pushSubscriptions.subscribe({ channel: 'wechat:nonexist', peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'channel_not_found');
  h.close();
});

test('dispatcher: channel.isReady=false → skip channel_not_ready', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel('wechat:test', false);
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'channel_not_ready');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── happy path ──────────────────────────────────────────────────────────

test('dispatcher: 订阅 + ready + 无限速 → urgent push 成功', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].peer, 'p1');
  assert.match(f.sent[0].text, /urgent text/);

  // last_urgent_at 已写
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.ok(sub.lastUrgentAt !== null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: digest push 写 lastDigestAt 而非 lastUrgentAt', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  await dispatcher.enqueue(DIGEST_REQ);
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.ok(sub.lastDigestAt !== null);
  assert.equal(sub.lastUrgentAt, null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 频次限速 ───────────────────────────────────────────────────────────

test('dispatcher: urgent 频次限速 → skip rate_limited', async () => {
  let now = 1_000_000;
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 60_000, // 1 分钟
  });

  // 第一次 OK
  await dispatcher.enqueue(URGENT_REQ);
  // 30s 后第二次同 kind 但不同 targetRef(避免 dedup 影响)
  now += 30_000;
  const r = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:def' });
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'rate_limited');

  // 60s 后(总 90s)第三次 → 通过
  now += 60_000;
  const r2 = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:ghi' });
  assert.equal(r2.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 24h dedup ──────────────────────────────────────────────────────────

test('dispatcher: 同 (kind, targetRef) 24h 内 dedup', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 0, // 关闭频次限速,只测 dedup
  });

  await dispatcher.enqueue(URGENT_REQ);
  const r2 = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r2.delivered, 0);
  assert.equal(r2.skipped[0].reason, 'duplicate');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 不同 targetRef → 不 dedup', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    urgentMinIntervalMs: 0,
  });

  await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:1' });
  const r = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:2' });
  assert.equal(r.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 静默时段 ───────────────────────────────────────────────────────────

test('isInQuietHours: 同日窗口 [22, 7) 跨午夜', () => {
  assert.equal(isInQuietHours(23, 22, 7), true);
  assert.equal(isInQuietHours(0, 22, 7), true);
  assert.equal(isInQuietHours(6, 22, 7), true);
  assert.equal(isInQuietHours(7, 22, 7), false);
  assert.equal(isInQuietHours(8, 22, 7), false);
  assert.equal(isInQuietHours(21, 22, 7), false);
});

test('isInQuietHours: 不跨午夜 [9, 17)', () => {
  assert.equal(isInQuietHours(10, 9, 17), true);
  assert.equal(isInQuietHours(8, 9, 17), false);
  assert.equal(isInQuietHours(17, 9, 17), false);
});

test('isInQuietHours: 0 长度窗口 [10, 10) → 永不命中', () => {
  for (let h = 0; h < 24; h++) {
    assert.equal(isInQuietHours(h, 10, 10), false);
  }
});

test('dispatcher: 静默时段命中 → skip quiet_hours(urgent 也尊重)', async () => {
  // mock now 在 UTC 23 点(quiet [22, 7) 内)
  const utcMidnight = Date.UTC(2026, 4, 6, 23, 0); // 2026-05-06 23:00 UTC
  const { h, dispatcher } = setup({ now: () => utcMidnight });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    quietStartHour: 22,
    quietEndHour: 7,
    // timezone 不给 → UTC
  });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 0);
  assert.equal(r.skipped[0].reason, 'quiet_hours');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 静默窗外 → 通过', async () => {
  const utcNoon = Date.UTC(2026, 4, 6, 12, 0); // 12:00 UTC
  const { h, dispatcher } = setup({ now: () => utcNoon });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({
    channel: f.channel.name,
    peer: 'p1',
    quietStartHour: 22,
    quietEndHour: 7,
  });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── routing 显式 vs fan-out ────────────────────────────────────────────

test('dispatcher: 多订阅同 channel,无 routing → fan-out 全发', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p2', urgentMinIntervalMs: 0 });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 2);
  assert.equal(f.sent.length, 2);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 显式 routing → 只发指定 (channel, peer)', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p2', urgentMinIntervalMs: 0 });

  const r = await dispatcher.enqueue({
    ...URGENT_REQ,
    routing: { channel: f.channel.name, peer: 'p2' },
  });
  assert.equal(r.delivered, 1);
  assert.equal(f.sent[0].peer, 'p2');
  unregisterPushChannel(f.channel.name);
  h.close();
});

// ── 失败处理 ───────────────────────────────────────────────────────────

test('dispatcher: channel.pushText 返 ok=false → failed 计数', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  f.setReturn({ ok: false, error: 'network down' });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.failed, 1);
  assert.equal(r.delivered, 0);
  // last_urgent_at 不应写(不是成功)
  const sub = h.pushSubscriptions.get(f.channel.name, 'p1')!;
  assert.equal(sub.lastUrgentAt, null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: 失败不写 dedup ring,下次同请求可重试', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  f.setReturn({ ok: false });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });

  await dispatcher.enqueue(URGENT_REQ);
  // 修复 channel
  f.setReturn({ ok: true, messageIds: ['m1'] });
  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1, '失败后 dedup 不应记录 fingerprint');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: WeChat ret=-2 becomes one durable next-inbound item, not a blind failure', async () => {
  const now = 10_000;
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  f.setReturn({ ok: false, retry: 'next_inbound', code: -2, error: 'prepare failed' });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });

  const first = await dispatcher.enqueue(URGENT_REQ);
  const second = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(first.failed, 0);
  assert.equal(first.deferred, 1);
  assert.equal(second.deferred, 1);
  assert.equal(h.deferredPushes.count(), 1, 'semantic upsert prevents duplicate cards');
  const pending = h.deferredPushes.listPending(f.channel.name, 'p1', 1, now)[0]!;
  assert.equal(pending.text, URGENT_REQ.text);
  assert.equal(h.pushSubscriptions.get(f.channel.name, 'p1')!.lastUrgentAt, null);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: partial delivery queues only the remainder and does not claim completion', async () => {
  const now = 10_000;
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  f.setReturn({
    ok: false, retry: 'next_inbound', partiallyDelivered: true,
    deferredText: 'unsent remainder', error: 'allowance exhausted',
  });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });

  const first = await dispatcher.enqueue(URGENT_REQ);
  assert.deepEqual(
    { delivered: first.delivered, partial: first.partiallyDelivered, deferred: first.deferred },
    { delivered: 0, partial: 1, deferred: 1 },
  );
  assert.equal(h.deferredPushes.listPending(f.channel.name, 'p1', 1, now)[0]?.text, 'unsent remainder');
  assert.equal(h.pushSubscriptions.get(f.channel.name, 'p1')!.lastUrgentAt, null,
    'partial_deferred must not advance the subscription limiter');
  await dispatcher.enqueue(URGENT_REQ);
  assert.equal(f.sent.length, 2, 'partial_deferred is not a complete-delivery dedup fingerprint');
  assert.equal(h.deferredPushes.count(), 1, 'semantic mailbox upsert keeps one queued remainder');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('dispatcher: later direct success removes a stale deferred copy of the same notice', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 0 });
  h.deferredPushes.enqueue({
    channel: f.channel.name, peer: 'p1', severity: 'urgent', kind: URGENT_REQ.kind,
    targetRef: URGENT_REQ.targetRef, text: 'stale', expiresAt: Date.now() + 100_000,
  });

  const r = await dispatcher.enqueue(URGENT_REQ);
  assert.equal(r.delivered, 1);
  assert.equal(h.deferredPushes.count(), 0, 'the old mailbox copy must not be replayed later');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('a blocking decision card is not spent by routine milestones, and has its own floor', async () => {
  // Prod 2026-09-01: a routine auto-advance milestone was delivered at 23:11; the card saying the
  // batch had STOPPED as stuck — the one that needed an answer before anything could restart — was
  // dropped at 23:17 as `rate_limited (interval=3600000)`. Both were severity=urgent, so a progress
  // note spent the hour and the question that followed went unsaid.
  let now = 1_000_000;
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1', urgentMinIntervalMs: 60 * 60_000 });

  await dispatcher.enqueue(URGENT_REQ); // routine milestone spends the hourly budget
  now += 60_000;
  const routine = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'initiative:def' });
  assert.equal(routine.skipped[0].reason, 'rate_limited', 'routine notes still share one budget');

  const decision = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'paused:1', blocking: true });
  assert.equal(decision.delivered, 1, 'the question gets through');

  // But it is not unbounded: a second decision inside the floor is held.
  now += 60_000;
  const storm = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'paused:2', blocking: true });
  assert.equal(storm.delivered, 0);
  assert.equal(storm.skipped[0].reason, 'rate_limited');

  // And it did not spend the routine budget either — the two lanes stay separate.
  now += 5 * 60_000;
  const after = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'paused:3', blocking: true });
  assert.equal(after.delivered, 1);

  unregisterPushChannel(f.channel.name);
  h.close();
});

test('a consequent blocking card of another KIND is not rate-limited by the one it followed', async () => {
  // Prod 2026-09-10 23:13: budget card delivered at :12:59, owner answered, the grant re-armed the
  // driver, and the driver's admission card 59s later was `rate_limited (interval=300000)` by the
  // budget card. Storm protection is for many of the SAME question; a different question that the
  // owner's own answer caused must go through.
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  const budget = await dispatcher.enqueue({ ...URGENT_REQ, kind: 'deep_explore:budget_extension', targetRef: 'b:1', blocking: true });
  assert.equal(budget.delivered, 1);
  now += 59_000;
  const admission = await dispatcher.enqueue({ ...URGENT_REQ, kind: 'deep_explore:auto_admission', targetRef: 'a:1', blocking: true });
  assert.equal(admission.delivered, 1, 'a different blocking question 59s later must reach the owner');
  const budgetAgain = await dispatcher.enqueue({ ...URGENT_REQ, kind: 'deep_explore:budget_extension', targetRef: 'b:2', blocking: true });
  assert.equal(budgetAgain.delivered, 0, 'the SAME kind inside the floor is still held — that is the storm the floor exists for');
  assert.equal(budgetAgain.skipped[0]?.reason, 'rate_limited');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('a heartbeat yields the tail of a metered allowance to content', async () => {
  // Prod 2026-09-14 06:31 → 07:18: ten messages bought by "继续", six spent on "本轮已运行 5 分钟",
  // and the four milestones that carried the morning's proofs all bounced.
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  let remaining = 4;
  f.channel.allowance = () => ({ remaining, total: 10, sentSince: 10 - remaining });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  const hb = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb1', progress: 'heartbeat' });
  assert.equal(hb.delivered, 1, 'four left: a heartbeat may still go');
  remaining = 3; now += 300_000;
  const held = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb2', progress: 'heartbeat' });
  assert.equal(held.delivered, 0);
  assert.equal(held.skipped[0]?.reason, 'allowance_reserved');
  assert.equal(held.deferred, 0, 'a heartbeat held back is not a heartbeat owed');
  const milestone = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'stage1', progress: 'milestone' });
  assert.equal(milestone.delivered, 1, 'the reserve is for exactly this');
  remaining = 0; now += 300_000;
  const gone = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb3', progress: 'heartbeat' });
  assert.equal(gone.skipped[0]?.reason, 'allowance_reserved');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('a routine report leaves the last allowance slot to a blocking card', async () => {
  // Prod 2026-09-17 16:37 → 16:46: the tenth message was a round report; the "paused" card bounced.
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  let remaining = 2;
  f.channel.allowance = () => ({ remaining, total: 10, sentSince: 10 - remaining });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  const ok = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'r1', progress: 'milestone' });
  assert.equal(ok.delivered, 1, 'two left: a report may still go');
  remaining = 1; now += 300_000;
  const held = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'r2', progress: 'milestone' });
  assert.equal(held.delivered, 0);
  assert.equal(held.skipped[0]?.reason, 'allowance_reserved');
  assert.equal(held.deferred, 1, 'a report held back is owed at the next inbound');
  assert.equal(h.deferredPushes.listPending(f.channel.name, 'p1', 3, now)[0]?.targetRef, 'r2');
  const paused = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'paused', progress: 'milestone', blocking: true });
  assert.equal(paused.delivered, 1, 'the slot is for exactly this');
  assert.equal(f.sent.at(-1)?.text, 'urgent text');
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('the newest report of a series supersedes the older ones still in the mailbox', async () => {
  // Prod 2026-09-17 16:49: rounds 13, 19, 20 and "round 1" of the previous batch — with tree counts a
  // live card had already contradicted — were handed over under 此前未能送达的待办通知.
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  const series = (sid: string, n: number): PushRequest => ({
    ...URGENT_REQ, kind: 'deep_explore:auto_milestone', progress: 'milestone',
    targetRef: `deep_explore:progress:${sid}:${n}`, text: `round ${n} of ${sid}`,
    supersedes: `deep_explore:progress:${sid}:`,
  });
  f.setReturn({ ok: false, retry: 'next_inbound', error: 'prepare failed' });
  for (const n of [13, 14, 15]) { now += 400_000; await dispatcher.enqueue(series('A', n)); }
  now += 400_000; await dispatcher.enqueue(series('B', 1));
  const pending = h.deferredPushes.listPending(f.channel.name, 'p1', 10, now);
  assert.deepEqual(pending.map((p) => p.text).sort(), ['round 1 of B', 'round 15 of A'], 'one pending report per session, the newest');
  // A live delivery clears the session's backlog too: the owner just read a newer state.
  f.setReturn({ ok: true, messageIds: ['m'] });
  now += 400_000;
  const live = await dispatcher.enqueue(series('A', 16));
  assert.equal(live.delivered, 1);
  assert.deepEqual(h.deferredPushes.listPending(f.channel.name, 'p1', 10, now).map((p) => p.text), ['round 1 of B'], 'B untouched, A cleared');
  // Without the series prefix nothing is discarded (other kinds keep today's semantics).
  f.setReturn({ ok: false, retry: 'next_inbound', error: 'prepare failed' });
  now += 400_000; await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'x1', progress: 'milestone', kind: 'other' });
  now += 400_000; await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'x2', progress: 'milestone', kind: 'other' });
  assert.equal(h.deferredPushes.listPending(f.channel.name, 'p1', 10, now).length, 3);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('an unmetered channel never reserves', async () => {
  const { h, dispatcher } = setup();
  const f = fakeChannel();
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  assert.equal((await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb', progress: 'heartbeat' })).delivered, 1);
  unregisterPushChannel(f.channel.name);
  h.close();
});

test('a refused heartbeat is dropped, not deferred to the next inbound', async () => {
  // Prod 2026-09-13 23:13: three "本轮已运行 5 分钟" from the previous evening arrived under
  // "此前未能送达的待办通知". A heartbeat delivered later is false.
  let now = Date.now();
  const { h, dispatcher } = setup({ now: () => now });
  const f = fakeChannel();
  f.setReturn({ ok: false, retry: 'next_inbound', code: -2, error: 'prepare failed' });
  registerPushChannel(f.channel);
  h.pushSubscriptions.subscribe({ channel: f.channel.name, peer: 'p1' });
  const hb = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'hb', progress: 'heartbeat' });
  assert.equal(hb.deferred, 0);
  assert.equal(hb.failed, 1);
  assert.equal(h.deferredPushes.count(), 0, 'nothing owed');
  now += 300_000;
  const ms = await dispatcher.enqueue({ ...URGENT_REQ, targetRef: 'stage1', progress: 'milestone' });
  assert.equal(ms.deferred, 1, 'a milestone carries content and is still owed');
  unregisterPushChannel(f.channel.name);
  h.close();
});
