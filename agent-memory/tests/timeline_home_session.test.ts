/**
 * "Recent", in a chat, means THIS chat.
 *
 * 2026-07-26 production: a WeChat turn ("继续", after an overnight gap) was assembled from the GLOBAL
 * recency window, so a scheduled mycox-checkin turn from a different session arrived inside "the last 30
 * messages", unlabelled and indistinguishable from what the owner had said. The agent read it as the live
 * thread, cancelled the mycox schedule and pruned the mycox-service skill from disk, and reported that as
 * completed work — while the owner believed they were doing mathematics: "我们不是在做数学吗？为什么突然
 * 跳转到自检了？"
 *
 * The option above restrictToSessionIds documented this same contamination in the OTHER direction
 * (a WeChat conversation leaking into a heartbeat) and closed it in 2026-05. The mirror stayed open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, TimelineRetriever } from '../src/index.js';
import { describeSessionOrigin } from '../src/timeline.js';

const WECHAT = 'wechat:o9cq@im.wechat:o9cq@im.wechat';
const SCHEDULED = 'system:scheduled:mycox-checkin';

function seed() {
  const db = openMemoryDb(':memory:');
  db.raw.startSession(WECHAT);
  db.raw.startSession(SCHEDULED);
  db.raw.appendMessage({ sessionId: WECHAT, role: 'user', content: '继续攻克 Gyárfás 路径染色问题' });
  db.raw.appendMessage({ sessionId: SCHEDULED, role: 'assistant', content: 'MycoX check-in：热榜 8 条实质性帖' });
  db.raw.appendMessage({ sessionId: WECHAT, role: 'assistant', content: '本轮验证了 80 个 4-临界图' });
  return { db, tl: new TimelineRetriever(db.raw) };
}

test('the recency window carries this conversation only', () => {
  const { tl } = seed();
  const r = tl.retrieve({ recentBudgetTokens: 4000, recallBudgetTokens: 0, homeSessionId: WECHAT });
  const text = r.messages.map((m) => m.content).join('\n');
  assert.match(text, /Gyárfás/);
  assert.doesNotMatch(text, /MycoX/, 'a scheduled task is not part of this chat');
  assert.equal(r.recencyCount, 2);
});

test('recall stays global — cross-channel continuity is the point — but says where a line came from', () => {
  const { tl } = seed();
  const r = tl.retrieve({
    recentBudgetTokens: 10,
    recallBudgetTokens: 4000,
    recallQuery: 'MycoX',
    homeSessionId: WECHAT,
  });
  const foreign = r.messages.find((m) => m.content.includes('MycoX'));
  assert.ok(foreign, 'the owner can still reach what was discussed elsewhere');
  assert.match(foreign!.content, /\[from another conversation — scheduled task mycox-checkin\]/);
});

test('without a home session nothing changes — the autonomous path keeps its own restriction', () => {
  const { tl } = seed();
  const r = tl.retrieve({ recentBudgetTokens: 4000, recallBudgetTokens: 0 });
  assert.equal(r.recencyCount, 3, 'global recency, as before');
  const scoped = tl.retrieve({
    recentBudgetTokens: 4000,
    recallBudgetTokens: 0,
    restrictToSessionIds: [SCHEDULED],
    homeSessionId: WECHAT,
  });
  assert.equal(scoped.recencyCount, 1, 'an explicit restriction still wins');
});

test('origins are named in words the model can act on', () => {
  assert.equal(describeSessionOrigin('wechat:x:y'), 'WeChat');
  assert.equal(describeSessionOrigin('system:scheduled:mycox-checkin'), 'scheduled task mycox-checkin');
  assert.equal(describeSessionOrigin('abc123'), 'the web UI');
});

test('lastMessageAt: the age a stale binding is judged by survives a restart', () => {
  const { db } = seed();
  assert.ok((db.raw.lastMessageAt(WECHAT) ?? 0) > 0);
  assert.ok((db.raw.lastMessageAt(WECHAT, 'assistant') ?? 0) > 0);
  assert.equal(db.raw.lastMessageAt('no-such-session'), null, 'unknown age → caller treats as stale');
});
