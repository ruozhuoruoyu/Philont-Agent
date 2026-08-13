/**
 * WeChat channel server mount entry point
 *
 * Responsibilities:
 *   - On startup: load credentials → start ILinkClient + OutboundQueue + ILinkGateway
 *   - Bridge: gateway receives inbound text → build stable sessionId → call handleChatSend
 *   - Outbound: onDelta buffers all chunks; on final flush, calls OutboundQueue.sendText
 *     (WeChat does not support streaming; 0.3s rate-limit + 4000-char chunking handled by OutboundQueue)
 *   - Auth: onAuthRequest → forward the "🔐 …" message directly to WeChat. pendingAuth is
 *     maintained by chat-handler per sessionId; user's next "agree/yes" is recognised as a reply
 *
 * sessionId convention:
 *   `wechat:<accountId>:<userId>` (DM)
 *   `wechat:<accountId>:group:<groupId>:<userId>` (group)
 *
 * Enable:
 *   WECHAT_ENABLED=1 npm run dev
 *   (optionally set WECHAT_ACCOUNT_ID; otherwise resolveDefaultAccountId is used)
 */

import {
  readCredentials,
  readPeerToken,
  resolveDefaultAccountId,
  type WeChatCredentials,
} from './state.js';
import { ILinkClient } from './client.js';
import {
  ILinkGateway, superviseGatewayStart,
  pseudonymizeWeChatId,
  type InboundEvent,
  type GatewayLogger,
} from './gateway.js';
import {
  OutboundQueue,
  type RawSender,
} from './outbound.js';
import {
  policyFromEnv,
  type PolicyConfig,
} from './policy.js';
import {
  registerMediaChannel,
  unregisterMediaChannel,
} from '../registry.js';
import { createWeChatMediaChannel } from './media_channel.js';
import {
  registerPushChannel,
  unregisterPushChannel,
  type PushChannel,
} from '../../push/channel.js';
import { recordAttachment } from '../recent_attachments.js';
import { extractUserSection, recordFilterCall } from '../../output_section_filter.js';
import { runConscienceGate } from '../../conscience_gate.js';
import { recordControllerFire } from '../../controller_registry.js';
import { renderForWeChat, renderAuthPromptForWeChat } from './wechat_render.js';
import { explainSuspension } from '../../suspend_detector.js';
import { currentPhraseLang } from '../../response_language.js';

/** AuthRequest structure from chat-handler (provided by handleChatSend) */
export type AuthRequestPayload = {
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
};

/** Injected handleChatSend from chat-handler; avoids hard-dependency import cycles */
export type ChatSendFn = (
  sessionId: string,
  userMessage: string,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequestPayload) => void,
  onStatus?: (text: string) => void,
  /**
   * 2026-05-19 three-stream separation: Tier 3/4 detail event callback (optional).
   * WeChat does **not** pass this — it naturally filters out tool details / internal markers.
   * Only web-ui consumes it.
   */
  onTrace?: (ev: unknown) => void,
) => Promise<unknown>;

export interface MountOptions {
  /** Required: server's own handleChatSend (import { handleChatSend } then pass here) */
  chatSend: ChatSendFn;
  /** Explicit accountId; if not provided, resolveDefaultAccountId is used */
  accountId?: string;
  /** Explicit policy; if not provided, policyFromEnv is used */
  policy?: PolicyConfig;
  logger?: GatewayLogger;
  deferredPushes?: {
    pruneExpired(now?: number): number;
    listPending(channel: string, peer: string, limit?: number, now?: number): Array<{ id: string; kind: string; text: string }>;
    markManyDelivered(ids: readonly string[]): number;
  };
}

/**
 * Start the WeChat gateway. Returns the ILinkGateway instance; caller can call stop() to shut down.
 *
 * Non-blocking: `await startWeChatGateway` returns immediately.
 * The gateway starts its loop in the background via setImmediate; the server main flow continues.
 */
