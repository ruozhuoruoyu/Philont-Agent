/**
 * Controller registry (self-learning redesign, Phase 3a — 2026-07-15).
 *
 * philont accreted ~10 ad-hoc "gates", each hand-written when a specific failure mode was found
 * in production (fabricated completion, ungrounded citation, empty conclusion, doom-loop pitch, …).
 * They are NOT uniform: some return a verdict object, some a reminder string, some are pure
 * predicates. They fire at different points (answer-time regen, send-time block, per-tool decision,
 * phase transition) and are observable only as scattered `[gate] fired` console lines.
 *
 * This module is the FIRST step of §3.2 of docs/design/self_learning_redesign.md: consolidate the
 * gates behind a uniform, ENUMERABLE registry so (a) the whole "L3 guards" layer can be described
 * and counted as one system, and (b) a new failure mode registers a controller here instead of
 * someone hand-writing yet another bespoke gate.
 *
 * DELIBERATELY NON-BEHAVIOR-CHANGING. This registry does NOT run any gate's logic and does NOT sit
 * on any control-flow path. It is:
 *   1. a static CATALOG of descriptors (one `Controller` per existing gate), and
 *   2. a fire COUNTER that the existing gate call-sites call once at their existing fire point.
 * The gates keep their own detection code and their own call sites unchanged; the only edit at a
 * call site is a single `recordControllerFire(id)` line next to the `audit.append(..._fired)` that
 * was already there. Removing this module would restore byte-identical behavior.
 *
 * A `Controller` is an ADAPTER DESCRIPTOR, not a wrapper — because the gates are not uniform enough
 * to share one `evaluate()` signature without rewriting them (which Phase 3a explicitly must not do).
 * The uniform surface is therefore descriptive (`id` / `failureMode` / `describe()`) plus the shared
 * fire counter. Making the gates share one runtime interface is Phase 3b+ work, and the registry is
 * the seam that later work grows from.
 */

/** Where in the turn lifecycle a controller acts. */
export type ControllerLayer =
  | 'answer-time' // inspects the drafted reply before it is emitted; fires a bounded regen
  | 'send-time' // inspects an outbound human-facing message at the channel exit
  | 'tool-gate' // decides whether a single tool call may proceed this turn
  | 'phase'; // decides the next reasoning phase (deep_explore diverge/converge)

/** The runtime shape of the underlying gate — why it could not be wrapped in one uniform signature. */
export type ControllerShape =
  | 'regen' // detect() → truthy verdict → inject a directive + regenerate once (cap 1/turn)
  | 'block' // async verdict → withhold/replace the artifact
  | 'decide' // pure function returning the next state (not a pass/fail catch)
  | 'exempt-predicate'; // pure predicate; "fires" = denies an exemption, evaluated on every call

export interface ControllerSpec {
  /** Stable short id. Used as the metrics key suffix (`controller.fire.<id>`); never rename casually. */
  id: string;
  /** The production failure mode this controller catches, in one human-readable line. */
  failureMode: string;
  /** Source module (repo-relative), so the catalog points at the real code. */
  module: string;
  /** The primary detector/decider export in that module. */
  entry: string;
  layer: ControllerLayer;
  shape: ControllerShape;
  /** When it fires, in one line — the observable trigger condition. */
  firesWhen: string;
  /**
   * Whether a `recordControllerFire('<id>')` call is wired at the gate's fire point. Two gates are
   * enumerated but NOT fire-counted (see the specs): they are per-call deciders, not discrete failure
   * catches, so a "fire" count would be a call-volume metric, not a failure-mode metric.
   */
  countable: boolean;
  /** Env kill-switch for the gate, if any (documentation only; the registry does not read it). */
  envSwitch?: string;
}

export interface Controller extends ControllerSpec {
  /** One-paragraph human description assembled from the spec fields. */
  describe(): string;
}

/**
 * The catalog. One entry per existing gate. This is data, not code: the registry does not import the
 * gate modules (keeps it dependency-light and free of import cycles). Adding a new failure-mode
 * controller = adding a row here + a `recordControllerFire` line at its fire point.
 */
