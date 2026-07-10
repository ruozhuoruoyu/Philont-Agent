/**
 * SkillRevisionWriter (H3) — applies a `skill_repair` initiative's diagnosed fix to the skill library.
 *
 * This is the last hop of the self-evolution loop: a callable recipe fails its own reuse verification
 * (`recipeReuseMaturityMove` → `'demote_revise'`, applied by `recordLinkedSkillOutcomes`), the
 * SkillRepairDriver proposes a diagnosis, the executor's single-turn LLM reads the ledger's real failed
 * executions and proposes corrected steps — and this hook writes them back via `SkillStore.reviseRecipe`,
 * which snapshots the outgoing version into `revision_history` and re-enters the recipe at `'draft'` so it
 * must re-earn trust through real reuse. Without this hook the loop ends at "demoted and forgotten".
 *
 * Mirrors `pursuit_progress_writer.ts`: the executor never writes skill state itself; it returns the
 * proposal on InitiativeRunResult and the loop's OutcomeHook applies it. See docs/design/skill_self_repair.md.
 */

import type { SkillStore } from '../skills.js';
import { REPAIR_REASON_PREFIX } from '../skill_repair.js';
import { parseSkillTargetRef } from './executor.js';
import type { Initiative, InitiativeRunResult, OutcomeHook } from './types.js';

export interface ApplySkillRevisionResult {
  applied: boolean;
  reason:
    | 'wrong_driver'
    | 'not_done'
    | 'no_revision_proposed'
    | 'unparseable_target'
    | 'skill_not_a_recipe'
    | 'applied';
}

/** Driver name emitted by SkillRepairDriver; only its initiatives may rewrite a skill. */
const SKILL_REPAIR_DRIVER = 'skill_repair';

/**
 * Applies one done skill_repair initiative to the skill library. Synchronous, pure DB write, no LLM.
 * Does not throw — every rejection path returns a reason so the caller can decide whether to log.
 */
export function applySkillRevision(
  skills: SkillStore,
  initiative: Initiative,
  result: InitiativeRunResult,
): ApplySkillRevisionResult {
  if (initiative.driver !== SKILL_REPAIR_DRIVER) {
    return { applied: false, reason: 'wrong_driver' };
  }
  if (result.status !== 'done') {
    return { applied: false, reason: 'not_done' };
  }
  // The diagnosis was inconclusive. The recipe stays demoted (advisory) — strictly safer than
  // re-arming a broken recipe for callable reuse on a guess. Not an error.
  if (!result.skillRevision) {
    return { applied: false, reason: 'no_revision_proposed' };
  }

  const skillName = parseSkillTargetRef(initiative.targetRef);
  if (!skillName) {
    return { applied: false, reason: 'unparseable_target' };
  }

  const { actionTemplate, verification, diagnosis } = result.skillRevision;
  // `skill_repair:<initiative id>` — the marker `repairAttemptsExhausted` counts to enforce the
  // repair-attempt ceiling, so a recipe that resists three diagnoses stops being proposed.
  const reason = `${REPAIR_REASON_PREFIX}${initiative.id}: ${diagnosis}`.slice(0, 500);

  const revised = skills.reviseRecipe(skillName, {
    actionTemplate,
    ...(verification ? { verification } : {}),
    reason,
  });
  // reviseRecipe returns null when the skill vanished or is not a callable recipe (verification
  // cleared between propose and now) — never overwrite a prose lesson through this path.
  if (!revised) {
    return { applied: false, reason: 'skill_not_a_recipe' };
  }
  return { applied: true, reason: 'applied' };
}

/**
 * Factory: binds SkillStore to produce an OutcomeHook.
 * AutonomousLoop calls it after an initiative is persisted; failures are logged, never thrown.
 */
export function skillRevisionWriter(
  skills: SkillStore,
  logger?: { log: (m: string) => void; warn: (m: string) => void },
): OutcomeHook {
  const log = logger ?? {
    log: (m) => console.log(`[skill-repair] ${m}`),
    warn: (m) => console.warn(`[skill-repair] ${m}`),
  };
  return (initiative, result) => {
    try {
      const r = applySkillRevision(skills, initiative, result);
      if (r.applied) {
        log.log(`revised recipe ${initiative.targetRef} (initiative=${initiative.id}) → draft, history appended`);
      } else if (r.reason === 'no_revision_proposed') {
        log.log(`diagnosis inconclusive for ${initiative.targetRef}; recipe stays advisory`);
      } else if (r.reason === 'skill_not_a_recipe' || r.reason === 'unparseable_target') {
        log.warn(`could not apply revision for ${initiative.targetRef}: ${r.reason}`);
      }
    } catch (e) {
      log.warn(`applySkillRevision threw for ${initiative.targetRef}: ${String(e)}`);
    }
  };
}
