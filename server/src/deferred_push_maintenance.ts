import type { DeferredPushExpirySummary, DeferredPushStore, MetricsStore } from '@agent/memory';
import { utcDateString } from '@agent/memory';

export interface DeferredPushMaintenanceLogger {
  warn(message: string, detail?: unknown): void;
}

/** Channel-independent lifecycle owner for the durable proactive-message mailbox. */
export function maintainDeferredPushes(
  store: DeferredPushStore,
  metrics: MetricsStore,
  logger: DeferredPushMaintenanceLogger = console,
  now = Date.now(),
): DeferredPushExpirySummary {
  store.pruneExpired(now);
  const summary = store.takePrunedSummary();
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
