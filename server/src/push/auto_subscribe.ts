/**
 * First-contact push auto-subscribe (WS6, docs/design/selfhood_closure.md).
 *
 * The PushDispatcher requires a per-(channel, peer) opt-in subscription before ANY external
 * push (digest / urgent) is delivered. Nothing ever created that row automatically, so out of
 * the box every proactive channel was silent: autonomous findings and service digests were
 * generated and then dropped at the subscription gate (dispatcher.ts "no_active_subscription").
 * This closes the gap: the FIRST direct-message contact from a peer on a push-capable channel
 * creates a default subscription and tells the user how to opt out, in the same turn.
 *
 * Rules:
 *   - DM sessions only — group chats never auto-subscribe.
 *   - An existing row, enabled OR disabled, is authoritative: a previous unsubscribe
 *     (enabled=0) is an explicit opt-out and is never overridden here.
 *   - Kill switch: PHILONT_PUSH_AUTOSUBSCRIBE=0/off/false/no (default ON).
 */

import type { PhraseLang } from '../channel_phrases.js';
import type { PushSubscriptionStore } from '@agent/memory';

/** Channels whose sessionIds encode a pushable DM peer. Web-ui has no subscription concept. */
const PUSH_CAPABLE_CHANNELS = new Set(['wechat', 'telegram']);

export function autoSubscribeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PHILONT_PUSH_AUTOSUBSCRIBE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Parse a DM (channel, peer) out of a channel sessionId.
 * Formats (see channels/wechat/index.ts makeSessionId, channels/telegram/index.ts):
 *   wechat:<accountId>:<peerUserId>            → DM
 *   wechat:<accountId>:group:<gid>:<uid>       → group (rejected)
 *   telegram:<botId>:<peerUserId>              → DM
 *   telegram:<botId>:group:<gid>:<uid>         → group (rejected)
 * Anything else (web-ui uuids, system:scheduled:* …) → null.
 */
export function parseDmPeerFromSessionId(
  sessionId: string,
): { channel: string; peer: string } | null {
  const parts = sessionId.split(':');
  if (parts.length !== 3) return null;
  const [channel, , peer] = parts;
  if (!PUSH_CAPABLE_CHANNELS.has(channel)) return null;
  if (!peer || peer === 'group') return null;
  return { channel, peer };
}

/**
 * One-time notice sent in the same turn the subscription is created.
 *
 * 2026-07-14: this notice promised an off-switch that DID NOT EXIST. Nothing in the repo matched
 * "取消推送", and PushSubscriptionStore.unsubscribe() — which is right there — had ZERO callers anywhere in
 * the server. We opt the owner IN automatically on first contact, tell them how to opt out, and then do not
 * listen. There was no way for a person to make us stop messaging them through the channel we told them to
 * use. See classifyPushControlReply, which is now the thing that listens.
 */
export function autoSubscribeNotice(lang: PhraseLang = 'zh'): string {
  return lang === 'en'
    ? '🔔 Proactive messages are on: I will message you when I find something important, or when we have not talked in a while. Reply "stop pushing" to turn it off at any time.'
    : '🔔 已为你开启主动消息:有重要发现、或很久没聊时,我会主动发消息给你。回复"取消推送"随时关闭。';
}

/** @deprecated Use autoSubscribeNotice(lang) — kept so existing callers/tests keep compiling. */
export const AUTO_SUBSCRIBE_NOTICE = autoSubscribeNotice('zh');

/**
 * Match the OFF-SWITCH we just promised — in both languages, always.
 *
 * This is layer 1 (reading back our own closed enum), so it is an exact anchored match, not intent
 * inference. Open-language versions of the same wish ("你别老发消息了") are NOT handled here; they go to the
 * model, which has the unsubscribe tool. What this guarantees is that the EXACT words we printed always work,
 * deterministically, without depending on the model noticing.
 */
export function classifyPushControlReply(userMessage: string): 'unsubscribe' | 'resubscribe' | null {
  const m = (userMessage ?? '').trim().toLowerCase().replace(/[。！？，,!?.\s"'「」]+/g, '');
  if (!m) return null;
  if (/^(取消推送|别推送|停止推送|不要推送|关闭推送|退订|unsubscribe|stoppushing|stoppush)$/.test(m)) {
    return 'unsubscribe';
  }
  // The OFF confirmation offers a way back on ("恢复推送" / "resume pushing"). Offering a word and not
  // listening for it is the very defect this function exists to close — do not print an option we ignore.
  if (/^(恢复推送|开启推送|打开推送|重新推送|订阅|resubscribe|resumepushing|resumepush)$/.test(m)) {
    return 'resubscribe';
  }
  return null;
}

/**
 * Create a default subscription on first DM contact. Returns the user-facing notice when a NEW
 * subscription was created; null when the session is not a pushable DM, the feature is off, or a
 * row (even a disabled one) already exists.
 */
export function maybeAutoSubscribe(
  store: PushSubscriptionStore,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  lang: PhraseLang = 'zh',
): string | null {
  if (!autoSubscribeEnabled(env)) return null;
  const dm = parseDmPeerFromSessionId(sessionId);
  if (!dm) return null;
  if (store.get(dm.channel, dm.peer) !== null) return null;
  store.subscribe({ channel: dm.channel, peer: dm.peer });
  return autoSubscribeNotice(lang);
}
