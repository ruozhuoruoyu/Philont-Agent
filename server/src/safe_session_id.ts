/**
 * Session identifiers in the process log.
 *
 * A WeChat session id is built from the peer's account id — `wechat:o9cq801SI55…@im.wechat:o9cq…` —
 * so `session=${sessionId}` printed the owner's real messaging identity on essentially every log line
 * this server writes. Redacting the raw inbound payload while that line stayed was covering one hole
 * in the same wall.
 *
 * What replaces it has to stay usable, because these logs are how this system gets debugged: the
 * channel prefix survives (so you can still see which surface a turn came from), the identifier
 * becomes a stable hash (so you can still grep one conversation across a whole day, and correlate
 * across restarts), and nothing personal is left.
 */
import { createHash } from 'node:crypto';

const cache = new Map<string, string>();

export function safeSessionId(sessionId: string | undefined | null): string {
  if (!sessionId) return '(none)';
  const cached = cache.get(sessionId);
  if (cached) return cached;

  const safe = compute(sessionId);
  // Bounded: a long-lived process must not accumulate an entry per session forever.
  if (cache.size > 500) cache.clear();
  cache.set(sessionId, safe);
  return safe;
}

function compute(sessionId: string): string {
  // Internal namespaces carry no identifier and stay readable.
  if (sessionId.startsWith('system:') || sessionId.startsWith('__')) return sessionId;
  const sep = sessionId.indexOf(':');
  // No separator = a generated web/ws sid: already opaque and not derived from a person.
  if (sep < 0) return sessionId;
  const channel = sessionId.slice(0, sep);
  return `${channel}:${digest(sessionId.slice(sep + 1))}`;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}
