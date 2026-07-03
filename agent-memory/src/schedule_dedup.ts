/**
 * Project-scoped schedule dedup.
 *
 * schedule_reminder already replaces a same-NAME schedule. But prod (2026-07-03) created two
 * recurring heartbeats for the same service under DIFFERENT names — `mycox-heartbeat-checkin` and
 * `mycox-checkin-heartbeat` — with near-identical instructions ("Run the MycoX check-in routine…"
 * vs "Execute the MycoX check-in routine…"). Name-only dedup missed them, so both fired and
 * overlapped. This adds an intent-similarity dedup within the same project + action_type.
 */

/** The comparable instruction text of a schedule payload (autonomous_turn → prompt, else message). */
export function scheduleIntentText(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return String(p.prompt ?? p.message ?? '');
}

export function tokenizeIntent(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2),
  );
}

/** Jaccard similarity of two token sets (|A∩B| / |A∪B|); 0 when either is empty. */
export function intentSimilarity(a: string, b: string): number {
  const sa = tokenizeIntent(a);
  const sb = tokenizeIntent(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Two recurring routines are duplicates when their instructions strongly overlap. Threshold is high
 * (0.7) so paraphrases of the SAME routine dedup while genuinely distinct routines in one project
 * (e.g. "daily digest" vs "hourly monitor") do not.
 */
export function isDuplicateRoutine(newText: string, existingText: string, threshold = 0.7): boolean {
  return intentSimilarity(newText, existingText) >= threshold;
}

/**
 * Per-project cap on recurring routines. Intent dedup only catches paraphrases; prod spawned ~8
 * mycox heartbeats under genuinely different names/prompts — a horizontal swarm that per-schedule
 * auto-pause cannot stop. Given the existing enabled routines for a project, return the OLDEST ones
 * to disable so that, once ONE new schedule is added, the project holds at most `cap` (i.e. keep the
 * cap-1 newest existing + the new one).
 */
export function schedulesOverCap<T extends { createdAt: number }>(live: readonly T[], cap: number): T[] {
  const keep = Math.max(1, cap) - 1;
  const sorted = [...live].sort((a, b) => a.createdAt - b.createdAt);
  const excess = sorted.length - keep;
  return excess > 0 ? sorted.slice(0, excess) : [];
}
