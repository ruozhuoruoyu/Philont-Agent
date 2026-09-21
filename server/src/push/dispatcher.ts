/**
 * PushDispatcher — central scheduler for active push.
 *
 * Core responsibilities (checked in order for each enqueue):
 *   1. Global kill switch (env PHILONT_PUSH_ENABLED=0)
 *   2. PushChannel registered and ready
 *   3. Subscription exists and is enabled
 *   4. Frequency rate-limit (digest 4h / urgent 1h; overridable per subscription)
 *   5. Quiet hours (timezone-aware; respected even for urgent)
 *   6. 24h deduplication (same kind+targetRef)
 *   7. Actually call channel.pushText
 *   8. On success: update last_*_at + dedup map
 *
 * Not handled here:
 *   - Chunk-level splitting / channel-internal rate-limiting — handled by channel's own OutboundQueue
 *   - Persisting the dedup map — in-memory ring, cleared on restart (short-window dedup is sufficient for push risk)
 *   - Retries — channel failure is dropped; visible in audit; ServiceDriver will supplement
 *
 * Severity semantics:
 *   - urgent: important finding detected (autonomous shouldEscalate), push immediately
 *   - digest: agent proactively reports progress (triggered by ServiceDriver), aggregated at 4h intervals
 */

import { createHash } from 'node:crypto';
import type { DeferredPush, DeferredPushStore, FoldedReports, PushSubscription, PushSubscriptionStore } from '@agent/memory';
import type { PushChannel } from './channel.js';
import { findPushChannel, describePushChannelMiss } from './channel.js';

export type PushSeverity = 'urgent' | 'digest';

/** Floor between two blocking decision cards to the same person. See PushRequest.blocking. */
const BLOCKING_MIN_INTERVAL_MS = 5 * 60_000;
/**
 * Messages of a metered peer's allowance kept for content. Prod 2026-09-14 06:31 → 07:18: the owner's
 * "继续" bought ten messages; six went to "本轮已运行 5/10 分钟" heartbeats and the four milestones that
 * carried the morning's proofs all bounced with prepare failed. A heartbeat is not sent into the last
 * few; a milestone always may be.
 */
export const HEARTBEAT_ALLOWANCE_RESERVE = 3;
/**
 * Messages of a metered peer's allowance kept for a BLOCKING notice (paused / needs an answer). Prod
 * 2026-09-17 16:37 → 16:46: the tenth message after "换namecheck10" was a routine round report; nine
 * minutes later the "自动推进已暂停" card — the one that tells the owner to reply — bounced with
 * `prepare failed`. A routine report at the last slot is deferred to the mailbox instead (and the
 * series rule keeps only the newest one there); a blocking card still goes.
 */
export const MILESTONE_ALLOWANCE_RESERVE = 1;

/**
 * Silence-window digest (2026-09-21). The milestone reserve above keeps the peer's last allowance slot
 * for a blocking card — correct while the owner is around, and a black hole when they are not: prod
 * 2026-09-21 07:56 → 13:21, forty-five auto-advance rounds, every report `allowance_reserved
 * (remaining=0/4)`, and the mailbox's series rule kept only the newest. When reports have been pending
 * this long with no inbound, ONE routine report may spend the reserved slot — and it carries the fold
 * digest of everything it replaced, so that one message says what the silence contained. Once per
 * window per series; `PHILONT_PUSH_SILENCE_DIGEST_MS=0` disables. A blocking card that follows inside
 * the window bounces to the mailbox and is delivered with the next inbound, as any failed push is.
 */
export function silenceDigestWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PHILONT_PUSH_SILENCE_DIGEST_MS ?? '').trim();
  if (raw === '') return 2 * 60 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 2 * 60 * 60_000;
}

const FOLD_MAX_HEADLINES = 8;
const FOLD_HEADLINE_CHARS = 90;

/** The first meaningful line of a report, stripped of markdown furniture, bounded. */
export function headlineOf(text: string): string {
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/^[\s#>*\-•·]+/, '').replace(/\*\*/g, '').trim();
    if (!line) continue;
    return line.length > FOLD_HEADLINE_CHARS ? `${line.slice(0, FOLD_HEADLINE_CHARS)}…` : line;
  }
  return '';
}

/**
 * Fold the pending rows a new report is about to supersede into one digest: their count (including
 * what they had folded themselves), the oldest timestamp, and the most recent headlines. Pure.
 */
