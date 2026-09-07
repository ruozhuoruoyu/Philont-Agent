/**
 * Per-turn context — `AsyncLocalStorage` wrapper that transparently passes sessionId
 * to tool calls.
 *
 * Why this is needed:
 *   A tool's execute signature is `(params) => Promise<Result>`, with no context arg.
 *   If a tool needs to know "which session is calling me" (e.g. replyWithMedia needs to
 *   decide which channel's peer to send to), there is currently no first-class channel
 *   for this. Adding a context arg to the Tool interface would touch agent-policy and all
 *   existing tools — a high-cost change.
 *
 *   AsyncLocalStorage is designed exactly for this scenario in Node: it attaches context
 *   to the entire async call chain, so tools can read the ALS without changing the Tool interface.
 *
 * Usage pattern:
 *   chat-handler wraps each handleChatSend body with `runInTurnContext(sid, () => ...)`;
 *   any deeply-nested async code within that turn can then call `currentSessionId()` and
 *   get the value. When a new channel entry is added (e.g. a future Telegram entry point)
 *   it reuses the same mechanism, independent of the specific channel.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProgressSink } from '../task_progress.js';

interface TurnContext {
  sessionId: string;
  signal?: AbortSignal;
  /** The current turn's Tier-2 progress sink (onStatus). Lets deeply-nested tools — e.g. the
   *  deep_explore sub-loop — surface milestone summaries to the user without threading the
   *  callback through the Tool interface. Undefined for turns started without one. */
  onStatus?: ProgressSink;
}

const als = new AsyncLocalStorage<TurnContext>();

/** Run an async function in the ALS scope of the given sessionId (+ optional per-turn onStatus). */
export function runInTurnContext<T>(
  sessionId: string,
  fn: () => Promise<T>,
  onStatus?: ProgressSink,
): Promise<T> {
  return als.run({ sessionId, onStatus }, fn);
}

/** The sessionId for the turn currently being processed; null if not inside a turn / web-ui direct connection without ALS wrapping. */
export function currentSessionId(): string | null {
  return als.getStore()?.sessionId ?? null;
}

/** Keep cancellation attached to the old async chain after a new turn starts. */
export function setCurrentTurnSignal(signal: AbortSignal): void {
  const context = als.getStore();
  if (context) context.signal = signal;
}

export function currentTurnSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}

export function assertTurnActive(): void {
  currentTurnSignal()?.throwIfAborted();
}

/** The current turn's onStatus progress sink, or null if none is in scope. */
export function currentTurnStatus(): ProgressSink | null {
  const context = als.getStore();
  if (!context?.onStatus) return null;
  return (text, meta) => { if (!context.signal?.aborted) context.onStatus?.(text, meta); };
}
