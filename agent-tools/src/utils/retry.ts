/**
 * Generic bounded retry-with-backoff for transient failures (2026-06-16).
 *
 * Used by read-only / idempotent network tools (webFetch, webSearch) so a transient network stall
 * (timeout / connection reset) doesn't become a spurious tool failure. Spurious failures matter beyond
 * UX: the ViabilityGate now reads tool-failure / same_root_cause as STOP signals, so noisy network
 * failures could cluster and trigger a false stop. Retrying idempotent reads keeps that signal clean.
 *
 * Only for IDEMPOTENT operations (GET-style reads) — a failed attempt produced no side effect, so
 * re-issuing is safe. Do NOT use for writes/downloads that may leave partial state.
 */

export interface RetryOptions {
  /** Max retries after the first attempt (default 2 → up to 3 attempts total). */
  retries?: number;
  /** Returns true if the error should be retried; false → rethrow immediately. */
  isRetryable: (error: unknown) => boolean;
  /** Base backoff in ms (default 400). Exponential: base · 2^attempt, capped at 6s. */
  baseDelayMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt >= retries || !opts.isRetryable(e)) throw e;
      const backoffMs = Math.min(6000, base * 2 ** attempt) + (attempt * 97) % 200; // deterministic jitter
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