export function foldSeries(rows: ReadonlyArray<Pick<DeferredPush, 'text' | 'createdAt' | 'folded'>>): FoldedReports | null {
  if (rows.length === 0) return null;
  let count = 0;
  let since = Number.POSITIVE_INFINITY;
  const headlines: string[] = [];
  for (const r of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
    count += 1 + (r.folded?.count ?? 0);
    since = Math.min(since, r.createdAt, r.folded?.since ?? r.createdAt);
    for (const h of r.folded?.headlines ?? []) headlines.push(h);
    const own = headlineOf(r.text);
    if (own) headlines.push(own);
  }
  return { count, since: Number.isFinite(since) ? since : 0, headlines: headlines.slice(-FOLD_MAX_HEADLINES) };
}

/** The digest block appended to a report's text. Empty when nothing was folded. */
export function renderFold(folded: FoldedReports | null | undefined, lang: 'zh' | 'en', now = Date.now()): string {
  if (!folded || folded.count <= 0) return '';
  const hours = Math.max(0, now - folded.since) / 3_600_000;
  const span = hours >= 1 ? `${Math.round(hours * 10) / 10}h` : `${Math.max(1, Math.round(hours * 60))}min`;
  const omitted = Math.max(0, folded.count - folded.headlines.length);
  const lines = folded.headlines.map((h) => `- ${h}`);
  if (lang === 'zh') {
    return (
      `\n\n（此前 ${folded.count} 轮进展未能送达，跨 ${span}；摘要：\n${lines.join('\n')}` +
      (omitted > 0 ? `\n- …另 ${omitted} 轮略` : '') + '）'
    );
  }
  return (
    `\n\n(${folded.count} earlier report(s) could not be delivered, spanning ${span}; digest:\n${lines.join('\n')}` +
    (omitted > 0 ? `\n- … ${omitted} more omitted` : '') + ')'
  );
}

function langOfChannel(channel: string): 'zh' | 'en' {
  return channel.startsWith('wechat') ? 'zh' : 'en';
}

export interface PushRequest {
  severity: PushSeverity;
  /** Push category (for dedup), e.g. 'autonomous_finding' / 'service_dormancy' */
  kind: string;
  /** Stable target reference (for dedup), e.g. 'initiative:abc' / 'pursuit:p1' */
  targetRef: string;
  /** Text to show the user (pre-rendered; the channel may chunk further) */
  text: string;
  /**
   * Optional: explicitly specify channel + peer. If omitted, fan-out to all enabled subscriptions.
   * Used for "push to this specific WeChat user" scenarios.
   */
  routing?: { channel: string; peer: string };
  /**
   * This push STOPS work and asks the owner something. It does not share the routine urgent budget.
   *
   * Prod 2026-09-01 23:11 delivered a routine auto-advance milestone; at 23:17 the card saying the
   * batch had stopped as stuck — the one that needed an answer to restart anything — was dropped as
   * `rate_limited (interval=3600000)`. Both were severity=urgent and kind=deep_explore:auto_advance,
   * so a progress note spent the hour and the decision that followed it went unsaid. A limiter whose
   * job is "do not chatter" must not be the thing that swallows a question; the same session then sat
   * paused with the owner never told why, which is the failure this whole family of fixes is about.
   *
   * Bounded by its own short floor (BLOCKING_MIN_INTERVAL_MS) rather than by nothing, and it still
   * respects quiet hours and 24h dedup like everything else. The natural bound is upstream anyway: a
   * driver that pauses itself does not re-ask.
   */
  blocking?: boolean;
  /** Opted-in task reports have their own cadence; routine urgent notices cannot starve them. */
  progress?: 'milestone' | 'heartbeat';
  /**
   * Series prefix: pending mailbox rows of the same kind whose targetRef starts with this are made
   * obsolete by this push, whether it is delivered now or deferred itself. For reports where the latest
   * one carries the whole state (a deep_explore progress card restates the tree counts and the next
   * step), so the mailbox never hands the owner yesterday's round 13 after today's round 1.
   */
  supersedes?: string;
}

export interface DispatchResult {
  /** Number of (channel, peer) pairs actually delivered to */
  delivered: number;
  /** Number of skips + reasons (for audit / debugging) */
  skipped: SkipReason[];
  /** Number of channel.pushText failures */
  failed: number;
  /** Accepted into a durable next-inbound mailbox (not yet delivered). */
  deferred: number;
  /** At least one chunk arrived, but the logical push was not complete. */
  partiallyDelivered: number;
}

