/**
 * Skill self-repair (H3) — pure types + helpers for closing the `demote_revise` loop. See
 * `docs/design/skill_self_repair.md`. Pure + dependency-free, matching `skill_recipes.ts` (H2).
 */

import type { RecipeVerification } from './skill_recipes.js';

/**
 * One prior snapshot of a recipe's callable-recipe fields, captured by `SkillStore.reviseRecipe()`
 * immediately before it overwrites them. Append-only — `revision_history` is a `SkillRevision[]`.
 */
export interface SkillRevision {
  /** when this snapshot was superseded */
  at: number;
  actionTemplate: string;
  verification: RecipeVerification | null;
  toolPolicy: string[] | null;
  /** why it was revised (the diagnosis, or a short human-readable reason) */
  reason: string;
  /**
   * 2026-10-04: cumulative success/failure totals of the skill at the moment this version was superseded,
   * so each version's own record is reconstructible (see versionRecords). Absent on older snapshots.
   */
  successCount?: number;
  failureCount?: number;
}

/** Safe JSON parse for `revision_history` — malformed / NULL → [] (never throws). */
export function parseRevisionHistory(raw: string | null | undefined): SkillRevision[] {
  if (raw == null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SkillRevision[]) : [];
  } catch {
    return [];
  }
}

/**
 * Whether a skill is a candidate for repair: a demoted RECIPE (`playbook` maturity + still carries a
 * `verification`), not a demoted prose lesson (no `verification`, nothing to re-verify) and not a
 * recipe that is merely new (`draft`/`confirmed`/`stable` never entered `playbook` via demotion). Pure.
 */
export function isRepairCandidate(skill: {
  maturity: string;
  verification: unknown;
}): boolean {
  return skill.maturity === 'playbook' && skill.verification != null;
}

/**
 * Repair-attempt ceiling: reuses `skill_maturity.ts`'s own "consecutive failures >= 3" deprecation
 * threshold rather than inventing a new number (see docs/design/skill_self_repair.md Decision 3).
 */
export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * Whether a repair candidate has been tried too many times already and should be excluded from
 * further `SkillRepairDriver` proposals (thrash guard — see 3.3 in the design doc). Counts revisions
 * recorded while the skill was already a repair candidate at the time of that revision's `reason`
 * carrying the repair marker (see `REPAIR_REASON_PREFIX`); a revision from some other source (e.g. a
 * manual edit) does not count against the ceiling. Pure.
 */
export const REPAIR_REASON_PREFIX = 'skill_repair:';

export function repairAttemptsExhausted(revisionHistory: readonly SkillRevision[]): boolean {
  const attempts = revisionHistory.filter((r) => r.reason.startsWith(REPAIR_REASON_PREFIX)).length;
  return attempts >= MAX_REPAIR_ATTEMPTS;
}

// ── Keep-best revision acceptance (2026-10-04) ────────────────────────────────────────────────────
//
// Every 2026 skill-evolution result that held up accepted a rewrite only after comparing it with the
// version it replaced on the same work: SkillRevise (arXiv 2606.01139, "keep the best observed version
// within budget", SkillsBench 36.05 → 61.63), Skill-α's rollback reward (arXiv 2608.01678, original vs
// edited skill on an anchored query), RSEA's keep-better gate, and philont's own replay bench for repair
// lines. `reviseRecipe` was the one learned write path without this step: the rewrite went live and
// only the maturity ladder's "3 consecutive failures → deprecated" could ever undo it — by deprecating
// the skill, not by restoring the version that worked.
//
// The record of each version is already implicit in the counters: `successCount/failureCount` are
// cumulative, and each `SkillRevision` snapshot (since this change) carries the cumulative totals at the
// moment it was superseded, so version i's own record is totals_i − totals_{i−1}. The current version's
// record is the live totals minus the last snapshot's. Pure; the store applies the decision.

/** Minimum outcomes the CURRENT version must have before it is judged (same constant family as MAX_REPAIR_ATTEMPTS). */
export const KEEP_BEST_MIN_OUTCOMES = 3;
export const KEEP_BEST_REASON_PREFIX = 'keep_best_revert:';

