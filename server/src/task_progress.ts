/** Progress is observational: no extra model calls and no inferred proof success. */
export type ProgressKind = 'activity' | 'milestone' | 'heartbeat';
export type ProgressSink = (text: string, meta?: { kind: ProgressKind }) => void;

export function startProgressTicker(report: () => void, intervalMs = 5 * 60_000): () => void {
  const timer = setInterval(() => {
    try { report(); } catch (error) { console.warn('[progress] report failed', error); }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Preserve a slot for real milestones and leave the channel's final-response quota intact. */
export function createProgressRelay(deps: {
  send: (text: string) => Promise<boolean>;
  receipt: (kind: ProgressKind, delivered: boolean) => void;
  /**
   * 2026-09-21: the channel's say on whether a report of this kind may spend a message right now (a
   * metered peer's allowance). A refused heartbeat is simply dropped; a refused milestone stays in
   * `unsent` and rides the final reply. Absent ⇒ always allowed (the old behaviour).
   */
  canSend?: (kind: ProgressKind) => boolean;
  skipped?: (kind: ProgressKind, reason: string) => void;
}) {
  let attempts = 0;
  let heartbeats = 0;
  let pending = Promise.resolve();
  const unsent = new Set<string>();
  const seen = new Set<string>();
  const offer: ProgressSink = (text, meta) => {
    const kind = meta?.kind ?? 'activity';
    // Frequent tool labels must not consume the two messages reserved for actual reports.
    if (kind === 'activity' || !text.trim() || seen.has(text)) return;
    if (kind === 'milestone') unsent.add(text);
    if (deps.canSend && !deps.canSend(kind)) {
      deps.skipped?.(kind, 'allowance_reserved');
      return;
    }
    if (attempts >= 2 || (kind === 'heartbeat' && heartbeats >= 1)) return;
    attempts++;
    if (kind === 'heartbeat') heartbeats++;
    seen.add(text);
    pending = pending.then(async () => {
      let delivered = false;
      try { delivered = await deps.send(text); } catch { /* retain the milestone for the final reply */ }
      if (delivered) unsent.delete(text);
      deps.receipt(kind, delivered);
    });
  };
  return { offer, drain: async () => { await pending; return [...unsent]; } };
}