const SPECS: readonly ControllerSpec[] = [
  {
    id: 'honesty',
    failureMode:
      'claimed completion / execution / delivery / a size or memory fact with no tool evidence backing it (fabrication)',
    module: 'agent-memory/src/honesty_gate.ts',
    entry: 'evaluateHonesty',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen:
      'the drafted reply asserts an accomplished outcome but the turn\'s tool ledger does not support it (failures ≥ successes with a completion claim, unverified destructive op, memory/size/exec claim without a backing tool, …)',
    countable: true,
    envSwitch: 'PHILONT_HONESTY_SESSION / PHILONT_HONESTY_ANNOUNCE (branch toggles)',
  },
  {
    id: 'empty_conclusion',
    failureMode: 'made tool calls then gave the user no summary (empty or near-empty final text)',
    module: 'agent-memory/src/empty_conclusion_gate.ts',
    entry: 'evaluateEmptyConclusion',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen: '≥1 tool call this turn and final text is empty, or ≥3 tool calls and final text < 10 chars',
    countable: true,
  },
  {
    id: 'half_finished',
    failureMode:
      'slow task stopped mid-way with a "let me look first / I\'ll do it next" commitment and no real progress (the channel is fire-and-forget, so there is no next turn)',
    module: 'agent-memory/src/half_finished_gate.ts',
    entry: 'detectHalfFinishedTurn',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen:
      'mode=slow, a placeholder plan is still in draft, 0 successful plan_update_step this turn, no completion claim, and the reply contains a commitment-style phrase',
    countable: true,
    envSwitch: 'PHILONT_HALF_FINISHED_GATE',
  },
  {
    id: 'output_format',
    failureMode: 'long reply missing the required `## For User` section (the channel can only send a verbose fallback)',
    module: 'agent-memory/src/output_format_gate.ts',
    entry: 'evaluateOutputFormat',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen: 'final text > 500 chars and contains no `## 给用户` / `## For User` heading',
    countable: true,
    envSwitch: 'PHILONT_OUTPUT_FORMAT_GATE',
  },
  {
    id: 'citation_grounding',
    failureMode: 'cited a specific arXiv id (and its "results") that no retrieved source or user message backs — recalled from memory',
    module: 'server/src/citation_gate.ts',
    entry: 'detectUngroundedArxivCitation',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen: 'the reply asserts an arXiv id that appears in no user-role message (no web_fetch / web_search / read_file result, not user-supplied)',
    countable: true,
    envSwitch: 'PHILONT_CITATION_GATE',
  },
  {
    id: 'numeric_grounding',
    failureMode: 'reported an accomplished computation with numeric results when no compute/exec tool succeeded this turn (mathematical fabrication)',
    module: 'server/src/numeric_grounding_gate.ts',
    entry: 'detectUngroundedComputation',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen: 'the reply makes an accomplished-computation claim with result numbers but the tool ledger has 0 successful pariGp/z3Verify/leanCheck/shell/process results',
    countable: true,
    envSwitch: 'PHILONT_NUMERIC_GATE',
  },
  {
    id: 'viability',
    failureMode: 'pursuing a doomed / stalled reasoning goal and pitching "shall I continue?" as if progress were normal (false hope)',
    module: 'server/src/viability_gate.ts',
    entry: 'computeViability',
    layer: 'answer-time',
    shape: 'regen',
    firesWhen: 'the weighted stall/barrier/same-root-cause score yields a pivot / stop_and_report / intractable verdict for the active (or session-less doom) goal',
    countable: true,
    envSwitch: 'PHILONT_VIABILITY_GATE',
  },
  {
    id: 'conscience',
    failureMode: 'an outbound human-facing message would harm a person (defamation, doxxing, harm-enabling instructions, disinformation)',
    module: 'server/src/conscience_gate.ts',
    entry: 'runConscienceGate',
    layer: 'send-time',
    shape: 'block',
    firesWhen: 'the (opt-in, fail-open) safety judge returns an explicit BLOCK verdict at a channel send chokepoint (WeChat / Telegram)',
    countable: true,
    envSwitch: 'PHILONT_CONSCIENCE_GATE',
  },
  // ── Enumerated but NOT fire-counted (see `countable: false`) ────────────────────────────────────
  // These two are per-call DECIDERS, not discrete failure catches. Counting their "fires" would be a
  // call-volume metric (every tool call / every reasoning round), not a failure-mode metric, so the
  // fire counter would be meaningless. They are registered here so the L3-guard layer is fully
  // enumerable, but instrumenting them is deferred to Phase 3b when the runtime interface is unified.
  {
    id: 'plan_protocol',
    failureMode: 'a world-changing tool (write / execute / network) called before the plan contract is in place',
    module: 'server/src/plan_gate.ts',
    entry: 'isPlanGateExempt',
    layer: 'tool-gate',
    shape: 'exempt-predicate',
    firesWhen: 'a non-exempt tool is requested while the plan is not in an executing state (evaluated on EVERY tool call — a decision, not a rare catch)',
    countable: false,
    envSwitch: 'PHILONT_PLAN_GATE_EXEMPT_READONLY',
  },
  {
    id: 'phase',
    failureMode: 'deep_explore converges too early (destroying the candidate space) or diverges forever on a rich topic',
    module: 'server/src/phase_gate.ts',
    entry: 'decidePhaseTransition',
    layer: 'phase',
    shape: 'decide',
    firesWhen: 'end of each deep_explore round, deciding the next phase (diverge/converge) — a control decision, not a failure catch',
    countable: false,
    envSwitch: 'PHILONT_DEEP_EXPLORE_PHASES',
  },
];

