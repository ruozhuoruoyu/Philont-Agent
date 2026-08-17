/** Authorization continuation policy shared by chat transports. */

const MINUTE_MS = 60_000;

function positiveDuration(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a user may answer an authorization card before it becomes stale. */
export function resolvePendingAuthTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveDuration(
    env.PHILONT_PENDING_AUTH_TTL_MS ?? env.PENDING_AUTH_TTL_MS,
    30 * MINUTE_MS,
  );
}

export const PENDING_AUTH_TTL_MS = resolvePendingAuthTtlMs();

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
