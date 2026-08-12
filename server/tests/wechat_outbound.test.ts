/**
 * WeChat 出向消息层单元测试。
 *
 * 时钟注入 + mock sender,完全确定性,不需要外网或真 setTimeout。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OutboundQueue,
  chunkMarkdown,
  fingerprint,
  sanitizeForWechat,
  TEXT_CHUNK_LIMIT,
  type RawSender,
  type OutboundClock,
} from '../src/channels/wechat/outbound.js';

/** 可前进的虚拟时钟,sleep 不真等 */
function makeFakeClock(): OutboundClock & { advance(ms: number): void; getTime(): number } {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    getTime: () => t,
  };
}

/** mock sender:记录每次调用,返回 ok */
function makeMockSender(): RawSender & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  const fn: any = async (to: string, text: string) => {
    calls.push([to, text]);
    return { ok: true, messageId: `msg-${calls.length}` };
  };
  fn.calls = calls;
  return fn;
}

// ── chunkMarkdown 纯函数 ────────────────────────────────────────────

test('chunkMarkdown: 文本 ≤ limit 单 chunk 直接返回', () => {
  assert.deepEqual(chunkMarkdown('hello', 4000), ['hello']);
  assert.deepEqual(chunkMarkdown('a'.repeat(4000), 4000), ['a'.repeat(4000)]);
});

test('chunkMarkdown: 空文本返回 []', () => {
  assert.deepEqual(chunkMarkdown('', 4000), []);
});

test('chunkMarkdown: 段落边界(\\n\\n)优先切', () => {
  const text = 'A'.repeat(60) + '\n\n' + 'B'.repeat(60);
  const chunks = chunkMarkdown(text, 80);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('\n\n'));
  assert.equal(chunks[0].length, 62); // 60 As + \n\n
  assert.equal(chunks[1].length, 60);
});

test('chunkMarkdown: 没段落用单换行切', () => {
  const text = 'A'.repeat(60) + '\n' + 'B'.repeat(60);
  const chunks = chunkMarkdown(text, 80);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('\n'));
});

test('chunkMarkdown: 没换行用句末切(中文)', () => {
  const text = '一'.repeat(60) + '。' + '二'.repeat(60);
  const chunks = chunkMarkdown(text, 80);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].endsWith('。'));
});

test('chunkMarkdown: 兜底硬切', () => {
  // 全是无空格无标点字符
  const text = 'x'.repeat(200);
  const chunks = chunkMarkdown(text, 80);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 80);
  assert.equal(chunks.join(''), text);
});

