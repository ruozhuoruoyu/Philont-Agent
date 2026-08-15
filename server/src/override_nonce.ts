/**
 * Single-use nonces proving that a gate override came from the UI, not from the agent.
 *
 * `installFromSource` only honours `override` for `actor: 'user'`, and the agent-facing tool cannot
 * set it — but that guarantee lived entirely in the tool schema. The HTTP endpoint handed `actor:
 * 'user'` to whatever posted the JSON, and philont has a shell tool: one `curl` from inside a turn
 * and the model walks itself past a gate designed to stop exactly that, with the audit line recording
 * it as the owner's decision. A wrong attribution in the audit log is worse than no audit at all.
 *
 * So an override now requires a nonce that must be fetched first, from a request that passed the
 * cross-site check, and is consumed on use. That does not make the boundary cryptographic — a local
 * process can fetch a nonce too — but it does mean:
 *   - a single blind POST (the CSRF shape) cannot override anything;
 *   - anything that overrides has taken a two-step, deliberate path;
 *   - the audit records WHICH path was taken, so 'user' means user.
 */

import { randomBytes } from 'node:crypto';

/** How long an issued nonce stays usable. Long enough to click a confirm dialog, short enough to be one act. */
const TTL_MS = 2 * 60 * 1000;
/** Cap the table so a loop of GETs cannot grow memory without bound. */
const MAX_OUTSTANDING = 32;

const outstanding = new Map<string, number>(); // nonce → expiry (ms epoch)

function sweep(now: number): void {
  for (const [nonce, expiry] of outstanding) {
    if (expiry <= now) outstanding.delete(nonce);
  }
}

/** Issue a nonce for the UI's override confirmation flow. */
export function issueOverrideNonce(now = Date.now()): { nonce: string; expiresInMs: number } {
  sweep(now);
  if (outstanding.size >= MAX_OUTSTANDING) {
    // Drop the oldest rather than refuse: these are cheap and the cap is a memory bound, not a quota.
    const oldest = [...outstanding.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) outstanding.delete(oldest[0]);
  }
  const nonce = randomBytes(24).toString('base64url');
  outstanding.set(nonce, now + TTL_MS);
  return { nonce, expiresInMs: TTL_MS };
}

/** Consume a nonce. Returns true exactly once per issued nonce, and only before it expires. */
export function consumeOverrideNonce(nonce: string | undefined | null, now = Date.now()): boolean {
  if (!nonce) return false;
  sweep(now);
  const expiry = outstanding.get(nonce);
  if (expiry === undefined || expiry <= now) return false;
  outstanding.delete(nonce);
  return true;
}

/** Test hook. */
export function _clearOverrideNoncesForTest(): void {
  outstanding.clear();
}