export interface SkipReason {
  channel: string;
  peer: string;
  reason:
    | 'global_disabled'
    | 'channel_not_found'
    | 'channel_not_ready'
    | 'no_active_subscription'
    | 'rate_limited'
    | 'quiet_hours'
    | 'allowance_reserved'
    | 'duplicate';
  detail?: string;
}

export interface PushDispatcherOptions {
  subscriptions: PushSubscriptionStore;
  deferredPushes?: DeferredPushStore;
  /** Max entries in the 24h dedup ring (to bound memory). Default 1000 */
  dedupRingCap?: number;
  /** Global kill check callback (default: reads env PHILONT_PUSH_ENABLED) */
  isGloballyEnabled?: () => boolean;
  logger?: { log: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
  /** Clock injection for testing */
  now?: () => number;
  /**
   * Called after every real send attempt with its outcome. Exists because "registered" and "deliverable"
   * are different facts: the health report's reachability line was answering "does the channel name
   * resolve?" while every actual send had been failing for twelve hours — a reachability claim that did
   * not consult the delivery path, on the very line built after the last time that happened.
   */
  onSendOutcome?: (channel: string, ok: boolean) => void;
}

interface DedupEntry {
  fingerprint: string;
  expiresAt: number;
}

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export class PushDispatcher {
  private readonly opts: Required<Omit<PushDispatcherOptions, 'logger' | 'now' | 'isGloballyEnabled' | 'onSendOutcome' | 'deferredPushes'>> & {
    logger: NonNullable<PushDispatcherOptions['logger']>;
    now: () => number;
    isGloballyEnabled: () => boolean;
  };
  private dedupRing: DedupEntry[] = [];
  /** Last blocking (decision-carrying) push per channel+peer — the floor that keeps a storm out. */
  private readonly lastBlockingAt = new Map<string, number>();
  private readonly lastProgressAt = new Map<string, number>();
  /** Last silence-window digest per channel+peer+kind, and the sends armed to record one. */
  private readonly lastSilenceDigestAt = new Map<string, number>();
  private readonly silenceDigestArmed = new Set<string>();
  private readonly onSendOutcome?: (channel: string, ok: boolean) => void;
  private readonly deferredPushes?: DeferredPushStore;

  constructor(options: PushDispatcherOptions) {
    this.onSendOutcome = options.onSendOutcome;
    this.deferredPushes = options.deferredPushes;
    this.opts = {
      subscriptions: options.subscriptions,
      dedupRingCap: options.dedupRingCap ?? 1000,
      logger: options.logger ?? {
        log: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m, e) => console.error(m, e),
      },
      now: options.now ?? (() => Date.now()),
      isGloballyEnabled:
        options.isGloballyEnabled ?? (() => process.env.PHILONT_PUSH_ENABLED !== '0'),
    };
  }

