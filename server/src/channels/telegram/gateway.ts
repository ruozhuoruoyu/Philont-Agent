/**
 * Telegram gateway — getUpdates long-polling loop
 *
 * Structure mirrors wechat ILinkGateway:
 *   1. Startup: load offset cursor
 *   2. Loop: getUpdates(offset, 30s) → process each update → dispatch → offset = max(update_id)+1 → persist
 *   3. Error back-off: 409 Conflict (another getUpdates running elsewhere) / network error → backoff;
 *      401 → stop (token invalid)
 *
 * Offset is persisted to ~/.philont/telegram/<botId>.offset to avoid reprocessing
 * already-acknowledged updates after a restart.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TelegramClient, TelegramUpdate } from './client.js';
import { createHash } from 'node:crypto';

const safeTelegramId = (value: string | number): string =>
  `tg_${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;

/** Normalised inbound event, passed to dispatch (same shape as wechat InboundEvent, self-contained per channel). */
export interface InboundEvent {
  fromUserId: string;
  /** Group chat id; empty string for DMs. */
  groupId: string;
  /** Reply-to chat id (DM = user, group = group). Telegram always replies via chat.id. */
  chatId: string;
  text: string;
  /** Telegram server send time (epoch seconds on wire), normalized to milliseconds. */
  sentAtMs?: number;
  fromUsername?: string;
}

export type InboundDispatcher = (e: InboundEvent) => Promise<void>;

export interface GatewayLogger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

export interface TelegramGatewayOptions {
  client: TelegramClient;
  dispatch: InboundDispatcher;
  botId: string;
  logger?: GatewayLogger;
  /** Long-poll server hold duration in seconds, default 30. */
  pollTimeoutSec?: number;
  /** Test/embedding override for durable offset storage. */
  offsetPath?: string;
}

const CONSOLE_LOGGER: GatewayLogger = {
  info: (m, meta) => console.log(`[telegram] ${m}`, meta ?? ''),
  warn: (m, meta) => console.warn(`[telegram] ${m}`, meta ?? ''),
  error: (m, meta) => console.error(`[telegram] ${m}`, meta ?? ''),
};

export class TelegramGateway {
  private readonly client: TelegramClient;
  private readonly dispatch: InboundDispatcher;
  private readonly logger: GatewayLogger;
  private readonly pollTimeoutSec: number;
  private readonly offsetPath: string;

  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private consecutiveErrors = 0;
  private readonly dispatchTails = new Map<string, Promise<void>>();
  private offsetCommitTail: Promise<void> = Promise.resolve();

  constructor(opts: TelegramGatewayOptions) {
    this.client = opts.client;
    this.dispatch = opts.dispatch;
    this.logger = opts.logger ?? CONSOLE_LOGGER;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    const dir = join(homedir(), '.philont', 'telegram');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.offsetPath = opts.offsetPath ?? join(dir, `${opts.botId}.offset`);
    this.offset = this.loadOffset();
  }

  /** Poll health for the push layer (mirrors the WeChat gateway's contract). */
  isHealthy(): boolean {
    return this.running && this.consecutiveErrors < 5;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info('gateway started (long-poll)', { offset: this.offset });

    this.consecutiveErrors = 0;
    while (this.running) {
      this.abort = new AbortController();
      let updates: TelegramUpdate[];
      try {
        updates = await this.client.getUpdates(this.offset, this.pollTimeoutSec, this.abort.signal);
        this.consecutiveErrors = 0;
      } catch (e) {
        if (!this.running) break;
        this.consecutiveErrors++;
        const err = e as Error & { code?: number };
        if (err.code === 401) {
          this.logger.error('token invalid (401), stopping gateway. Check TELEGRAM_BOT_TOKEN', {});
          this.running = false;
          break;
        }
        const isConflict = err.code === 409;
        const backoff = isConflict ? 5_000 : Math.min(2_000 * this.consecutiveErrors, 30_000);
        this.logger.warn(`getUpdates failed (${isConflict ? '409 conflict: another poller is running' : err.message})`, {
          consecutiveErrors: this.consecutiveErrors,
          backoffMs: backoff,
        });
        await this.sleep(backoff);
        continue;
      }

      const batch: Promise<void>[] = [];
      let nextOffset = this.offset;
      for (const u of updates) {
        // Advance cursor monotonically (ack even if this update has no text, otherwise we get stuck)
        if (u.update_id >= nextOffset) nextOffset = u.update_id + 1;
        const event = this.normalize(u);
        if (!event) continue;
        batch.push(this.enqueue(event));
      }
      this.offset = nextOffset;
      if (updates.length > 0) {
        const commitOffset = nextOffset;
        this.offsetCommitTail = this.offsetCommitTail
          .then(() => Promise.allSettled(batch))
          .then(() => this.saveOffset(commitOffset))
          .catch((e) => this.logger.warn(`offset persist after dispatch failed: ${String(e)}`, {}));
      }
    }
    await Promise.allSettled([...this.dispatchTails.values()]);
    await this.offsetCommitTail;
    this.logger.info('gateway stopped', {});
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private enqueue(event: InboundEvent): Promise<void> {
    const key = event.chatId;
    const previous = this.dispatchTails.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.dispatch(event))
      .catch((e) => {
        this.logger.error(`dispatch threw: ${String(e)}`, { fromUserId: safeTelegramId(event.fromUserId) });
      })
      .finally(() => {
        if (this.dispatchTails.get(key) === current) this.dispatchTails.delete(key);
      });
    this.dispatchTails.set(key, current);
    return current;
  }

  /** update → InboundEvent; returns null for non-text messages (skipped). */
  private normalize(u: TelegramUpdate): InboundEvent | null {
    const m = u.message;
    if (!m || !m.text || !m.from) return null;
    const chatId = String(m.chat.id);
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
    // Quoted reply: prepend a [quoted: …] prefix so the LLM knows the context.
    let text = m.text;
    const ref = m.reply_to_message;
    if (ref) {
      const refText = ref.text || ref.caption || '[media]';
      const quoted = refText.length > 200 ? refText.slice(0, 199) + '…' : refText;
      text = `[引用: ${quoted}]\n${text}`;
    }
    return {
      fromUserId: String(m.from.id),
      groupId: isGroup ? chatId : '',
      chatId,
      text,
      sentAtMs: typeof m.date === 'number' ? m.date * 1000 : undefined,
      fromUsername: m.from.username,
    };
  }

  private loadOffset(): number {
    try {
      const raw = readFileSync(this.offsetPath, 'utf-8').trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private saveOffset(offset = this.offset): void {
    try {
      writeFileSync(this.offsetPath, String(offset), 'utf-8');
    } catch (e) {
      this.logger.warn(`offset persist failed: ${String(e)}`, {});
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
