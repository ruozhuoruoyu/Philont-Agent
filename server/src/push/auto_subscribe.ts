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

/** One-time notice sent in the same turn the subscription is created. */
export const AUTO_SUBSCRIBE_NOTICE =
  '🔔 已为你开启主动消息:有重要发现、或很久没聊时,我会主动发消息给你。回复"取消推送"随时关闭。';

/**
 * Create a default subscription on first DM contact. Returns the user-facing notice when a NEW
 * subscription was created; null when the session is not a pushable DM, the feature is off, or a
 * row (even a disabled one) already exists.
 */
export function maybeAutoSubscribe(
  store: PushSubscriptionStore,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!autoSubscribeEnabled(env)) return null;
  const dm = parseDmPeerFromSessionId(sessionId);
  if (!dm) return null;
  if (store.get(dm.channel, dm.peer) !== null) return null;
  store.subscribe({ channel: dm.channel, peer: dm.peer });
  return AUTO_SUBSCRIBE_NOTICE;
}
