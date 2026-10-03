/**
 * Pre-call failure predictor (2026-10-03). Controller id: `failure_predictor`. SHADOW by default.
 *
 * Every other gate in philont is a POST-hoc check: it looks at a tool result or a drafted reply and
 * decides whether to regenerate, block or research. Nothing predicts, before a call is dispatched,
 * whether that call is about to fail. This module does, from the only signal that turned out to carry
 * the information: the agent's own recent failure streak.
 *
 * Evidence (philosophers exp 100, run on this product's exported action log — 27,528 calls, 63 tools,
 * 85.2% success; time-ordered 70/30 split): a logistic regression on
 *     tool identity + number of failures in the last 5 calls + in the last 20 + whether the last call of
 *     the same tool failed
 * predicts "this call will fail" with AUROC 89.8 against a per-tool base-rate AUROC of 82.7. Embeddings
 * of the call's content added nothing overall (they helped only inside shell / pariGp). Skipping calls
 * with P(success) < 0.5 would have removed 13% of calls, avoided 50% of failures and lost 5.5% of the
 * successful calls. The same study found that online stochastic-gradient training of this head needs
 * strong regularisation (alpha 1e-1 kept the second half of the stream at AUROC 87.9; alpha 1e-4 fell to
 * 48), which is why the learning rate and L2 below are deliberately conservative.
 *
 * Also from that study: an exact-action veto ("this (tool, params) failed in two sessions, never
 * succeeded → refuse it") caught ZERO repeats in this log — real tool traffic almost never re-issues the
 * same normalised call across sessions, and `command not found` did not occur at all. Failure here is a
 * property of the agent's STATE (it is in a failing streak), not of the call's content. So the predictor
 * conditions on state, and there is no veto table.
 *
 * What it does, per tool call, before dispatch:
 *   1. features = [1, onehot(tool), fails_last5/5, fails_last20/20, last_same_tool_failed]
 *   2. p_fail = sigmoid(w · x)           (w is a per-process logistic regression)
 *   3. SHADOW: record (tool, p_fail) and, once the real outcome is known, (p_fail, failed) — to a
 *      metrics counter and an optional audit sink. Drives nothing.
 *   4. After the outcome: one SGD step on this example (online, L2-regularised), and the streak
 *      buffers advance.
 *
 * Training on startup: `warmStart(actions)` replays the ledger in time order so the weights are not
 * cold on the first turn. Weights live in memory only; a restart re-warms from the ledger (cheap: one
 * pass over ≤ MAX_WARM_ROWS rows, no SQL beyond what ActionLog already exposes).
 *
 * Enforcement (`PHILONT_FAILURE_PREDICTOR=on`) is NOT implemented in this change. The honest sequence is
 * the one the learning judge followed: shadow until the logged (p_fail, outcome) pairs show the
 * calibration seen offline, then decide what a high p_fail should do (a hint to the model? a research
 * nudge? a skip?). A gate wired to an uncalibrated predictor is the "1022 rules, 0 validated" shape again.
 *
 * Env: PHILONT_FAILURE_PREDICTOR = shadow (default) | off.
 */

export type PredictorMode = 'shadow' | 'off';

