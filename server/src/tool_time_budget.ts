/**
 * A foreground tool must not be allowed to outlive the turn that is waiting for it.
 *
 * The shell tool's own description instructs the model to pass `timeout: 1200000` for an ML install and
 * `timeout: 1800000` for a model download. The turn's hard deadline is 20 minutes. Both advertised numbers
 * are at or above the entire turn, and nothing reconciled them — they were chosen in different files with
 * no reference to each other, which is the same defect `llmCallBudgetMs` fixed for the LLM call and that
 * nobody had fixed for the tools.
 *
 * Production 2026-09-09 shows both halves of the damage:
 *   22:07:58 turn starts → 22:27:58 `[turn] hit 1200000ms deadline` → the owner's entire reply is the
 *            string "turn exceeded 1200000ms hard deadline". Twenty minutes of work discarded.
 *   22:48:28 `shell timeout=600000` on a `lake build` → 22:58:28 SIGTERM at 600063ms. Ten minutes spent
 *            to learn nothing, because the build genuinely needs ~19 (a background `process` run in the
 *            same log finished the same build in 1134.4s and exited 0).
 *
 * So a foreground timeout is capped by what the turn actually has left, minus the wrap-up headroom the
 * loop reserves for writing the reply — the same headroom the loop's own clock guard uses, so the two
 * agree by construction rather than by coincidence.
 *
 * The model is TOLD when a clamp happened. A silently shortened timeout comes back as `killed=true`, and
 * the tool's own timeout hint then advises retrying with a *larger* value — turning one lost call into a
 * loop that cannot converge. And when the turn has no room left for a foreground call at all, the call is
 * refused with the mechanism that does work pointed at by name: `process` with action `spawn` outlives the
 * turn and its result can be collected on the next one.
 */

/** Below this a foreground call cannot finish anything useful; refuse rather than pretend. */
export const FOREGROUND_TOOL_FLOOR_MS = 30_000;

export type ToolTimeBudget =
  /** The turn has room for the timeout that was asked for (or none was asked for). */
  | { kind: 'unchanged' }
  /** The turn has room, but less than was asked for. */
  | { kind: 'clamped'; timeoutMs: number; requestedMs: number }
  /** The turn cannot host a foreground call of any useful length. */
  | { kind: 'no-room'; availableMs: number };

/**
 * How much wall clock a foreground tool may take, given what the turn has left.
 *
 * `remainingMs` is Infinity for callers with no turn (autonomous ticks, idle consolidation) — those are
 * not racing a deadline and are left alone.
 */
export function planToolTimeBudget(input: {
  requestedMs: number | undefined;
  remainingMs: number;
  headroomMs: number;
}): ToolTimeBudget {
  const { requestedMs, remainingMs, headroomMs } = input;
  // A caller with no turn passes Infinity and falls out of every branch below on its own — no special
  // case for it here, because a branch that cannot change an answer only hides the ones that can.
  const available = remainingMs - headroomMs;
  if (available < FOREGROUND_TOOL_FLOOR_MS) return { kind: 'no-room', availableMs: Math.max(0, available) };
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    return { kind: 'unchanged' };
  }
  if (requestedMs <= available) return { kind: 'unchanged' };
  return { kind: 'clamped', timeoutMs: Math.floor(available), requestedMs };
}

/** Which tools take a foreground wall-clock `timeout` this mechanism should govern. */
export function readRequestedTimeoutMs(input: unknown): number | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = (input as Record<string, unknown>).timeout;
  return typeof raw === 'number' ? raw : undefined;
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

/** What the model is told when its timeout was shortened. Appended to the tool's own output. */
export function clampNotice(clamped: { timeoutMs: number; requestedMs: number }): string {
  return (
    `\n\n[turn budget] timeout was reduced from ${clamped.requestedMs}ms to ${clamped.timeoutMs}ms — that is ` +
    `all this turn has left. If the command was cut short (killed=true), do NOT retry it here with a bigger ` +
    `timeout: this turn cannot host it. Start it with process(action:"spawn") and read the result next turn.`
  );
}

/** What the model is told when the turn has no room for a foreground call at all. */
export function noRoomError(toolName: string, availableMs: number): string {
  return (
    `NOT RUN: this turn has only ${seconds(availableMs)}s of working time left, which is not enough to run ` +
    `${toolName} in the foreground and still write you a reply. This is a time budget, not a failure and not ` +
    `a refusal. If the work is long-running, start it with process(action:"spawn") — a background process ` +
    `outlives the turn — and collect it with process(action:"status") next turn. Otherwise report what you ` +
    `already have and say this step is still pending.`
  );
}

/**
 * Does this tool take a foreground wall-clock timeout?
 *
 * Derived from the tool's own schema, so no tool name is written down here and the mechanism cannot rot
 * as tools are added. A tool with no `timeout` knob is not making a promise about how long it runs, and
 * refusing it for want of time would block cheap reads that finish in milliseconds.
 */
export function toolTakesForegroundTimeout(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const props = (schema as Record<string, unknown>).properties;
  if (!props || typeof props !== 'object') return false;
  const timeout = (props as Record<string, unknown>).timeout;
  return !!timeout && typeof timeout === 'object'
    && (timeout as Record<string, unknown>).type === 'number';
}
