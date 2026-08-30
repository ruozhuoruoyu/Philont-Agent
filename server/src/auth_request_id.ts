import { createHash } from 'node:crypto';

/** Stable, human-readable address for an authorization card. */
export function authRequestCode(requestId: string | undefined): string | undefined {
  if (!requestId) return undefined;
  return createHash('sha256').update(requestId).digest('hex').slice(0, 6).toUpperCase();
}

export type ScopedAuthReply = 'grant' | 'deny' | 'mismatch' | undefined;

/**
 * Historical UI clients and the owner's established workflow use bare `ok`. It is
 * intentionally NOT a general authorization word: this compatibility check is only
 * used after a pre-delivery bypass, where it can keep a card pending but can never
 * grant the capability.
 */
export function isBarePredeliveryAuthReply(reply: string): boolean {
  return /^(?:ok|okay)[.!。！\s]*$/i.test(reply.trim());
}

/**
 * Parse an explicitly addressed reply such as `ok A1B2C3` or `拒绝 A1B2C3`.
 * An address that names another visible card fails closed instead of falling through
 * to the semantic classifier and accidentally approving the current request.
 */
export function matchScopedAuthReply(
  reply: string,
  requestId: string | undefined,
): ScopedAuthReply {
  const expected = authRequestCode(requestId);
  const normalized = reply.trim();
  const match = normalized.match(/^(ok|okay|approve|allow|同意|允许|批准|deny|reject|拒绝|不同意)\s*[#：:]?\s*([a-f0-9]{6})$/i);
  if (!match) return undefined;
  if (!expected || match[2].toUpperCase() !== expected) return 'mismatch';
  return /^(deny|reject|拒绝|不同意)$/i.test(match[1]) ? 'deny' : 'grant';
}