export async function startWeChatGateway(opts: MountOptions): Promise<ILinkGateway> {
  const accountId = opts.accountId ?? resolveDefaultAccountId();
  if (!accountId) {
    throw new Error(
      'wechat: 没找到可用 accountId。请先跑 `npm run wechat:login` 扫码登录,' +
        '或显式设置 WECHAT_ACCOUNT_ID。',
    );
  }

  const creds = readCredentials(accountId);
  if (!creds) {
    throw new Error(`wechat: accountId=${accountId} 凭证不存在(应在 ~/.philont/wechat/accounts/${accountId}/credentials.json)`);
  }

  const policy = opts.policy ?? policyFromEnv();
  const logger = opts.logger ?? defaultLogger();

  const client = new ILinkClient({ baseUrl: creds.baseUrl, token: creds.token });
  // Outbound RawSender: bridges OutboundQueue's (to, text) calls to client.sendText
  //
  // **Hard timeout 25s**: even though client.sendText has a 30s internal default, an extra
  // Promise.race layer guards against cases where the underlying transport (undici connection
  // pool contention / iLink server long enqueue) bypasses the inner timer. A sendmessage hang
  // of 5+ minutes requiring ctrl+C to unblock was observed; this is the safety net.
  // **Log visibility**: log before and after sending so that even if it hangs, the log shows
  // exactly which step it is stuck at.
  const SEND_HARD_TIMEOUT_MS = 25_000;
  const rawSender: RawSender = async (to, text) => {
    const startedAt = Date.now();
    const safeTo = pseudonymizeWeChatId(to);
    logger.info('outbound sender starting', { to: safeTo, len: text.length });
    // The push path's missing half (reference: hermes weixin.py — every outbound must echo the peer's
    // latest context_token, from a disk cache updated on inbound). Twelve hours of production drew the
    // line precisely: replies (which echo the inbound token) worked the whole time; tokenless pushes
    // failed ret=-2 "prepare failed" at +8s, +20min and +40min. Same session, same client — the only
    // difference between the working path and the dead one was this field.
    //
    // Hermes' fallback runs the other direction too: a send that fails WITH a token retries once
    // without, so a stale cached token can never make pushes strictly worse than the old behaviour.
    const attempt = async (contextToken: string | null) => {
      const r = await Promise.race([
        contextToken ? client.sendText(to, text, { contextToken }) : client.sendText(to, text),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`outbound hard timeout after ${SEND_HARD_TIMEOUT_MS}ms`)),
            SEND_HARD_TIMEOUT_MS,
          ),
        ),
      ]);
      return r;
    };
    try {
      const cachedToken = readPeerToken(creds.accountId, to);
      let r = await attempt(cachedToken);
      if (r.ret !== 0 && cachedToken) {
        logger.warn(`sendText with cached token ret=${r.ret} — retrying tokenless`, { to: safeTo });
        r = await attempt(null);
      }
      const dur = Date.now() - startedAt;
      if (r.ret === 0) {
        logger.info('outbound sender ok', { to: safeTo, durationMs: dur, messageId: pseudonymizeWeChatId(r.message_id) });
        return { ok: true, messageId: r.message_id };
      }
      // -14 token expired: not handled here; the gateway's long-poll will also catch it
      logger.warn(`sendText ret=${r.ret} errmsg=${r.errmsg ?? ''}`, { to: safeTo, durationMs: dur });
      return { ok: false, ...(r.ret === -2 ? { retry: 'next_inbound' as const } : {}), code: r.ret };
    } catch (e) {
      const dur = Date.now() - startedAt;
      logger.error(`sendText threw: ${String(e)}`, { to: safeTo, durationMs: dur });
      return { ok: false };
    }
  };
  const outbound = new OutboundQueue(rawSender);

  const dispatch = makeDispatcher({
    accountId: creds.accountId,
    chatSend: opts.chatSend,
    outbound,
    logger,
    deferredPushes: opts.deferredPushes,
  });

  const gw = new ILinkGateway({
    credentials: creds,
    client,
    policy,
    logger,
    dispatch,
    // Cross-channel "recently uploaded" tracking: record each successfully saved inbound
    // attachment to the singleton immediately. chat-handler reads it at the top of the
    // next-turn prefix so the LLM does not need to glob the disk for files.
    onAttachment: (att) => {
      recordAttachment({
        channel: `wechat:${creds.accountId}`,
        kind: att.kind,
        filename: att.filename,
        path: att.path,
        fromUser: att.fromUser,
        ts: Date.now(),
      });
    },
  });

  // Register with the cross-channel media registry — from this point on, any replyWithMedia
  // tool call whose sessionId starts with `wechat:<accountId>:` will be routed here.
  // In multi-account scenarios, each account registers its own instance (channelName includes accountId).
  const mediaChannel = createWeChatMediaChannel({ accountId, client });
  registerMediaChannel(mediaChannel);
  logger.info('wechat media channel registered', { name: mediaChannel.name });

  // 2026-05-06 phase C: wrap OutboundQueue.sendText as a PushChannel and register it.
  // PushDispatcher uses the channel name (`wechat:<accountId>`) to find this instance
  // during fan-out pushes and calls pushText(peer, text). peer = wechat userId (DM) or
  // `group:<groupId>` (group).
  const pushChannelName = `wechat:${creds.accountId}`;
  const pushChannel: PushChannel = {
    name: pushChannelName,
    // Real long-poll health (prod 2026-07-08: this was hardcoded true, so pushes were attempted
    // into a dead connection during network flaps). Not-ready => dispatcher skips with
    // channel_not_ready and the finding still reaches the user via next-turn injection.
    isReady: () => gw.isHealthy(),
    async pushText(peer, text) {
      try {
        const r = await outbound.sendText(peer, text);
        return {
          ok: r.chunksSent > 0 && r.chunksFailed === 0 && r.remainder === null,
          messageIds: r.messageIds,
          retry: r.retry,
          code: r.code,
          deferredText: r.remainder ?? undefined,
          partiallyDelivered: r.chunksSent > 0 && (r.chunksFailed > 0 || r.remainder !== null),
          ...(r.chunksFailed > 0 || r.chunksSent === 0 ? { error: 'one or more chunks failed' } : {}),
        };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  };
  registerPushChannel(pushChannel);
  logger.info('wechat push channel registered', { name: pushChannelName });

  // Start loop in background; does not block server startup. Supervised: if the single-instance
  // lock is held by a live process (owner restarted while the old process lingered — production
  // 2026-07-24 20:47), keep retrying until the old instance exits and take over, instead of giving
  // up forever on the first refusal.
  let shuttingDown = false;
  let lastStartError = '';
  void superviseGatewayStart(() => gw.start(), {
    shouldStop: () => shuttingDown,
    onBlocked: (e) => {
      lastStartError = e.message;
      logger.warn(
        `gateway lock held by pid=${e.holder.pid} — WeChat stays with the OLD process; ` +
          `will take over within 30s of it exiting`,
        { accountId },
      );
    },
    onCrash: (e) => {
      lastStartError = String(e);
      logger.error(`gateway crashed: ${lastStartError}`, { accountId });
    },
  });

  // Watched success line: the boot banner prints "gateway scheduled" before start() has actually run,
  // and on 2026-07-24 it printed a green checkmark seconds after the gateway had already crashed on the
  // lock. Ten seconds in, say which world we are in — a claim of health must consult the thing itself.
  const healthProbe = setTimeout(() => {
    if (!gw.isHealthy()) {
      logger.error(
        `gateway NOT polling 10s after scheduling${lastStartError ? ` — ${lastStartError}` : ''} ` +
          `(inbound WeChat messages are not being received by this process)`,
        { accountId },
      );
    }
  }, 10_000);
  healthProbe.unref?.();

  // Graceful shutdown: bind once to SIGINT/SIGTERM to call stop() and deregister channels
  const stopOnSignal = () => {
    shuttingDown = true;
    unregisterMediaChannel(mediaChannel);
    unregisterPushChannel(pushChannelName);
    void gw.stop();
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);

  logger.info(`wechat gateway scheduled`, {
    accountId,
    baseUrl: creds.baseUrl,
    policy: { dm: policy.dmPolicy, group: policy.groupPolicy },
  });

  return gw;
}

/** How long a quota-suspended reply tail stays deliverable (the peer may come back hours later) */
const REMAINDER_TTL_MS = 6 * 60 * 60_000;

/** Build InboundDispatcher: inbound → handleChatSend → buffer → outbound */
export function makeDispatcher(opts: {
  accountId: string;
  chatSend: ChatSendFn;
  outbound: OutboundQueue;
  logger: GatewayLogger;
  deferredPushes?: MountOptions['deferredPushes'];
}): (e: InboundEvent) => Promise<void> {
  const { accountId, chatSend, outbound, logger, deferredPushes } = opts;

  // Quota-suspended reply tails, keyed by replyTo. WeChat caps bot messages per inbound message
  // (sendText ret=-2); when a reply's tail is rejected, it is parked here and delivered at the
  // START of the peer's next inbound turn — that inbound message carries fresh quota, and the
  // tail must go out before the new reply or the conversation reads out of order.
  const pendingRemainders = new Map<string, { text: string; ts: number }>();

  const stashRemainder = (replyTo: string, text: string, sessionId: string) => {
    // Keep the newest tail only; a stale one would be confusing after a newer reply.
    pendingRemainders.set(replyTo, { text: text.slice(0, 64_000), ts: Date.now() });
    logger.warn('outbound tail suspended (quota) — will resend on next inbound', {
      sessionId,
      replyTo,
      suspendedLen: text.length,
    });
  };

  const flushRemainder = async (replyTo: string) => {
    const pending = pendingRemainders.get(replyTo);
    if (!pending) return;
    pendingRemainders.delete(replyTo);
    if (Date.now() - pending.ts > REMAINDER_TTL_MS) {
      logger.info('suspended tail expired, dropped', { replyTo, ageMs: Date.now() - pending.ts });
      return;
    }
    try {
      const r = await outbound.sendText(
        replyTo,
        (currentPhraseLang('wechat') === 'en'
          ? '(continued — the previous reply hit WeChat\'s length limit)\n\n'
          : '(续上条被微信限额截断的回复)\n\n') + pending.text,
      );
      logger.info('suspended tail resent', { replyTo, chunks: r.chunksSent, failed: r.chunksFailed });
      // Still quota-blocked? Park what's left again (fingerprints differ due to the prefix,
      // but the content is intact — better duplicated framing than lost content).
      if (r.remainder) stashRemainder(replyTo, r.remainder, 'remainder-flush');
    } catch (e) {
      logger.error(`suspended tail resend failed: ${String(e)}`, { replyTo });
    }
  };

  return async (event: InboundEvent) => {
    if (!event.text) {
      logger.info('inbound has no text content (媒体?), 跳过', {
        from: event.fromUserId,
      });
      return;
    }

    // Stable sessionId: same user across multiple turns reuses the same sessionId so that
    // chat-handler's pendingAuth (yes/no follow-up) can work across inbound events.
    const sessionId = makeSessionId(accountId, event);
    const replyTo = event.groupId || event.fromUserId;
    // A failed proactive push is not sent separately here: that would spend the inbound allowance
    // before the current answer. It is appended to the final answer and acknowledged only when the
    // entire combined send succeeds.
    const expired = deferredPushes?.pruneExpired() ?? 0;
    if (expired > 0) logger.warn('expired deferred proactive notices pruned', { count: expired });
    const deferred = event.groupId ? [] : (() => {
      const qualified = deferredPushes?.listPending(`wechat:${accountId}`, replyTo, 3) ?? [];
      return qualified.length > 0 ? qualified : deferredPushes?.listPending('wechat', replyTo, 3) ?? [];
    })();
    const deferredForReply: Array<{ id: string; kind: string; rendered: string }> = [];
    let deferredBudget = 1500;
    for (const item of deferred) {
      const renderedItem = renderForWeChat(item.text);
      if (deferredForReply.length > 0 && renderedItem.length + 2 > deferredBudget) break;
      const clipped = renderedItem.length > deferredBudget
        ? renderedItem.slice(0, Math.max(0, deferredBudget - 45)) +
          (currentPhraseLang('wechat') === 'en' ? '\n… (notice truncated)' : '\n……（通知内容已截断）')
        : renderedItem;
      deferredForReply.push({ id: item.id, kind: item.kind, rendered: clipped });
      deferredBudget -= clipped.length + 2;
      if (deferredBudget <= 0) break;
    }

    // Deliver any quota-suspended tail from the previous turn BEFORE producing the new reply.
    await flushRemainder(replyTo);

    const buffer: string[] = [];
    const onDelta = (chunk: string) => {
      if (chunk) buffer.push(chunk);
    };

    // 2026-05-19: onAuthRequest deferred-send strategy.
    // Previous behaviour: onAuthRequest fires → outbound.sendText immediately → user sees the
    // auth request, then immediately after sees the LLM's partial text (turn-end fullText flush).
    // Two separate messages made it unclear whether the bot was "talking to itself" or
    // "asking for auth".
    //
    // New behaviour: auth request is **cached as pendingAuthPrompt**; dispatcher flushes in
    // a fixed order at the end:
    //   1. Send fullText first (LLM reasoning, as context/preamble)
    //   2. Send pendingAuthPrompt last (auth request as the visually final message, prominent and not buried)
    let pendingAuthPrompt: string | null = null;
    const onAuthRequest = (req: AuthRequestPayload) => {
      pendingAuthPrompt = renderAuthPromptForWeChat(req);
    };

    // 2026-05-07 #5: intermediate status push (reduce "waiting anxiety" caused by WeChat's lack of streaming)
    // Throttle: same text within 30s in the same turn is not re-sent; any status push must be
    // at least 4s apart. OutboundQueue already handles chunk-level dedup + 0.3s rate-limit;
    // this adds a semantic throttle layer to prevent the LLM calling webSearch 5 times rapidly
    // and flooding the user.
    const STATUS_MIN_INTERVAL_MS = 15_000;
    const STATUS_DEDUP_WINDOW_MS = 30_000;
    // Hard per-turn cap. WeChat limits how many bot messages ONE inbound message may earn; a long
    // turn (59 tools + gate regens) sent 10 throttled statuses and the FINAL REPLY was rejected
    // with ret=-2 (quota) — the user saw progress then silence. The final reply must always have
    // quota left, so statuses stop after the cap regardless of throttle windows.
    const STATUS_MAX_PER_TURN = 2;
    const recentStatus = new Map<string, number>(); // text → last send timestamp
    let lastStatusAt = 0;
    let statusSentCount = 0;
    const onStatus = (text: string) => {
      if (!text || text.trim().length === 0) return;
      if (statusSentCount >= STATUS_MAX_PER_TURN) return;
      const now = Date.now();
      // Global throttle (prevent burst)
      if (now - lastStatusAt < STATUS_MIN_INTERVAL_MS) return;
      // Per-text throttle (prevent same tool name flooding)
      const lastSeen = recentStatus.get(text);
      if (lastSeen !== undefined && now - lastSeen < STATUS_DEDUP_WINDOW_MS) return;
      lastStatusAt = now;
      recentStatus.set(text, now);
      statusSentCount++;
      void outbound.sendText(replyTo, text).catch((e) => {
        logger.error(`onStatus relay failed: ${String(e)}`, { replyTo, text });
      });
    };

    const turnStartedAt = Date.now();
    try {
      await chatSend(sessionId, event.text, onDelta, onAuthRequest, onStatus);
    } catch (e) {
      logger.error(`chatSend threw: ${String(e)}`, {
        sessionId: pseudonymizeWeChatId(sessionId),
        from: pseudonymizeWeChatId(event.fromUserId),
      });
      // Send a fallback to the user to avoid a completely silent failure.
      //
      // 2026-08-04: three of these in five hours, each 19 characters, each in fact caused by the HOST
      // being suspended mid-turn — the owner had no way to tell a sleeping laptop from a broken agent.
      // When the clock says the process stopped running during this turn, say so. See suspend_detector.
      const en = currentPhraseLang('wechat') === 'en';
      const suspended = explainSuspension(turnStartedAt, Date.now(), en);
      void outbound.sendText(
        replyTo,
        (en
          ? `Sorry — something went wrong: ${truncate(String((e as any)?.message ?? e), 200)}`
          : `抱歉,刚才出错了:${truncate(String((e as any)?.message ?? e), 200)}`) + (suspended ?? ''),
      );
      return;
    }

    const fullText = buffer.join('').trim();

    // ── flush order (2026-05-19) ───────────────────────────────────────
    // 1. Send LLM reasoning first (filtered through `## For User` + WeChat markdown conversion)
    // 2. Send pendingAuthPrompt last (auth request as final visual item, prominent, not buried)
    //
    // fullText empty + no pending auth = chat-handler was a pure tool-call turn; send nothing
    // fullText empty + has pending auth = send auth request directly (no reasoning prefix)
    if (fullText.length > 0) {
      // Two-stage filter: LLM system prompt contracts output as `## For User` + `## Work Log`;
      // WeChat only forwards the former. If the LLM violates the contract, fallback takes
      // the last non-empty paragraph (fallback hit rate goes to metric; persistently high
      // means the prompt contract has weakened or been crowded out by drives/honesty reminders).
      const filtered = extractUserSection(fullText);
      recordFilterCall(filtered.usedSection);
      let sectioned = filtered.text || fullText; // if filter also empty → fall back to raw
      if (!filtered.usedSection) {
        logger.info('output_filter fallback (no `## 给用户` section)', {
          sessionId,
          fullLen: fullText.length,
          fallbackLen: sectioned.length,
        });
      }

      // Conscience gate (L3 send-to-human exit; no-op unless PHILONT_CONSCIENCE_GATE is on, fail-open).
      const verdict = await runConscienceGate(sectioned);
      if (!verdict.allow) {
        recordControllerFire('conscience');
        logger.info('conscience_gate withheld outbound', { sessionId, reason: verdict.reason });
        sectioned =
          currentPhraseLang('wechat') === 'en'
            ? '(This reply was withheld by the safety review and not sent.)'
            : '(本条回复被安全审查拦下,未发送。)';
      }

      // WeChat markdown conversion: table → bullet, strip **bold** / ### h, inline `code` → 「code」
      let rendered = renderForWeChat(sectioned).trim();
      if (deferredForReply.length > 0 && !pendingAuthPrompt) {
        const heading = currentPhraseLang('wechat') === 'en'
          ? 'Pending notice that could not be delivered earlier:'
          : '此前未能送达的待办通知：';
        rendered = [rendered, `${heading}\n${deferredForReply.map((d) => d.rendered).join('\n\n')}`]
          .filter(Boolean).join('\n\n——\n\n');
      }

      if (rendered.length > 0) {
        try {
          const r = await outbound.sendText(replyTo, rendered);
          logger.info('outbound sent', {
            replyTo,
            chunks: r.chunksSent,
            deduped: r.chunksDeduped,
            failed: r.chunksFailed,
            sectionHit: filtered.usedSection,
          });
          if (r.remainder) stashRemainder(replyTo, r.remainder, sessionId);
          if (deferredForReply.length > 0 && !pendingAuthPrompt && r.chunksFailed === 0 && r.remainder === null) {
            deferredPushes?.markManyDelivered(deferredForReply.map((d) => d.id));
            logger.info('deferred proactive notice delivered with inbound reply', {
              replyTo, count: deferredForReply.length,
            });
          }
        } catch (e) {
          logger.error(`outbound.sendText failed: ${String(e)}`, { replyTo });
        }
      }
    } else {
      logger.info('chatSend produced no text', { sessionId, hasAuthPrompt: !!pendingAuthPrompt });
      if (deferredForReply.length > 0 && !pendingAuthPrompt) {
        try {
          const heading = currentPhraseLang('wechat') === 'en'
            ? 'Pending notice that could not be delivered earlier:'
            : '此前未能送达的待办通知：';
          const r = await outbound.sendText(replyTo, `${heading}\n${deferredForReply.map((d) => d.rendered).join('\n\n')}`);
          if (r.chunksFailed === 0 && r.remainder === null) deferredPushes?.markManyDelivered(deferredForReply.map((d) => d.id));
        } catch (e) {
          logger.error(`deferred notice send failed: ${String(e)}`, { replyTo });
        }
      }
    }

    // Last: send auth request (always the final message — prominent and not buried by later messages)
    if (pendingAuthPrompt) {
      try {
        const r = await outbound.sendText(replyTo, pendingAuthPrompt);
        if (r.chunksFailed > 0 || r.remainder !== null) {
          logger.warn('auth prompt was not fully delivered; deferred notices were preserved', {
            replyTo, failed: r.chunksFailed,
          });
        }
      } catch (e) {
        logger.error(`auth prompt sendText failed: ${String(e)}`, { replyTo });
      }
    }
  };
}

function makeSessionId(accountId: string, e: InboundEvent): string {
  if (e.groupId) {
    return `wechat:${accountId}:group:${e.groupId}:${e.fromUserId}`;
  }
  return `wechat:${accountId}:${e.fromUserId}`;
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}

function defaultLogger(): GatewayLogger {
  return {
    info: (m, meta) => console.log(`[wechat] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[wechat] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[wechat] ${m}`, meta ?? ''),
  };
}
