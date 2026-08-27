/**
 * Failure signature extraction + same-root-cause failure clustering (2026-05-06).
 *
 * Serves the sameRootCauseFailures input for the reflection trigger. Semantics: the agent
 * repeatedly hits the same wall the same way (e.g. shell "command not found: rg" three times
 * in a row) = strong signal to trigger reflection, prompting the LLM to write a routing rule
 * "rg unavailable → switch to grep".
 *
 * Design tradeoffs:
 *   - **Lightweight**: no LLM calls, purely heuristic regex; same-root-cause detection may
 *     miss some cases (e.g. synonymous error words not collapsed) but never false-positives
 *     (mistaking unrelated failures for the same source)
 *   - **Cross-turn**: data source is memory_actions (all tool calls already persisted),
 *     not dependent on turn-local state
 *   - **Adjustable window**: caller provides sinceTs / limit; defaulting to the most recent
 *     30 tool calls is sufficient
 *
 * Signature format: `<toolName>:<errorClass>:<arg?>`
 *   - shell:cmd-not-found:rg
 *   - shell:permission-denied
 *   - webFetch:timeout
 *   - readFile:enoent
 *   - <tool>:other:<first 30 chars> (fallback)
 */

import type { Action } from './types.js';

/**
 * Extract failure signature from toolName + result text.
 * Input: result is ToolResult.output or the full text with a ⚠ failure prefix.
 *
 * Key error classes (priority high to low):
 *   1. cmd-not-found:<command>      shell tool command unreachable
 *   2. enoent / no-such-file        fs path does not exist
 *   3. permission-denied            insufficient permissions
 *   4. timeout                      timed out
 *   5. econnrefused                 connection refused
 *   6. eaddrinuse                   port already in use
 *   7. http-<status>                HTTP 4xx/5xx
 *   8. other:<first 30 chars>       fallback
 */
