/**
 * Scheduled-turn progress verdict — the input to the scheduler's failure circuit breaker.
 *
 * Background (prod 2026-07-03): the scheduler auto-pauses a schedule for 1h after N consecutive
 * FAILURES, but "failure" was defined as "the autonomous turn threw". A scheduled turn that returns
 * an HONEST "partial (0/N) — every business http 401'd" report does NOT throw, so it was counted as
 * a success, the consecutive-failure counter reset every fire, and the schedule never paused. Two
 * mycox heartbeats avalanched ~30s apart, all 401, until a manual SIGINT. The honesty win (always
 * return a truthful partial report) had silently disabled the safety breaker.
 *
 * Fix: judge a scheduled turn by whether it made REAL external progress, not by whether it threw.
 */

import type { InTurnToolRecord } from './in_turn_reflection.js';

/** An external write attempt = an http call with a mutating method (POST/PUT/DELETE/PATCH). */
export function isExternalWriteRecord(r: InTurnToolRecord): boolean {
  if (r.toolName !== 'http') return false;
  const method = String((r.toolInput as Record<string, unknown> | undefined)?.method ?? 'GET');
  return /^(POST|PUT|DELETE|PATCH)$/i.test(method);
}

/**
 * Did this scheduled turn make real external progress?
 *   - ≥1 successful external write            → progress (something landed);
 *   - zero external writes attempted          → progress (a clean read-only check-in is fine);
 *   - writes attempted but ALL failed         → NO progress (the all-401 avalanche shape).
 *
 * Deliberately conservative: it only reports no-progress when the turn tried to change external
 * state and every attempt failed. A false "no progress" merely nudges the failure counter (auto-pause
 * needs N in a row and a human can resume); a false "progress" is what let the avalanche run forever.
 */
export function scheduledTurnMadeProgress(records: readonly InTurnToolRecord[]): boolean {
  let okWrites = 0;
  let failedWrites = 0;
  for (const r of records) {
    if (!isExternalWriteRecord(r)) continue;
    if (r.success) okWrites++;
    else failedWrites++;
  }
  return okWrites > 0 || failedWrites === 0;
}
