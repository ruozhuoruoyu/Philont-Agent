/**
 * gateway 长轮询循环单元测试。fetch + sleep 注入。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ILinkClient, type FetchLike } from '../src/channels/wechat/client.js';
import {
  ILinkGateway,
  type InboundEvent,
  RETRY_DELAY_MS,
  BACKOFF_DELAY_MS,
  SESSION_EXPIRED_PAUSE_MS,
  RATE_LIMIT_BASE_MS,
  redactWeChatInboundForLog,
} from '../src/channels/wechat/gateway.js';
import type { WeChatCredentials } from '../src/channels/wechat/state.js';
import { DEFAULT_POLICY } from '../src/channels/wechat/policy.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'philont-gw-test-'));
  process.env.PHILONT_WECHAT_ROOT = tmpRoot;
});
afterEach(() => {
  delete process.env.PHILONT_WECHAT_ROOT;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeCreds(): WeChatCredentials {
  return {
    accountId: 'gwtest',
    token: 'tok',
    baseUrl: 'https://ilink.test',
    cdnBaseUrl: 'https://cdn.test',
    createdAt: Date.now(),
  };
}

test('raw inbound logging redacts tokens and pseudonymizes identifiers', () => {
  const safe = redactWeChatInboundForLog({
    message_id: '7491988958783429000',
    from_user_id: 'private-user@im.wechat',
    to_user_id: 'private-bot@im.bot',
    client_id: 'private-client',
    context_token: 'secret-context-token',
    item_list: [],
  } as any);
  assert.equal(safe.context_token, '[REDACTED]');
  assert.equal(safe.client_id, '[REDACTED]');
  assert.match(String(safe.from_user_id), /^sha256:/);
  assert.doesNotMatch(JSON.stringify(safe), /private-user|secret-context-token|7491988958783429000/);
  assert.equal('item_list' in safe, false);
});

/**
 * 受控 mock fetch:每个请求 lookup queue;支持把 stop 信号塞进序列(返回 null body)。
 * 当 queue 空时,**不抛错**而是返回一个永挂的 promise(等价于 long-poll 真挂着),
 * 这样调用 stop() 后 loop 才会走 stopRequested 路径退出。
 */
function makeQueuedFetch(responses: Array<any>): FetchLike & { calls: any[] } {
  const queue = [...responses];
  const calls: any[] = [];
  const fn: FetchLike = (url, init) => {
    calls.push({ url, body: init.body });
    const isSend = url.endsWith('/ilink/bot/sendmessage');
    const matchingIndex = queue.findIndex((candidate) =>
      isSend
        ? candidate && 'message_id' in candidate && !('msgs' in candidate) && !('get_updates_buf' in candidate)
        : !(candidate && 'message_id' in candidate && !('msgs' in candidate) && !('get_updates_buf' in candidate)),
    );
    const next = matchingIndex >= 0 ? queue.splice(matchingIndex, 1)[0] : undefined;
    if (next) {
      return Promise.resolve(
        new Response(JSON.stringify(next), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    // queue 空 → 模拟长 poll 永挂;响应 AbortSignal,被 abort 时 reject
    return new Promise<Response>((_, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    });
  };
  (fn as any).calls = calls;
  return fn as any;
}

/** "假 sleep":不真等,但让出一次 macrotask,允许 setTimeout 轮询和 stop 信号有机会触达 */
const noSleep = (_ms: number) => new Promise<void>((r) => setImmediate(r));

test('gateway: 收到一条 DM → dispatch 被调,reply 自动回发', async () => {
  // open 策略允许任何 DM
  const fetch = makeQueuedFetch([
    {
      ret: 0,
      get_updates_buf: 'cursor1',
      msgs: [
        {
          message_id: 'm1',
          from_user_id: 'alice',
          item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
          context_token: 'ctx-1',
          // This is the field present in production inbound-raw logs. Keep the legacy
          // send_time fallback covered by the ordering test below.
          create_time_ms: 1_787_268_800_123,
        },
      ],
    },
    // 回发 sendmessage
    { ret: 0, message_id: 'reply-1' },
    // 之后 long-poll 永挂
  ]);
  const client = new ILinkClient({ baseUrl: 'https://ilink.test', token: 'tok', fetch });
  const captured: InboundEvent[] = [];
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    policy: { ...DEFAULT_POLICY, dmPolicy: 'open' },
    sleep: noSleep,
    logger: silentLogger,
    skipLock: true,
    dispatch: async (e) => {
      captured.push(e);
      return `echo: ${e.text}`;
    },
  });

  const startPromise = gw.start().catch(() => {});
  // 给 microtask 跑两次 fetch + dispatch
  await waitUntil(() => captured.length >= 1 && (fetch as any).calls.some((c: any) => c.url.endsWith('/ilink/bot/sendmessage')));
  await gw.stop();
  await startPromise;

  assert.equal(captured.length, 1);
  assert.equal(captured[0].fromUserId, 'alice');
  assert.equal(captured[0].text, 'hi bot');
  assert.equal(captured[0].contextToken, 'ctx-1');
  assert.equal(captured[0].sentAtMs, 1_787_268_800_123);

  // 检查回发请求:第二个 call 应该是 sendmessage
  const sendCall = (fetch as any).calls.find((c: any) => c.url.endsWith('/ilink/bot/sendmessage'));
  const sendBody = JSON.parse(sendCall.body);
  assert.ok(sendCall.url.endsWith('/ilink/bot/sendmessage'));
  assert.equal(sendBody.msg.to_user_id, 'alice');
  assert.equal(sendBody.msg.item_list[0].text_item.text, 'echo: hi bot');
  assert.equal(sendBody.msg.context_token, 'ctx-1');
});

test('gateway: a long dispatch does not block polling; one peer still dispatches in order', async () => {
  let pollCount = 0;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const seen: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (!url.endsWith('/ilink/bot/getupdates')) throw new Error(`unexpected ${url}`);
    pollCount++;
    if (pollCount === 1) {
      return new Response(JSON.stringify({
        ret: 0, get_updates_buf: 'c1', msgs: [{
          message_id: 'm1', from_user_id: 'alice', send_time: 100,
          item_list: [{ type: 1, text_item: { text: 'first' } }],
        }],
      }));
    }
    if (pollCount === 2) {
      return new Response(JSON.stringify({
        ret: 0, get_updates_buf: 'c2', msgs: [{
          message_id: 'm2', from_user_id: 'alice', send_time: 101,
          item_list: [{ type: 1, text_item: { text: 'second' } }],
        }],
      }));
    }
    return new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client: new ILinkClient({ token: 'tok', fetch }),
    policy: { ...DEFAULT_POLICY, dmPolicy: 'open' },
    logger: silentLogger,
    skipLock: true,
    dispatch: async (event) => {
      seen.push(`start:${event.text}`);
      if (event.text === 'first') await firstBlocked;
      seen.push(`done:${event.text}`);
    },
  });

  const running = gw.start().catch(() => {});
  await waitUntil(() => pollCount >= 3);
  assert.deepEqual(seen, ['start:first'], 'second poll arrived, but same-peer dispatch stayed serial');
  const { readContextTokens } = await import('../src/channels/wechat/state.js');
  assert.equal(
    (readContextTokens('gwtest') as { get_updates_buf?: string } | null)?.get_updates_buf,
    undefined,
    'queued messages are not durably acknowledged before dispatch finishes',
  );
  releaseFirst();
  await waitUntil(() => seen.includes('done:second'));
  await gw.stop();
  await running;
  assert.deepEqual(seen, ['start:first', 'done:first', 'start:second', 'done:second']);
  assert.equal(
    (readContextTokens('gwtest') as { get_updates_buf?: string })?.get_updates_buf,
    'c2',
    'the low-water cursor advances after both ordered dispatches complete',
  );
});