export function extractFailureSignature(
  toolName: string,
  resultText: string | null | undefined,
): string {
  const tool = (toolName || '<unknown>').trim() || '<unknown>';
  const text = (resultText ?? '').toString();
  const lower = text.toLowerCase();

  // A process handle is runtime-local and disappears on restart. This is lifecycle state, not a
  // repeated task failure; give it a stable signature so root-cause clustering can exclude it.
  if (tool === 'process' && /\[process-orphaned\]|process handle unavailable in this runtime/.test(lower)) {
    return `${tool}:orphaned`;
  }

  // 0. Tool-specific taxonomies take precedence over the generic patterns below — otherwise a
  //    pariGp/z3 error whose text happens to contain a 3-digit number / "timeout" / etc. gets
  //    mislabelled (observed: `pariGp:http-500`). Classify by the compute tool first so its errors
  //    stay in the `pariGp:gp-*` / `z3Verify:z3-error` families.
  if (tool === 'pariGp') {
    // These diagnostics are emitted by our own deterministic pre-checker, so their class is known at
    // the point of origin. Keep them out of gp-other instead of asking a later model to reconstruct
    // information the runtime already had.
    const declaredPrecheck = lower.match(/pari\/gp pre-check \[class=(gp-precheck-(?:paren|nested-braces|spanning))\]/)?.[1];
    if (declaredPrecheck) return `${tool}:${declaredPrecheck}`;
    if (/pari\/gp pre-check:[^\n]*(?:has no matching|\d+ unclosed ["'`]?[[({])/.test(lower)) {
      return `${tool}:gp-precheck-paren`;
    }
    if (/pari\/gp pre-check:[^\n]*nested \{ \} blocks/.test(lower)) {
      return `${tool}:gp-precheck-nested-braces`;
    }
    if (/pari\/gp pre-check:[^\n]*(?:spans multiple lines|spanning construct|line \d+ opens[^\n]*still unclosed)/.test(lower)) {
      return `${tool}:gp-precheck-spanning`;
    }
    if (/syntax error/.test(lower)) return `${tool}:gp-syntax`;
    if (/incorrect type/.test(lower)) return `${tool}:gp-type`;
    if (/variable name expected/.test(lower)) return `${tool}:gp-varname`;
    if (/too few arguments|too many arguments/.test(lower)) return `${tool}:gp-args`;
    if (/not a function in function call/.test(lower)) return `${tool}:gp-not-a-function`;
    if (/computation timed out|process killed/.test(lower)) return `${tool}:gp-timeout`;
    return `${tool}:gp-other`;
  }
  if (tool === 'z3Verify') {
    return `${tool}:z3-error`;
  }
  if (tool === 'leanCheck') {
    if (/\bsorry\b|\badmit\b/.test(lower)) return `${tool}:lean-sorry`;
    if (/unsolved goals/.test(lower)) return `${tool}:lean-unsolved`;
    if (/unknown identifier|unknown constant/.test(lower)) return `${tool}:lean-unknown`;
    if (/computation timed out|process killed|timeout/.test(lower)) return `${tool}:lean-timeout`;
    return `${tool}:lean-error`;
  }

  // 0b. Compute engines launched through the GENERIC shell/process tool (e.g. `gp script.gp`,
  //     `lean foo.lean`) otherwise fall through to the generic fallback and produce
  //     `shell:other:pari/gp script error…`. That signature (a) escapes the native compute
  //     families' exclusion from same_root_cause clustering and (b) gets mis-labelled MECHANICAL
  //     by isMechanicalFailure() because the raw text contains "script error" — so a shell-run gp
  //     dodged the escalation that a native pariGp run triggers (2026-06-22 fabrication post-mortem).
  //     Normalize to the native family so a compute run is handled identically either way.
  if (tool === 'shell' || tool === 'process') {
    if (/\bpari\/?gp\b|\bgp exited\b/.test(lower) || /\bgp\b[^]*script error/.test(lower)) {
      const declaredPrecheck = lower.match(/pari\/gp pre-check \[class=(gp-precheck-(?:paren|nested-braces|spanning))\]/)?.[1];
      if (declaredPrecheck) return `pariGp:${declaredPrecheck}`;
      if (/pari\/gp pre-check:[^\n]*(?:has no matching|\d+ unclosed ["'`]?[[({])/.test(lower)) {
        return `pariGp:gp-precheck-paren`;
      }
      if (/pari\/gp pre-check:[^\n]*nested \{ \} blocks/.test(lower)) {
        return `pariGp:gp-precheck-nested-braces`;
      }
      if (/pari\/gp pre-check:[^\n]*(?:spans multiple lines|spanning construct|line \d+ opens[^\n]*still unclosed)/.test(lower)) {
        return `pariGp:gp-precheck-spanning`;
      }
      if (/syntax error/.test(lower)) return `pariGp:gp-syntax`;
      if (/incorrect type/.test(lower)) return `pariGp:gp-type`;
      if (/variable name expected/.test(lower)) return `pariGp:gp-varname`;
      if (/computation timed out|process killed/.test(lower)) return `pariGp:gp-timeout`;
      return `pariGp:gp-other`;
    }
    if (/\blean\b[^]*(error|sorry|unsolved goals|unknown identifier)/.test(lower)) {
      if (/\bsorry\b|\badmit\b/.test(lower)) return `leanCheck:lean-sorry`;
      if (/unsolved goals/.test(lower)) return `leanCheck:lean-unsolved`;
      return `leanCheck:lean-error`;
    }
    if (/\bz3\b[^]*(error|unsupported)|smt2? parse error/.test(lower)) {
      return `z3Verify:z3-error`;
    }
  }

  // 1. shell command not found (common enough to warrant dedicated extraction)
  const cmdNotFound =
    lower.match(/command not found:?\s*(\S+)/) ??
    lower.match(/(\S+):\s*command not found/);
  if (cmdNotFound) {
    const cmd = cmdNotFound[1].replace(/[^a-zA-Z0-9._\-+]/g, '');
    return `${tool}:cmd-not-found:${cmd.slice(0, 30)}`;
  }

  // 2. ENOENT / file not found (same source in node fs / shell)
  if (/\benoent\b/i.test(lower) || /no such file or directory/i.test(lower)) {
    return `${tool}:enoent`;
  }

  // 3. Permission denied
  if (
    /\beacces\b/i.test(lower) ||
    /permission denied/i.test(lower) ||
    /operation not permitted/i.test(lower)
  ) {
    return `${tool}:permission-denied`;
  }

  // 4. Timeout (network / shell killed at default timeout both count)
  if (/\b(etimedout|timeout|timed out|killed at)\b/i.test(lower)) {
    return `${tool}:timeout`;
  }

  // 5. ECONNREFUSED
  if (/\beconnrefused\b/i.test(lower) || /connection refused/i.test(lower)) {
    return `${tool}:econnrefused`;
  }

  // 6. EADDRINUSE
  if (/\beaddrinuse\b/i.test(lower) || /address already in use/i.test(lower)) {
    return `${tool}:eaddrinuse`;
  }

  // 7. HTTP status — capture "HTTP 404" / "status: 500" / "404 not found"
  const httpStatus = lower.match(/\b(?:http\s+|status[:\s]+)?(4\d\d|5\d\d)\b/);
  if (httpStatus) {
    return `${tool}:http-${httpStatus[1]}`;
  }

  // 8. Fallback: take first 30 chars (strip ⚠ marker + excess whitespace)
  const stripped = text
    .replace(/^[⚠✓\s]+/, '')
    .replace(/^TOOL\s*FAILED:?\s*/i, '')
    .replace(/^Error:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  return `${tool}:other:${stripped.toLowerCase()}`;
}

/**
 * 2026-06-07: Two classes of recorded failures are NOT task-level recurring problems and were
 * causing the `same_root_cause_failures` reflection to fire as noise every turn:
 *
 *   (a) Exploratory-compute tools (pariGp / z3Verify) — trial-and-error compute probes run
 *       inside deep_explore. Their failures are normal exploration (a parallel change starts
 *       recording them to memory_actions), not the agent hitting a task wall.
 *   (b) Mechanism / deliberate-rejection signatures — plan_protocol_gate / in_turn_tool_block /
 *       autonomous_blacklist / research_before_retry are protocol-layer ON-PURPOSE stops, not
 *       the LLM hitting a wall. Mirrors the same exclusion in server/src/in_turn_reflection.ts.
 *
 * Both are filtered out of groupFailures (and therefore countSameRootCauseFailures) below.
 */
const EXCLUDED_FROM_ROOT_CAUSE = new Set<string>(['pariGp', 'z3Verify', 'leanCheck']);
// Mechanism / deliberate-rejection failures are recorded with result='rejected_by_<mechanism>'
// (plan_protocol_gate / autonomous_blacklist / research_before_retry / in_turn_reflection / ask_guard / …),
// which extractFailureSignature turns into `<tool>:other:rejected_by_<mechanism>`. These are on-purpose
// protocol stops, not the LLM hitting a task wall, so they must NOT count toward same_root_cause_failures.
// BUGFIX 2026-06-09: the previous pattern matched `:other:[<mechanism>` (a bracket form the real
// `rejected_by_` marker never produces) and named `in_turn_tool_block` (real marker is `in_turn_reflection`)
// — so it never matched, and these rejections leaked into the trigger as noise. Match the real marker.
const MECHANISM_REJECTION_RE = /:other:rejected_by_/i;

export interface FailureCounted {
  signature: string;
  count: number;
  /** Latest timestamp (epoch ms) hit by this signature; null means no time information */
  latestTs: number | null;
  /** Tool name of the first matching hit */
  toolName: string;
}

/**
 * Clusters a group of failure actions by signature and returns the max group count
 * (used by the reflection trigger decision).
 *
 * Input requirement: caller has already filtered for "recent failed tool calls" (success=false).
 * This function does not query DB / time windows itself.
 *
 * Returns 0 if there are no failures / no groups with ≥ 2 same-signature entries.
 */
export function countSameRootCauseFailures(
  failures: ReadonlyArray<Pick<Action, 'toolName' | 'result' | 'timestamp'>>,
): number {
  if (failures.length === 0) return 0;
  const groups = groupFailures(failures);
  let max = 0;
  for (const g of groups) {
    if (g.count > max) max = g.count;
  }
  return max;
}

/**
 * Detailed clustering (for testing / debugging). Returns all signature groups sorted by count descending.
 */
export function groupFailures(
  failures: ReadonlyArray<Pick<Action, 'toolName' | 'result' | 'timestamp'>>,
): FailureCounted[] {
  const map = new Map<
    string,
    { signature: string; count: number; latestTs: number | null; toolName: string }
  >();
  for (const f of failures) {
    // 2026-06-07: skip exploratory-compute tools + mechanism/deliberate-rejection signatures
    // (see EXCLUDED_FROM_ROOT_CAUSE / MECHANISM_REJECTION_RE) — not task-recurring failures.
    if (EXCLUDED_FROM_ROOT_CAUSE.has(f.toolName)) continue;
    const sig = extractFailureSignature(f.toolName, f.result);
    if (MECHANISM_REJECTION_RE.test(sig)) continue;
    if (sig === 'process:orphaned') continue;
    // A compute run launched via the generic shell/process tool normalizes to a
    // pariGp:/leanCheck:/z3Verify: signature (extractFailureSignature §0b). Exclude it from
    // same_root_cause clustering exactly like a native compute-tool call (whose toolName is
    // already excluded above) — exploratory compute probes are not task-recurring walls.
    if (/^(pariGp|z3Verify|leanCheck):/.test(sig)) continue;
    const existing = map.get(sig);
    if (existing) {
      existing.count += 1;
      if (
        f.timestamp != null &&
        (existing.latestTs === null || f.timestamp > existing.latestTs)
      ) {
        existing.latestTs = f.timestamp;
      }
    } else {
      map.set(sig, {
        signature: sig,
        count: 1,
        latestTs: f.timestamp ?? null,
        toolName: f.toolName,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
