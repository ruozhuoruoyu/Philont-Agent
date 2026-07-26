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
const BUCKET = 'global';

function seed() {
  const db = openMemoryDb(':memory:');
  // Production reality: EVERY row goes into one bucket; the conversation is carried by originSessionId.
  try { db.raw.startSession(BUCKET); } catch { /* openMemoryDb seeds the global bucket */ }
  db.raw.appendMessage({ sessionId: BUCKET, originSessionId: WECHAT, role: 'user', content: '继续攻克 Gyárfás 路径染色问题' });
  db.raw.appendMessage({ sessionId: BUCKET, originSessionId: SCHEDULED, role: 'assistant', content: 'MycoX check-in：热榜 8 条实质性帖' });
  db.raw.appendMessage({ sessionId: BUCKET, originSessionId: WECHAT, role: 'assistant', content: '本轮验证了 80 个 4-临界图' });
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

test('without a home session nothing changes — every row, as before', () => {
  const { tl } = seed();
  const r = tl.retrieve({ recentBudgetTokens: 4000, recallBudgetTokens: 0 });
  assert.equal(r.recencyCount, 3);
});

test('a row with NO origin is never excluded — starving the window is the worse failure', () => {
  // Everything written before schema v40 has origin NULL. Dropping those rows is precisely the 2026-07-26
  // regression: the recency window returned ZERO and the agent ran an evening with no memory of it.
  const { db, tl } = seed();
  db.raw.appendMessage({ sessionId: BUCKET, role: 'assistant', content: '一条 v40 之前写下的旧消息' });
  const r = tl.retrieve({ recentBudgetTokens: 4000, recallBudgetTokens: 0, homeSessionId: WECHAT });
  const text = r.messages.map((m) => m.content).join('\n');
  assert.match(text, /v40 之前/, 'unknown origin is shown, not dropped');
  assert.doesNotMatch(text, /MycoX/, 'a KNOWN foreign origin is still excluded');
});

test('lastMessageAtForOrigin answers by conversation, and counts origin-less rows as ours', () => {
  const { db } = seed();
  assert.ok((db.raw.lastMessageAtForOrigin(WECHAT, 'assistant') ?? 0) > 0);
  // The 56-year bug: asking by session_id found nothing at all.
  assert.equal(db.raw.lastMessageAt(WECHAT, 'assistant'), null, 'session_id cannot answer this question');
});

test('origins are named in words the model can act on', () => {
  assert.equal(describeSessionOrigin('wechat:x:y'), 'WeChat');
  assert.equal(describeSessionOrigin('system:scheduled:mycox-checkin'), 'scheduled task mycox-checkin');
  assert.equal(describeSessionOrigin('abc123'), 'the web UI');
});

test('the bucket itself still answers by session_id, for callers that mean the bucket', () => {
  const { db } = seed();
  assert.ok((db.raw.lastMessageAt(BUCKET) ?? 0) > 0);
  assert.equal(db.raw.lastMessageAt('no-such-session'), null);
});
