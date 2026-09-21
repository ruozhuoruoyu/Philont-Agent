/**
 * "The owner brought this up recently" — the mechanism-side visibility criterion for autonomous findings
 * that is neither an owner-declared pursuit nor an executor self-escalation (2026-09-21).
 *
 * Prod 2026-09-21: the owner asked at 11:11 about a claimed Goldbach proof; the agent's answer named
 * `openai/ten-proofs`; at 12:05 curiosity had that repository and the underlying paper in hand, with
 * new facts, and dropped both at funnel gate 1 as severity=normal. A finding about the thing the owner
 * asked about an hour ago is owner-visible by construction. Recency is read from the global timeline:
 * the owner's own messages over the last day, and the agent's replies over the last few hours (the
 * reply is where the owner's question gets its concrete names). Exact substring match on the token the
 * curiosity driver harvested — no semantics, nothing the owner did not literally see.
 */

export const OWNER_RECENT_USER_WINDOW_MS = 24 * 60 * 60_000;
export const OWNER_RECENT_ASSISTANT_WINDOW_MS = 6 * 60 * 60_000;
const MIN_TOKEN_CHARS = 6;

/** The literal token a `token:<x>` targetRef carries; null for pursuit/fact/other refs. */
export function tokenOfTargetRef(targetRef: string): string | null {
  const m = /^(?:[a-z_-]+ )?token:(.+)$/i.exec((targetRef ?? '').trim());
  if (!m) return null;
  const t = m[1].trim();
  return t.length >= MIN_TOKEN_CHARS ? t : null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

/** True when any of the texts literally contains the token (case-insensitive, URL scheme-insensitive). */
export function ownerMentionedToken(token: string, texts: ReadonlyArray<string>): boolean {
  const t = normalize(token);
  if (t.length < MIN_TOKEN_CHARS) return false;
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    if (normalize(text).includes(t)) return true;
  }
  return false;
}