  /** Main entry point. Caller fire-and-forget; dispatcher does not throw internally. */
  async enqueue(req: PushRequest): Promise<DispatchResult> {
    const result: DispatchResult = { delivered: 0, skipped: [], failed: 0, deferred: 0, partiallyDelivered: 0 };
    const now = this.opts.now();

    // 1. Global kill switch
    if (!this.opts.isGloballyEnabled()) {
      result.skipped.push({ channel: '*', peer: '*', reason: 'global_disabled' });
      return this.finish(req, result);
    }

    // 2. Resolve routing: explicit routing takes priority; otherwise fan-out to all active subscriptions
    const targets = req.routing
      ? [{ channel: req.routing.channel, peer: req.routing.peer, sub: this.opts.subscriptions.get(req.routing.channel, req.routing.peer) }]
      : this.opts.subscriptions
          .listActive()
          .map((sub) => ({ channel: sub.channel, peer: sub.peer, sub }));

    if (targets.length === 0) {
      // No subscriptions. This used to return an empty result with no skip reason at all — the quietest
      // possible failure, and the most common one: a channel nobody has opted into looks exactly like a
      // channel that had nothing to say. Record it as a reason so finish() can say so out loud.
      result.skipped.push({ channel: '*', peer: '*', reason: 'no_active_subscription' });
      return this.finish(req, result);
    }

    // 3. 24h dedup fingerprint
    const fp = computeFingerprint(req.kind, req.targetRef);
    if (this.isDuplicate(fp, now)) {
      // Entire request is a duplicate → skip all targets
      for (const t of targets) {
        result.skipped.push({ channel: t.channel, peer: t.peer, reason: 'duplicate' });
      }
      return this.finish(req, result);
    }

    // 4. Send per target
    let anyDelivered = false;
    for (const t of targets) {
      // What this report is about to supersede, read BEFORE anything is discarded: folded into the
      // deferred row if it waits, appended as a digest if it goes out now. Rows for the same targetRef
      // are the same report retried, not an earlier one.
      const series = req.supersedes && this.deferredPushes
        ? this.deferredPushes.listSeries(t.channel, t.peer, req.kind, req.supersedes, undefined, now)
            .filter((r) => r.targetRef !== req.targetRef)
        : [];
      const fold = foldSeries(series);
      const oldestPendingAt = series.length > 0 ? series[0].createdAt : null;
      const skip = this.evaluateTarget(t.channel, t.peer, t.sub, req, now, oldestPendingAt);
      if (skip) {
        result.skipped.push(skip);
        if (req.progress === 'milestone' && this.deferredPushes &&
          ['rate_limited', 'quiet_hours', 'channel_not_ready', 'allowance_reserved'].includes(skip.reason)) {
          const row = this.deferredPushes.enqueue({
            channel: t.channel, peer: t.peer, severity: req.severity,
            kind: req.kind, targetRef: req.targetRef, text: req.text,
            expiresAt: now + 24 * 60 * 60_000,
            folded: fold,
          }, now);
          result.deferred++;
          this.supersede(t.channel, t.peer, req, row.id);
        }
        continue;
      }
      const textToSend = fold ? req.text + renderFold(fold, langOfChannel(t.channel), now) : req.text;

      const channel = findPushChannel(t.channel);
      if (!channel) {
        result.skipped.push({
          channel: t.channel,
          peer: t.peer,
          reason: 'channel_not_found',
          detail: describePushChannelMiss(t.channel),
        });
        continue;
      }

      try {
        const sendResult = await channel.pushText(t.peer, textToSend);
        try { this.onSendOutcome?.(t.channel, sendResult.ok); } catch { /* observability must not break sends */ }
        if (sendResult.ok) {
          result.delivered += 1;
          anyDelivered = true;
          const silenceKey = `${t.channel}\u0000${t.peer}\u0000${req.kind}`;
          if (this.silenceDigestArmed.delete(silenceKey)) {
            this.lastSilenceDigestAt.set(silenceKey, now);
            this.opts.logger.log(`[push] ${req.kind}: silence digest delivered (${fold?.count ?? 0} folded report(s))`);
          }
          if (req.blocking === true) {
            // Its own floor, and deliberately NOT the routine budget: a question that stopped the work
            // must not make the next progress note wait an hour, nor be made to wait by one.
            // Keyed by KIND as well: prod 2026-09-10 23:13 the owner answered a budget card, the grant
            // re-armed the driver, the driver asked for workflow admission 59s later — and that second,
            // consequent card was rate_limited by the first. A storm is many of the SAME question.
            this.lastBlockingAt.set(`${t.channel}\u0000${t.peer}\u0000${req.kind}`, now);
          } else if (req.progress) {
            this.lastProgressAt.set(`${t.channel}\u0000${t.peer}\u0000${req.progress}`, now);
          } else if (req.severity === 'urgent') {
            this.opts.subscriptions.markUrgentSent(t.channel, t.peer, now);
          } else {
            this.opts.subscriptions.markDigestSent(t.channel, t.peer, now);
          }
          const stale = this.deferredPushes?.get(t.channel, t.peer, req.kind, req.targetRef);
          if (stale) this.deferredPushes?.markDelivered(stale.id);
          this.supersede(t.channel, t.peer, req);
        } else {
          if (sendResult.partiallyDelivered) result.partiallyDelivered += 1;
          // A heartbeat is about now. Delivered with the owner's next reply — prod 2026-09-13 23:13,
          // three "本轮已运行 5 分钟" from the previous evening under "此前未能送达的待办通知" — it is false.
          const deferrable = req.progress !== 'heartbeat';
          if (sendResult.retry === 'next_inbound' && this.deferredPushes && deferrable) {
            const row = this.deferredPushes.enqueue({
              channel: t.channel, peer: t.peer, severity: req.severity,
              kind: req.kind, targetRef: req.targetRef,
              text: sendResult.deferredText ?? req.text,
              expiresAt: now + (req.severity === 'urgent' ? 72 : 48) * 60 * 60_000,
            }, now);
            result.deferred += 1;
            this.supersede(t.channel, t.peer, req, row.id);
          } else {
            result.failed += 1;
          }
          this.opts.logger.warn(
            `[push] ${t.channel}:${t.peer} pushText returned failure` +
              (sendResult.retry === 'next_inbound' && this.deferredPushes && deferrable ? ' — deferred to next inbound' : '') +
              `: ${sendResult.error ?? 'unknown'}`,
          );
        }
      } catch (e) {
        // Channel implementations should not throw, but catch anyway as a safety net
        result.failed += 1;
        this.opts.logger.error(`[push] ${t.channel}:${t.peer} pushText threw`, e);
      }
    }

    // 5. If at least one target succeeded → record fingerprint (do not re-send same kind+targetRef within 24h)
    if (anyDelivered) {
      this.recordFingerprint(fp, now);
    }
    return this.finish(req, result);
  }

