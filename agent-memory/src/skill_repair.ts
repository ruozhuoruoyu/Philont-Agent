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