function makeController(spec: ControllerSpec): Controller {
  return {
    ...spec,
    describe(): string {
      return (
        `[${spec.id}] ${spec.failureMode}\n` +
        `  layer=${spec.layer} shape=${spec.shape} countable=${spec.countable}\n` +
        `  fires when: ${spec.firesWhen}\n` +
        `  source: ${spec.module} → ${spec.entry}` +
        (spec.envSwitch ? `\n  env: ${spec.envSwitch}` : '')
      );
    },
  };
}

const CONTROLLERS: readonly Controller[] = SPECS.map(makeController);
const BY_ID: ReadonlyMap<string, Controller> = new Map(CONTROLLERS.map((c) => [c.id, c]));

/** All registered controllers, in catalog order. */
export function listControllers(): readonly Controller[] {
  return CONTROLLERS;
}

/** Look up a controller by id (undefined if unknown). */
export function getController(id: string): Controller | undefined {
  return BY_ID.get(id);
}

/** Whether an id is a registered controller. */
export function isKnownController(id: string): boolean {
  return BY_ID.has(id);
}

/** A multi-line human-readable catalog of every registered controller. */
export function describeControllers(): string {
  return CONTROLLERS.map((c) => c.describe()).join('\n\n');
}

// ── Fire counting ───────────────────────────────────────────────────────────────────────────────
//
// A single per-controller counter, kept BOTH in-process (so it is testable without a DB) AND, when a
// sink is wired at bootstrap, forwarded to the persisted MetricsStore under key `controller.fire.<id>`.
// The sink is the MetricsStore's `increment` surface, kept as a minimal interface so this module does
// not import agent-memory (no import cycle) and tests can inject a fake.

export interface ControllerFireSink {
  increment(key: string, n?: number): void;
}

const inProcessFires = new Map<string, number>();
let fireSink: ControllerFireSink | null = null;

/** Metric key for a controller's fire counter. */
export function fireMetricKey(id: string): string {
  return `controller.fire.${id}`;
}

/**
 * Wire the persisted counter sink (the MetricsStore). Called once at bootstrap. Optional: if never
 * called, fires are still tracked in-process (enough for tests and for `controllerFireSnapshot`).
 */
export function setControllerMetrics(sink: ControllerFireSink | null): void {
  fireSink = sink;
}

/**
 * Record that a controller fired. Called by the existing gate call-site at its existing fire point
 * (next to the `audit.append(..._fired)` it already writes). Never throws — instrumentation must not
 * affect control flow. An unknown id is counted but warned about (a typo should be visible, not silent).
 */
export function recordControllerFire(id: string, n = 1): void {
  try {
    if (!BY_ID.has(id)) {
      console.warn(`[controller-registry] recordControllerFire got unknown id="${id}" (still counted)`);
    }
    inProcessFires.set(id, (inProcessFires.get(id) ?? 0) + n);
    fireSink?.increment(fireMetricKey(id), n);
  } catch (e) {
    console.warn(`[controller-registry] recordControllerFire(${id}) failed, ignored:`, (e as Error)?.message);
  }
}

/** In-process fire count for one controller since process start (0 if it never fired). */
export function getControllerFireCount(id: string): number {
  return inProcessFires.get(id) ?? 0;
}

/** Snapshot of all in-process fire counts, id → count (only ids that fired at least once). */
export function controllerFireSnapshot(): Record<string, number> {
  return Object.fromEntries(inProcessFires);
}

/** Reset the in-process counters. Test-only; does not touch the persisted MetricsStore. */
export function resetControllerFires(): void {
  inProcessFires.clear();
}

/**
 * Log the registered controllers at startup, so the whole L3-guard layer is visible as one system in
 * the production log (the point of §3.2). One-line summary + the countable/enumerated split.
 */
export function logRegisteredControllers(log: (msg: string) => void = console.log): void {
  const countable = CONTROLLERS.filter((c) => c.countable).map((c) => c.id);
  const enumerated = CONTROLLERS.filter((c) => !c.countable).map((c) => c.id);
  log(
    `[controller-registry] ${CONTROLLERS.length} controllers registered; ` +
      `fire-counted: ${countable.join(', ')}; ` +
      `enumerated-only: ${enumerated.join(', ')}`,
  );
}