  /**
   * Single exit point, so every dispatch says what happened to it.
   *
   * Gates 4-9 of the owner funnel all live in here, and none of them reached the console: skip reasons
   * were returned to the caller, and the caller (the autonomy sink) only wrote an audit row when
   * `delivered > 0`. So a push that died in here left no trace anywhere a human looks. The 2026-07-14
   * funnel-visibility pass instrumented gates 1 and 3 and stopped at the dispatcher boundary; this is the
   * other half. Without it, relaxing gate 1 would just move the silence one gate to the right — and we
   * would be tuning a funnel we still could not watch.
   */
  private finish(req: PushRequest, result: DispatchResult): DispatchResult {
    if (result.delivered > 0 && result.skipped.length === 0 && result.failed === 0 && result.deferred === 0 && result.partiallyDelivered === 0) {
      this.opts.logger.log(`[push] ${req.kind} delivered to ${result.delivered} target(s)`);
      return result;
    }
    const why = result.skipped
      .map((s) => `${s.channel}:${s.peer}=${s.reason}${s.detail ? ` (${s.detail})` : ''}`)
      .join(', ');
    this.opts.logger.log(
      `[push-funnel] ${req.kind} (${req.severity}) → delivered=${result.delivered} partial=${result.partiallyDelivered} deferred=${result.deferred} failed=${result.failed}` +
        (why ? ` skipped=[${why}]` : ''),
    );
    return result;
  }

