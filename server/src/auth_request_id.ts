import { createHash } from 'node:crypto';

/**
 * One-character card addresses (2026-11-25, owner request: a six-character hex code was tedious to type
 * on WeChat, and at most one card per session is pending at a time). The alphabet drops look-alikes
 * (0/O, 1/I/L) so a code read off a phone screen is typed back unambiguously; matching ignores case.
 * The code still only has to tell the current card from a stale one, so 31 symbols is enough: a reply
 * addressed to an older card collides with the current one about 1 time in 31, and only on that rare path.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Stable, human-readable address for an authorization card. */
export function authRequestCode(requestId: string | undefined): string | undefined {
  if (!requestId) return undefined;
  const digest = createHash('sha256').update(requestId).digest();
  return CODE_ALPHABET[digest.readUInt32BE(0) % CODE_ALPHABET.length];
}

/**
 * The six-hex address cards carried before 2026-11-25. A reply typed from a card delivered before the
 * upgrade must still be matched exactly — falling through to the semantic classifier would let
 * "批准 AFED9E" grant whatever card is pending now.
 */
function legacyAuthRequestCode(requestId: string): string {
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
 * Parse an explicitly addressed reply such as `批准 A`, `ok #A` or (legacy) `拒绝 A1B2C3`.
 * An address that names another visible card fails closed instead of falling through
 * to the semantic classifier and accidentally approving the current request.
 */
export function matchScopedAuthReply(
  reply: string,
  requestId: string | undefined,
): ScopedAuthReply {
  const normalized = reply.trim();
  const match = normalized.match(
    /^(ok|okay|approve|allow|同意|允许|批准|deny|reject|拒绝|不同意)\s*[#：:]?\s*([a-z0-9]|[a-f0-9]{6})$/i,
  );
  if (!match) return undefined;
  const given = match[2].toUpperCase();
  const expected = !requestId
    ? undefined
    : given.length === 1 ? authRequestCode(requestId) : legacyAuthRequestCode(requestId);
  if (!expected || given !== expected) return 'mismatch';
  return /^(deny|reject|拒绝|不同意)$/i.test(match[1]) ? 'deny' : 'grant';
}
