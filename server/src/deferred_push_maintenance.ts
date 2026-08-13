import type { DeferredPushExpirySummary, DeferredPushStore, MetricsStore } from '@agent/memory';
import { utcDateString } from '@agent/memory';

export interface DeferredPushMaintenanceLogger {
  warn(message: string, detail?: unknown): void;
}

/**
 * Channel-independent lifecycle owner for the durable proactive-message mailbox, and the only production
 * caller of `pruneExpired` — by convention, not by construction (see the ownership note on
 * DeferredPushStore). Persisting the aggregate is the first thing done with it, but the DELETE inside
 * `pruneExpired` and the metrics writes below are not one transaction: a crash in between still loses
 * that day's count. The window is now bounded by these few lines instead of by the maintenance interval.
 */
export function maintainDeferredPushes(
  store: DeferredPushStore,
  metrics: MetricsStore,
  logger: DeferredPushMaintenanceLogger = console,
  now = Date.now(),
): DeferredPushExpirySummary {
  const summary = store.pruneExpired(now);
  if (summary.count === 0) return summary;
  const day = utcDateString(now);
  metrics.increment(`push.deferred_expired.day.${day}`, summary.count, now);
  for (const [kind, count] of Object.entries(summary.byKind)) {
    metrics.increment(`push.deferred_expired.kind.${kind}.${day}`, count, now);
  }
  for (const [channel, count] of Object.entries(summary.byChannel)) {
    metrics.increment(`push.deferred_expired.channel.${channel}.${day}`, count, now);
  }
  logger.warn('[push] expired deferred proactive notices pruned', {
    count: summary.count, byKind: summary.byKind, byChannel: summary.byChannel,
  });
  return summary;
}
