/**
 * SkillRepairDriver (H3) — proposes diagnosing + rewriting a demoted callable recipe.
 *
 * A recipe (verification + tool_policy present) demoted to 'playbook' by
 * `recordLinkedSkillOutcomes` (a reuse-verification failure — `skill_recipes.ts:recipeReuseMaturityMove`
 * returning `'demote_revise'`) sits there today with no follow-up. See docs/design/skill_self_repair.md.
 * This driver surfaces it as a candidate initiative. `propose` is pure (no DB writes, no LLM calls, no
 * tool execution) — matching every other `Driver`.
 *
 * NOT YET WIRED into `AUTONOMOUS_DRIVERS` (server/src/chat-handler.ts) — see the design doc's P1/P2
 * split. The shared `InitiativeExecutor` writes back facts/notes on completion, not skill revisions;
 * actually closing the loop (running the `deep_explore` diagnosis this driver's `plan` points at, then
 * calling `SkillStore.reviseRecipe` on its outcome) needs a dedicated `OutcomeHook`, not yet built —
 * registering this driver today would spend real diagnosis budget with no rewrite ever happening.
 * Exported and fully unit-tested so that wiring is a deliberate follow-up decision, not an accidental
 * side effect of adding this file.
 */

import type { Driver, InitiativeProposal, MemorySnapshot } from '../types.js';
import { isRepairCandidate, repairAttemptsExhausted, MAX_REPAIR_ATTEMPTS } from '../../skill_repair.js';

export interface SkillRepairDriverConfig {
  /**
   * Maximum candidates to produce per tick; default 3. Lower than GapDriver's 5 — a repair is a
   * `deep_explore` diagnosis session, not a single tool call, so each candidate is far more expensive.
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
        budgetEstimate: 6000,
        plan: [
          {
            tool: 'deep_explore',
            params: {
              action: 'start',
              mode: 'formal',
              goal:
                `Diagnose why the recipe "${s.name}" failed its reuse verification and propose a fix. ` +
                `Current steps: ${s.actionTemplate}. ` +
                `Current verification: ${s.verification ? JSON.stringify(s.verification) : 'none'}.`,
            },
          },
        ],
      });
    }

    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }
}