export function failurePredictorMode(): PredictorMode {
  const v = (process.env.PHILONT_FAILURE_PREDICTOR ?? '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return 'off';
  return 'shadow';
}

/** A ledger row in time order; the subset of `Action` the predictor reads. */
export interface OutcomeRow {
  toolName: string;
  success: boolean;
  timestamp?: number;
}

export interface Prediction {
  /** Probability the call FAILS, in (0,1). */
  pFail: number;
  /** The feature vector used (for audit / tests). */
  features: number[];
  /** True when the tool was unseen at prediction time (its one-hot slot was just created). */
  coldTool: boolean;
}

export interface ShadowRecord {
  toolName: string;
  pFail: number;
  failed: boolean;
  sessionId?: string;
}

const MAX_WARM_ROWS = 20_000;
/** Conservative online step; the offline study needed strong regularisation to stay stable. */
const LEARNING_RATE = 0.05;
const L2 = 1e-3;
/** Bias + 3 streak features; tool one-hots are appended after these. */
const BASE_FEATURES = 4;

function sigmoid(z: number): number {
  if (z > 30) return 1 - 1e-13;
  if (z < -30) return 1e-13;
  return 1 / (1 + Math.exp(-z));
}

export class FailurePredictor {
  private readonly toolIndex = new Map<string, number>();
  private weights: number[] = new Array(BASE_FEATURES).fill(0);
  /** Most recent outcomes, newest last; bounded to 20. */
  private readonly recent: boolean[] = [];
  private readonly lastSameTool = new Map<string, boolean>();
  private seen = 0;
  private readonly sink?: (r: ShadowRecord) => void;

  constructor(opts: { sink?: (r: ShadowRecord) => void } = {}) {
    this.sink = opts.sink;
  }

  /** How many outcomes the predictor has learned from (warm-start rows included). */
  get examples(): number {
    return this.seen;
  }

  /** Replay a time-ordered slice of the ledger. Oldest first; rows beyond MAX_WARM_ROWS are skipped. */
  warmStart(rows: readonly OutcomeRow[]): void {
    const slice = rows.length > MAX_WARM_ROWS ? rows.slice(rows.length - MAX_WARM_ROWS) : rows;
    for (const r of slice) {
      const x = this.featurize(r.toolName);
      this.learn(x, !r.success);
      this.advance(r.toolName, r.success);
    }
  }

  /** Predict before dispatch. Pure w.r.t. the streak state (does not advance it). */
  predict(toolName: string): Prediction {
    const coldTool = !this.toolIndex.has(toolName);
    const x = this.featurize(toolName);
    let z = 0;
    for (let i = 0; i < x.length; i++) z += (this.weights[i] ?? 0) * x[i];
    return { pFail: sigmoid(z), features: x, coldTool };
  }

  /**
   * Observe the real outcome of the call that `predict` was called for. Records the shadow pair,
   * takes one online step, advances the streak buffers.
   */
  observe(toolName: string, success: boolean, prediction?: Prediction, sessionId?: string): void {
    const x = prediction?.features ?? this.featurize(toolName);
    const pFail = prediction?.pFail ?? sigmoid(x.reduce((s, v, i) => s + (this.weights[i] ?? 0) * v, 0));
    this.sink?.({ toolName, pFail, failed: !success, sessionId });
    this.learn(x, !success);
    this.advance(toolName, success);
  }

  /** The three streak features as the offline study defined them. */
  streak(toolName: string): { fails5: number; fails20: number; lastSameToolFailed: boolean } {
    const n = this.recent.length;
    const last5 = this.recent.slice(Math.max(0, n - 5));
    const last20 = this.recent.slice(Math.max(0, n - 20));
    return {
      fails5: last5.filter((ok) => !ok).length,
      fails20: last20.filter((ok) => !ok).length,
      lastSameToolFailed: this.lastSameTool.get(toolName) === false,
    };
  }

  private featurize(toolName: string): number[] {
    let idx = this.toolIndex.get(toolName);
    if (idx === undefined) {
      idx = this.toolIndex.size;
      this.toolIndex.set(toolName, idx);
      this.weights.push(0);
    }
    const s = this.streak(toolName);
    const x = new Array(BASE_FEATURES + this.toolIndex.size).fill(0);
    x[0] = 1;
    x[1] = s.fails5 / 5;
    x[2] = s.fails20 / 20;
    x[3] = s.lastSameToolFailed ? 1 : 0;
    x[BASE_FEATURES + idx] = 1;
    return x;
  }

  private learn(x: number[], failed: boolean): void {
    // Weight vector may have grown (new tool) since x was built; pad x with zeros for new slots.
    while (this.weights.length < x.length) this.weights.push(0);
    let z = 0;
    for (let i = 0; i < x.length; i++) z += this.weights[i] * x[i];
    const err = sigmoid(z) - (failed ? 1 : 0);
    for (let i = 0; i < this.weights.length; i++) {
      const xi = i < x.length ? x[i] : 0;
      // No L2 on the bias.
      const reg = i === 0 ? 0 : L2 * this.weights[i];
      this.weights[i] -= LEARNING_RATE * (err * xi + reg);
    }
    this.seen++;
  }

  private advance(toolName: string, success: boolean): void {
    this.recent.push(success);
    if (this.recent.length > 20) this.recent.shift();
    this.lastSameTool.set(toolName, success);
  }
}

/**
 * Area under the ROC curve of P(fail) against observed failures — the number the shadow phase has to
 * reproduce (offline: 89.8) before anyone wires an action to this predictor. Rank-based, ties averaged.
 */
export function auroc(records: readonly { pFail: number; failed: boolean }[]): number | null {
  const pos = records.filter((r) => r.failed).length;
  const neg = records.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...records].sort((a, b) => a.pFail - b.pFail);
  // Average ranks over ties.
  const ranks = new Array(sorted.length).fill(0);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].pFail === sorted[i].pFail) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  sorted.forEach((r, k) => {
    if (r.failed) sumPos += ranks[k];
  });
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}