  /**
   * Determine whether a single target should be skipped.
   * Returns a SkipReason to skip, or null to proceed.
   */
  /** Series rule: this push makes older pending rows of its series obsolete (see PushRequest.supersedes). */
  private supersede(channel: string, peer: string, req: PushRequest, keepId?: string): void {
    if (!req.supersedes || !this.deferredPushes) return;
    try {
      const n = this.deferredPushes.discardSeries(channel, peer, req.kind, req.supersedes, keepId);
      if (n > 0) this.opts.logger.log(`[push] ${req.kind}: ${n} older pending report(s) superseded by the newest`);
    } catch (e) {
      this.opts.logger.warn(`[push] supersede failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Whether a pending series has waited long enough, with the owner silent, to earn the reserved slot. */
  private silenceDigestDue(channel: string, peer: string, kind: string, oldestPendingAt: number | null, now: number): boolean {
    const window = silenceDigestWindowMs();
    if (window <= 0 || oldestPendingAt === null) return false;
    if (now - oldestPendingAt < window) return false;
    const last = this.lastSilenceDigestAt.get(`${channel}\u0000${peer}\u0000${kind}`);
    return last === undefined || now - last >= window;
  }

  private evaluateTarget(
    channel: string,
    peer: string,
    sub: PushSubscription | null,
    req: PushRequest,
    now: number,
    oldestPendingAt: number | null = null,
  ): SkipReason | null {
    if (!sub || !sub.enabled) {
      return { channel, peer, reason: 'no_active_subscription' };
    }

    const lookupChannel = findPushChannel(channel);
    if (!lookupChannel) {
      return {
        channel,
        peer,
        reason: 'channel_not_found',
        detail: describePushChannelMiss(channel),
      };
    }
    if (!lookupChannel.isReady()) {
      return { channel, peer, reason: 'channel_not_ready' };
    }

    // Cheap talk yields to content when the peer's allowance runs low (HEARTBEAT_ALLOWANCE_RESERVE), and
    // routine reports yield the last slot to a blocking card (MILESTONE_ALLOWANCE_RESERVE).
    if (req.progress === 'heartbeat' || (req.progress === 'milestone' && req.blocking !== true)) {
      const reserve = req.progress === 'heartbeat' ? HEARTBEAT_ALLOWANCE_RESERVE : MILESTONE_ALLOWANCE_RESERVE;
      const a = lookupChannel.allowance?.(peer) ?? null;
      if (a && a.remaining <= reserve) {
        if (req.progress === 'milestone' && a.remaining >= 1 && this.silenceDigestDue(channel, peer, req.kind, oldestPendingAt, now)) {
          const waitedMin = Math.round((now - (oldestPendingAt ?? now)) / 60_000);
          this.opts.logger.log(
            `[push] ${req.kind}: owner silent with reports pending for ${waitedMin}min — spending the reserved slot on one digest (remaining=${a.remaining}/${a.total})`,
          );
          this.silenceDigestArmed.add(`${channel}\u0000${peer}\u0000${req.kind}`);
        } else {
          return { channel, peer, reason: 'allowance_reserved', detail: `remaining=${a.remaining}/${a.total}` };
        }
      }
    }

    // Frequency rate-limit. A blocking decision runs on its own short floor, kept in memory: losing it
    // on restart costs at most one extra card, and the alternative is a schema column for a counter
    // whose only job is to stop a storm.
    const blockingKey = `${channel}\u0000${peer}`;
    const lastAt = req.blocking === true
      ? (this.lastBlockingAt.get(`${blockingKey}\u0000${req.kind}`) ?? null)
      : req.progress ? (this.lastProgressAt.get(`${blockingKey}\u0000${req.progress}`) ?? null)
      : req.severity === 'urgent' ? sub.lastUrgentAt : sub.lastDigestAt;
    const interval = req.blocking === true
      ? BLOCKING_MIN_INTERVAL_MS
      : req.progress ? (req.progress === 'heartbeat' ? 5 * 60_000 : 60_000)
      : req.severity === 'urgent' ? sub.urgentMinIntervalMs : sub.digestMinIntervalMs;
    if (lastAt !== null && now - lastAt < interval) {
      return {
        channel,
        peer,
        reason: 'rate_limited',
        detail: `last=${lastAt} interval=${interval} since=${now - lastAt}`,
      };
    }

    // Quiet hours
    if (sub.quietStartHour !== null && sub.quietEndHour !== null) {
      const hour = currentHourIn(sub.timezone, now);
      if (isInQuietHours(hour, sub.quietStartHour, sub.quietEndHour)) {
        return {
          channel,
          peer,
          reason: 'quiet_hours',
          detail: `hour=${hour} quiet=[${sub.quietStartHour}-${sub.quietEndHour})`,
        };
      }
    }

    return null;
  }

  private isDuplicate(fp: string, now: number): boolean {
    // Lazily evict expired entries at the same time
    const fresh = this.dedupRing.filter((e) => e.expiresAt > now);
    this.dedupRing = fresh;
    return fresh.some((e) => e.fingerprint === fp);
  }

  private recordFingerprint(fp: string, now: number): void {
    this.dedupRing.push({ fingerprint: fp, expiresAt: now + DEDUP_TTL_MS });
    if (this.dedupRing.length > this.opts.dedupRingCap) {
      this.dedupRing.shift();
    }
  }

  /** For testing / debugging: return current ring size */
  dedupRingSize(): number {
    return this.dedupRing.length;
  }
}

function computeFingerprint(kind: string, targetRef: string): string {
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(targetRef)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Current hour (0-23) in the specified timezone. timezone null → UTC.
 *
 * Simplified implementation: uses Intl.DateTimeFormat to get the hour in the timezone.
 */
function currentHourIn(timezone: string | null, now: number): number {
  if (!timezone) {
    return new Date(now).getUTCHours();
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(now));
    const hourPart = parts.find((p) => p.type === 'hour');
    if (!hourPart) return new Date(now).getUTCHours();
    const h = parseInt(hourPart.value, 10);
    return Number.isFinite(h) && h >= 0 && h < 24 ? h : new Date(now).getUTCHours();
  } catch {
    return new Date(now).getUTCHours();
  }
}

/**
 * Whether the current hour falls in the [start, end) half-open interval.
 * Handles midnight-crossing correctly (when start > end).
 *
 * Example: [22, 7) means 22:00 through 06:59 the next day are quiet hours.
 */
export function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false; // zero-length interval
  if (start < end) {
    return hour >= start && hour < end;
  }
  // start > end: crosses midnight
  return hour >= start || hour < end;
}