export type KeepBestMode = 'shadow' | 'on' | 'off';

/** PHILONT_SKILL_KEEP_BEST: shadow (default: decide + report, never revert) | on (revert) | off. */
export function keepBestMode(): KeepBestMode {
  const v = (process.env.PHILONT_SKILL_KEEP_BEST ?? '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false' || v === 'no') return 'off';
  if (v === '1' || v === 'on' || v === 'true' || v === 'yes') return 'on';
  return 'shadow';
}

export interface VersionRecord {
  /** index into revisionHistory, or -1 for the current (live) version */
  index: number;
  successes: number;
  failures: number;
  /** Laplace-smoothed success rate (s+1)/(s+f+2) */
  rate: number;
}

export interface KeepBestDecision {
  action: 'keep' | 'revert' | 'not_applicable';
  /** why `not_applicable`/`keep` — for the shadow log */
  reason: string;
  current: VersionRecord | null;
  best: VersionRecord | null;
}

function laplace(s: number, f: number): number {
  return (s + 1) / (s + f + 2);
}

/**
 * Per-version records from the cumulative counters. Snapshots without totals (written before this change)
 * break the chain: versions at or before such a snapshot are not reconstructible and are skipped.
 */
export function versionRecords(skill: {
  successCount: number;
  failureCount: number;
  revisionHistory: readonly SkillRevision[];
}): VersionRecord[] {
  const out: VersionRecord[] = [];
  // totals at the START of the version being examined; null = unknown (an older snapshot had no totals)
  let prev: { s: number; f: number } | null = { s: 0, f: 0 };
  skill.revisionHistory.forEach((r, i) => {
    const has = typeof r.successCount === 'number' && typeof r.failureCount === 'number';
    if (has && prev) {
      const s = Math.max(0, r.successCount! - prev.s);
      const f = Math.max(0, r.failureCount! - prev.f);
      out.push({ index: i, successes: s, failures: f, rate: laplace(s, f) });
    }
    prev = has ? { s: r.successCount!, f: r.failureCount! } : null;
  });
  if (prev) {
    const p: { s: number; f: number } = prev;
    const s = Math.max(0, skill.successCount - p.s);
    const f = Math.max(0, skill.failureCount - p.f);
    out.push({ index: -1, successes: s, failures: f, rate: laplace(s, f) });
  }
  return out;
}

/**
 * Judge the live version against the best earlier version. Only a version installed by the repair driver
 * (last revision reason carries REPAIR_REASON_PREFIX) is judged — a version restored by keep-best is not
 * judged again against the one it displaced (no ping-pong), and a manual edit is the owner's call.
 */
export function keepBestDecision(
  skill: { verification: unknown; successCount: number; failureCount: number; revisionHistory: readonly SkillRevision[] },
  minOutcomes: number = KEEP_BEST_MIN_OUTCOMES,
): KeepBestDecision {
  const last = skill.revisionHistory.at(-1);
  if (skill.verification == null || !last) return { action: 'not_applicable', reason: 'not_a_revised_recipe', current: null, best: null };
  if (!last.reason.startsWith(REPAIR_REASON_PREFIX)) return { action: 'not_applicable', reason: 'live_version_not_from_repair', current: null, best: null };
  const records = versionRecords(skill);
  const current = records.find((r) => r.index === -1) ?? null;
  if (!current) return { action: 'not_applicable', reason: 'no_totals_on_snapshot', current: null, best: null };
  const priors = records.filter((r) => r.index >= 0 && r.successes + r.failures >= minOutcomes);
  if (priors.length === 0) return { action: 'not_applicable', reason: 'no_prior_version_with_enough_outcomes', current, best: null };
  const best = priors.reduce((a, b) => (b.rate > a.rate ? b : a));
  if (current.successes + current.failures < minOutcomes) return { action: 'keep', reason: 'current_version_under_min_outcomes', current, best };
  if (current.rate < best.rate) return { action: 'revert', reason: `current ${current.rate.toFixed(2)} < best ${best.rate.toFixed(2)}`, current, best };
  return { action: 'keep', reason: `current ${current.rate.toFixed(2)} ≥ best ${best.rate.toFixed(2)}`, current, best };
}