test('chunkMarkdown: 多块 join 还原原文(无丢字)', () => {
  const text =
    'Title\n\n' +
    'Para1 with words. '.repeat(50) +
    '\n\n' +
    'Para2 中文段落,标点逗号、句号。'.repeat(30);
  const chunks = chunkMarkdown(text, 200);
  assert.equal(chunks.join(''), text);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too big: ${c.length}`);
});

test('chunkMarkdown: limit 必须 > 0', () => {
  assert.throws(() => chunkMarkdown('a', 0), /limit must be/);
  assert.throws(() => chunkMarkdown('a', -1), /limit must be/);
});

// ── fingerprint ────────────────────────────────────────────

test('fingerprint: 同 to + 同 text 一致;to 或 text 不同则不同', () => {
  const a = fingerprint('user1', 'hello');
  const b = fingerprint('user1', 'hello');
  const c = fingerprint('user2', 'hello');
  const d = fingerprint('user1', 'hello!');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.equal(a.length, 16);
});

// ── OutboundQueue ────────────────────────────────────────────

test('OutboundQueue: 单条短消息直接发 1 chunk', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock });

  const r = await q.sendText('alice', 'hi');
  assert.equal(r.chunksSent, 1);
  assert.equal(r.chunksDeduped, 0);
  assert.deepEqual(sender.calls, [['alice', 'hi']]);
});

test('OutboundQueue: 长消息自动分块', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { chunkLimit: 100, clock });

  const long = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50) + '\n\n' + 'C'.repeat(50);
  const r = await q.sendText('alice', long);
  assert.ok(r.chunksSent >= 2);
  // 重组应该等于原文
  assert.equal(sender.calls.map((c) => c[1]).join(''), long);
});

test('OutboundQueue: chunk 间限速(模拟 0.3s 间隔)', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { chunkLimit: 10, chunkDelayMs: 300, clock });

  const t0 = clock.getTime();
  await q.sendText('alice', 'aaaaaaaaaa\n\nbbbbbbbbbb\n\ncccccccccc');
  // 第 1 chunk 立即,第 2/3 chunk 各等 300ms → 累计 ≥ 600ms
  const elapsed = clock.getTime() - t0;
  assert.ok(elapsed >= 600, `expected >= 600ms, got ${elapsed}`);
});

test('OutboundQueue: 5 分钟内同 to + 同 text 去重', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock, dedupWindowMs: 300_000 });

  const r1 = await q.sendText('alice', 'duplicate me');
  assert.equal(r1.chunksSent, 1);

  // 立刻再发同样
  const r2 = await q.sendText('alice', 'duplicate me');
  assert.equal(r2.chunksSent, 0);
  assert.equal(r2.chunksDeduped, 1);
  // sender 应该只被调一次
  assert.equal(sender.calls.length, 1);
});

test('OutboundQueue: 5 分钟后同消息可以再发', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock, dedupWindowMs: 300_000 });

  await q.sendText('alice', 'echo');
  clock.advance(310_000); // 5min + 10s
  const r = await q.sendText('alice', 'echo');
  assert.equal(r.chunksSent, 1);
  assert.equal(sender.calls.length, 2);
});

test('OutboundQueue: 不同 to 不互相去重', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock });

  await q.sendText('alice', 'msg');
  await q.sendText('bob', 'msg');
  assert.equal(sender.calls.length, 2);
});

test('OutboundQueue: 空文本 / null 静默跳过', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock });

  const r1 = await q.sendText('alice', '');
  assert.equal(r1.chunksSent, 0);
  const r2 = await q.sendText('alice', null as any);
  assert.equal(r2.chunksSent, 0);
  assert.equal(sender.calls.length, 0);
});

test('OutboundQueue: 去重表 GC,过期 fingerprint 被清理', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock, dedupWindowMs: 60_000 });

  await q.sendText('alice', 'm1');
  await q.sendText('alice', 'm2');
  assert.equal(q.dedupSize, 2);

  clock.advance(90_000); // 60s + 30s
  await q.sendText('alice', 'm3'); // 触发 gc
  // 之前两条已过期,只剩 m3
  assert.equal(q.dedupSize, 1);
});

test('TEXT_CHUNK_LIMIT 默认是 4000', () => {
  assert.equal(TEXT_CHUNK_LIMIT, 4000);
});

// ── sanitizeForWechat ──────────────────────────────────

test('sanitizeForWechat 把 ↵ 还原成真换行', () => {
  assert.equal(sanitizeForWechat('a↵b↵c'), 'a\nb\nc');
});

test('sanitizeForWechat 删除 ASCII 控制字符', () => {
  // BEL \x07, VT \x0B, ESC \x1B, DEL \x7F
  const dirty = 'hello\x07wor\x0Bld\x1Bend\x7F!';
  assert.equal(sanitizeForWechat(dirty), 'helloworldend!');
});

test('sanitizeForWechat 保留合法 \\t / \\n / \\r', () => {
  const ok = 'a\tb\nc\rd';
  assert.equal(sanitizeForWechat(ok), ok);
});

test('sanitizeForWechat 把 U+FFFD 替换为 ?', () => {
  assert.equal(sanitizeForWechat('a�b��c'), 'a?b??c');
});

test('sanitizeForWechat 不影响 emoji / CJK / 全角', () => {
  const ok = '中文 ✅ ｱｲｳ 😊 嗨～';
  assert.equal(sanitizeForWechat(ok), ok);
});

test('sanitizeForWechat 处理空 / 未定义输入', () => {
  assert.equal(sanitizeForWechat(''), '');
  assert.equal(sanitizeForWechat(null as unknown as string), '');
  assert.equal(sanitizeForWechat(undefined as unknown as string), '');
});

test('OutboundQueue.sendText 出向前会清洗 ↵ 和 U+FFFD', async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const sender: RawSender = async (to, text) => {
    sent.push({ to, text });
    return { ok: true, messageId: 'mid-' + sent.length };
  };
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock, chunkDelayMs: 0 });

  await q.sendText('alice', 'line1↵line2 ��� end');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'line1\nline2 ??? end');
});

// ── mergeChunks + quota-failure remainder (2026-07-09 ret=-2 lost chunk 7) ───

test('mergeChunks: 相邻小块合并到不超过 char/byte 限', async () => {
  const { mergeChunks } = await import('../src/channels/wechat/outbound.js');
  // 5 small paragraphs, char limit 100 → should merge greedily
  const chunks = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30), 'd'.repeat(30), 'e'.repeat(30)];
  const merged = mergeChunks(chunks, 4000, 100);
  assert.equal(merged.join(''), chunks.join(''), 'no content lost');
  assert.equal(merged.length, 2, '30×3=90 fits in 100; 4th starts a new chunk');
  // byte limit dominates for CJK: 40 chars = 120 bytes each, byteLimit 200 → pairs of 1 (40*2=240>200)
  const cjk = ['中'.repeat(40), '文'.repeat(40), '字'.repeat(40)];
  const mergedCjk = mergeChunks(cjk, 200, 4000);
  assert.equal(mergedCjk.length, 3, 'byte limit prevents merging');
  assert.equal(mergeChunks([], 4000, 100).length, 0);
});

test('OutboundQueue: 长报告经 merge 后 chunk 数减少(同内容更少配额)', async () => {
  const sender = makeMockSender();
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { chunkLimit: 100, chunkDelayMs: 0, clock });
  // many small paragraphs — the old splitter would send one per paragraph boundary
  const text = Array.from({ length: 8 }, (_, i) => `para${i} ` + 'x'.repeat(20)).join('\n\n');
  const r = await q.sendText('alice', text);
  assert.equal(sender.calls.map((c) => c[1]).join(''), text, 'content intact');
  assert.ok(r.chunksSent <= 3, `expected merged chunks, got ${r.chunksSent}`);
});

test('OutboundQueue: 发送失败即中止,remainder 带回未发尾巴', async () => {
  // sender fails from the 2nd call on (simulates WeChat per-inbound-message quota ret=-2)
  let calls = 0;
  const sent: string[] = [];
  const sender: RawSender = async (_to, text) => {
    calls++;
    if (calls >= 2) return { ok: false };
    sent.push(text);
    return { ok: true, messageId: `m${calls}` };
  };
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { chunkLimit: 50, chunkDelayMs: 0, clock });
  const text = 'A'.repeat(40) + '\n\n' + 'B'.repeat(40) + '\n\n' + 'C'.repeat(40);
  const r = await q.sendText('alice', text);
  assert.equal(r.chunksSent, 1);
  assert.ok(r.chunksFailed >= 1);
  assert.ok(r.remainder, 'unsent tail must be reported');
  assert.equal(sent.join('') + r.remainder, text, 'sent + remainder reassembles the full text');
  assert.equal(calls, 2, 'must stop after the first failure, not burn quota on the rest');
});

test('OutboundQueue: 失败的 chunk 不进去重窗口,稍后重发不会被 dedup 吞掉', async () => {
  let failNext = true;
  const sent: string[] = [];
  const sender: RawSender = async (_to, text) => {
    if (failNext) { failNext = false; return { ok: false }; }
    sent.push(text);
    return { ok: true, messageId: 'm' };
  };
  const clock = makeFakeClock();
  const q = new OutboundQueue(sender, { clock, chunkDelayMs: 0 });
  const r1 = await q.sendText('alice', 'important tail');
  assert.equal(r1.chunksSent, 0);
  assert.equal(r1.remainder, 'important tail');
  // immediate retry (same content, well inside the 5-min window) must NOT be deduped
  const r2 = await q.sendText('alice', 'important tail');
  assert.equal(r2.chunksSent, 1);
  assert.equal(sent[0], 'important tail');
});

test('OutboundQueue: ret=-2 metadata reaches the push dispatcher as next-inbound deferral', async () => {
  const sender: RawSender = async () => ({ ok: false, retry: 'next_inbound', code: -2 });
  const q = new OutboundQueue(sender);
  const r = await q.sendText('owner', 'daily health report');
  assert.equal(r.retry, 'next_inbound');
  assert.equal(r.code, -2);
  assert.equal(r.remainder, 'daily health report');
  assert.equal(r.chunksSent, 0);
});