test('gateway: a message completed before a cursor failure/restart is not dispatched twice', async () => {
  let handled = 0;
  const runOnce = async (cursor: string) => {
    let polls = 0;
    const fetch: FetchLike = async (url, init) => {
      if (!url.endsWith('/ilink/bot/getupdates')) throw new Error(`unexpected ${url}`);
      polls++;
      if (polls === 1) {
        return new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: cursor,
          msgs: [{
            message_id: 'durable-m1', from_user_id: 'alice', create_time_ms: 1_787_268_800_123,
            item_list: [{ type: 1, text_item: { text: 'do-once' } }],
          }],
        }));
      }
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    };
    const gw = new ILinkGateway({
      credentials: makeCreds(),
      client: new ILinkClient({ token: 'tok', fetch }),
      policy: { ...DEFAULT_POLICY, dmPolicy: 'open' },
      logger: silentLogger,
      skipLock: true,
      dispatch: async () => { handled++; },
    });
    const running = gw.start().catch(() => {});
    await waitUntil(() => polls >= 2);
    await gw.stop();
    await running;
  };

  await runOnce('dedup-c1');
  await runOnce('dedup-c2');
  assert.equal(handled, 1, 'the durable message-id window suppresses replay after restart');
  const { readContextTokens } = await import('../src/channels/wechat/state.js');
  const stored = readContextTokens('gwtest') as { processed_message_ids?: string[] };
  assert.deepEqual(stored.processed_message_ids, ['durable-m1']);
});

test('gateway: 群消息 + DEFAULT_POLICY(group disabled)→ 静默丢弃,不回发', async () => {
  const fetch = makeQueuedFetch([
    {
      ret: 0,
      get_updates_buf: 'c',
      msgs: [
        {
          message_id: 'm',
          from_user_id: 'someone',
          room_id: 'g1',
          item_list: [{ type: 1, text_item: { text: 'group msg' } }],
        },
      ],
    },
  ]);
  const client = new ILinkClient({ token: 'tok', fetch });
  let dispatchCalled = false;
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    sleep: noSleep,
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {
      dispatchCalled = true;
    },
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => (fetch as any).calls.length >= 1);
  await gw.stop();
  await sp;

  assert.equal(dispatchCalled, false, 'group disabled 应阻止 dispatch');
  assert.equal((fetch as any).calls.length, 1, '应只有 getupdates,没有 sendmessage');
});

