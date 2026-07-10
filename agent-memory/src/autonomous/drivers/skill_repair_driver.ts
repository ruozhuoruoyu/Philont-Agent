/**
 * SkillRepairDriver (H3) — proposes diagnosing + rewriting a demoted callable recipe.
 *
 * A recipe (verification + tool_policy present) demoted to 'playbook' by
 * `recordLinkedSkillOutcomes` (a reuse-verification failure — `skill_recipes.ts:recipeReuseMaturityMove`
 * returning `'demote_revise'`) sits there today with no follow-up. See docs/design/skill_self_repair.md.
 * This driver surfaces it as a candidate initiative. `propose` is pure (no DB writes, no LLM calls, no
 * tool execution) — matching every other `Driver`.
 *
 * Emits NO `plan`: unlike a gap/curiosity initiative, a repair's evidence is already local (the
 * execution ledger's failed runs for this recipe), so there is nothing to look up. The executor resolves
 * that evidence via `InitiativeExecutorOptions.skillRepairContext` and runs the same single-turn LLM call
 * every other initiative gets. Diagnosing a broken recipe is a bounded judgement, not an open research
 * question — routing it through `deep_explore` (multi-round, cross-day, resumable) would be the wrong
 * shape and would make the loop non-continuous, which is precisely what this feature exists to fix.
 *
 * The fix comes back on `InitiativeRunResult.skillRevision` and is applied by the `skillRevisionWriter`
 * OutcomeHook (`skill_revision_writer.ts`), mirroring how `pursuitProgressWriter` applies pursuit state.
 */

import type { Driver, InitiativeProposal, MemorySnapshot } from '../types.js';
import { isRepairCandidate, repairAttemptsExhausted, MAX_REPAIR_ATTEMPTS } from '../../skill_repair.js';

export interface SkillRepairDriverConfig {
  /**
   * Maximum candidates to produce per tick; default 3. Lower than GapDriver's 5: a repair rewrites a
   * reusable artifact, so a burst of them is a bigger blast radius than a burst of lookups — and there
   * should rarely be more than a couple of broken recipes at once.
   */
  maxProposals: number;
}

export const DEFAULT_SKILL_REPAIR_CONFIG: SkillRepairDriverConfig = {
  maxProposals: 3,
};

const DRIVER_NAME = 'skill_repair';

export class SkillRepairDriver implements Driver {
  readonly name = DRIVER_NAME;

  constructor(private readonly cfg: SkillRepairDriverConfig = DEFAULT_SKILL_REPAIR_CONFIG) {}

  propose(snap: MemorySnapshot): InitiativeProposal[] {
    const proposals: InitiativeProposal[] = [];

    for (const s of snap.skills) {
      if (!isRepairCandidate(s)) continue;
      if (repairAttemptsExhausted(s.revisionHistory)) continue;
      const targetRef = `skill:${s.name}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      const priorAttempts = s.revisionHistory.filter((r) => r.reason.startsWith('skill_repair:')).length;
      proposals.push({
        kind: 'skill_repair',
        driver: DRIVER_NAME,
        targetRef,
        rationale:
          `recipe "${s.name}" was demoted to playbook after failing its own reuse verification ` +
          `(${s.failureCount} failure(s) recorded); diagnose the failed trajectories and propose a fix` +
          (priorAttempts > 0 ? ` (attempt ${priorAttempts + 1}/${MAX_REPAIR_ATTEMPTS})` : ''),
        // A repair is a diagnosis task, not an urgent lookup — utility set moderate: real (a broken
        // recipe silently degrades to an advisory lesson forever otherwise) but never crowds out
        // higher-urgency gap-driver/curiosity-driver candidates in the same tick.
        utility: 0.55,
        // One single-turn LLM call over the recipe body + a handful of failed trajectories. No tools,
        // hence no plan — the executor reads the ledger directly (skillRepairContext).
        budgetEstimate: 2500,
      });
    }

    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }
}
