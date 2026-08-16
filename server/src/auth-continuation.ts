/** Authorization continuation policy shared by chat transports. */

const MINUTE_MS = 60_000;

function positiveDuration(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a user may answer an authorization card before it becomes stale. */
export const PENDING_AUTH_TTL_MS = positiveDuration(
  process.env.PHILONT_PENDING_AUTH_TTL_MS,
  30 * MINUTE_MS,
);

/** How long an approved capability remains usable by the resumed workflow. */
export const WORKFLOW_GRANT_TTL_MS = positiveDuration(
  process.env.PHILONT_WORKFLOW_GRANT_TTL_MS,
  30 * MINUTE_MS,
);

export function workflowGrantMinutes(): number {
  return Math.max(1, Math.round(WORKFLOW_GRANT_TTL_MS / MINUTE_MS));
}

export function isPendingAuthExpired(createdAt: number, now = Date.now()): boolean {
  return now - createdAt > PENDING_AUTH_TTL_MS;
}

/**
 * Fast path used only when a concrete authorization request is pending.
 * Ordinary chat messages never pass through this classifier.
 */
export function classifyPendingAuthReply(
  message: string,
): 'grant' | 'deny' | 'unclear' {
  const normalized = message.trim().toLocaleLowerCase();
  if (/^(ok|okay|允许|同意|批准|确认|继续|可以|好的|好)$/.test(normalized)) {
    return 'grant';
  }
  if (/^(no|拒绝|不同意|不允许|取消|算了|不要|否)$/.test(normalized)) {
    return 'deny';
  }
  return 'unclear';
}