test('gateway: DM 拒绝 → 自动回 blockedReplyTemplate', async () => {
  const fetch = makeQueuedFetch([
    {
      ret: 0,
      get_updates_buf: 'c',
      msgs: [
        {
          message_id: 'm',
          from_user_id: 'mallory',
          item_list: [{ type: 1, text_item: { text: 'hi' } }],
        },
      ],
    },
    { ret: 0, message_id: 'r' },
  ]);
  const client = new ILinkClient({ token: 'tok', fetch });
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    policy: { dmPolicy: 'allowlist', groupPolicy: 'disabled', allowedUsers: ['alice'], allowedGroups: [] },
    blockedReplyTemplate: '🚫 你不在白名单',
    sleep: noSleep,
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {
      throw new Error('should not dispatch');
    },
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => (fetch as any).calls.some((c: any) => c.url.endsWith('/ilink/bot/sendmessage')));
  await gw.stop();
  await sp;

  const sendCall = (fetch as any).calls.find((c: any) => c.url.endsWith('/ilink/bot/sendmessage'));
  const sendBody = JSON.parse(sendCall.body);
  assert.equal(sendBody.msg.item_list[0].text_item.text, '🚫 你不在白名单');
  assert.equal(sendBody.msg.to_user_id, 'mallory');
});

test('gateway: ret=-14 → sleep SESSION_EXPIRED_PAUSE_MS 然后继续', async () => {
  const fetch = makeQueuedFetch([{ ret: -14, errmsg: 'session expired' }]);
  const client = new ILinkClient({ token: 'tok', fetch });
  const sleeps: number[] = [];
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((r) => setImmediate(r));
    },
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {},
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => sleeps.length >= 1);
  await gw.stop();
  await sp;

  assert.equal(sleeps[0], SESSION_EXPIRED_PAUSE_MS);
});

test('gateway: ret=-2 → 指数退避(基础 5s,下次 ×3)', async () => {
  const fetch = makeQueuedFetch([
    { ret: -2 },
    { ret: -2 },
  ]);
  const client = new ILinkClient({ token: 'tok', fetch });
  const sleeps: number[] = [];
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((r) => setImmediate(r));
    },
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {},
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => sleeps.length >= 2);
  await gw.stop();
  await sp;

  assert.equal(sleeps[0], RATE_LIMIT_BASE_MS);
  assert.equal(sleeps[1], RATE_LIMIT_BASE_MS * 3);
});

test('gateway: 网络错误 → consecutiveFailures 累积,5 次后 BACKOFF_DELAY_MS', async () => {
  // 用一个抛错 fetch
  const calls = { n: 0 };
  const fetch: FetchLike = async () => {
    calls.n++;
    throw new Error('network down');
  };
  const client = new ILinkClient({ token: 'tok', fetch });
  const sleeps: number[] = [];
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise<void>((r) => setImmediate(r));
    },
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {},
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => sleeps.length >= 6);
  await gw.stop();
  await sp;

  // 前 4 次 = RETRY_DELAY,第 5 起 = BACKOFF
  assert.equal(sleeps[0], RETRY_DELAY_MS);
  assert.equal(sleeps[3], RETRY_DELAY_MS);
  assert.equal(sleeps[4], BACKOFF_DELAY_MS);
});

test('gateway: 成功 getupdates 后 cursor 落盘', async () => {
  const fetch = makeQueuedFetch([
    { ret: 0, get_updates_buf: 'cur-aaa', msgs: [] },
  ]);
  const client = new ILinkClient({ token: 'tok', fetch });
  const gw = new ILinkGateway({
    credentials: makeCreds(),
    client,
    sleep: noSleep,
    logger: silentLogger,
    skipLock: true,
    dispatch: async () => {},
  });

  const sp = gw.start().catch(() => {});
  await waitUntil(() => (fetch as any).calls.length >= 1);
  // 给一点时间让 writeContextTokens 落盘
  await new Promise((r) => setTimeout(r, 10));
  await gw.stop();
  await sp;

  const { readContextTokens } = await import('../src/channels/wechat/state.js');
  const stored = readContextTokens('gwtest') as { get_updates_buf?: string };
  assert.equal(stored?.get_updates_buf, 'cur-aaa');
});

/** 轮询 + 短超时,防 microtask race 让 setTimeout 落空 */
async function waitUntil(check: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timeout');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('group identifiers are pseudonymized too, not just the DM fields', () => {
  const safe = redactWeChatInboundForLog({
    message_id: '7491988958783429000',
    from_user_id: 'private-user@im.wechat',
    room_id: 'R-1234567890@chatroom',
    chat_room_id: 'R-1234567890@chatroom',
    group_id: '',
    session_id: 'S-abc',
    context_token: 'secret-context-token',
    item_list: [],
  } as any);
  assert.match(String(safe.room_id), /^sha256:/);
  assert.match(String(safe.chat_room_id), /^sha256:/);
  assert.doesNotMatch(JSON.stringify(safe), /R-1234567890|S-abc/);
  // Every field inboundGroupId() can read must be covered — that split is the whole defect.
  assert.equal(safe.group_id, undefined);
});
