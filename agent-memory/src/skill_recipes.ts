/**
 * Skill recipes (H2) — pure recipe model + the two decisions that make a skill a trustworthy, callable
 * recipe. See `docs/design/skill_recipes.md`. Recall (the demand side) shipped in db22ae5; this is the
 * supply side. Pure + dependency-free. P0 = the model + decisions; persisting `verification`/`tool_policy`
 * on the Skill row (a schema change) and the author-on-success hook are P1.
 */

export interface RecipeVerification {
  /** how "done correctly" is confirmed on reuse — the closed-loop check ("the mechanism that says no"). */
  kind: 'tool_result_ok' | 'assert' | 'compute_recheck';
  /** the check itself: a tool whose ✓ result confirms it, an expected shape, or a z3/pariGp re-check. */
  check: string;
}

export interface Recipe {
  name: string;
  /** when to use — task_signature / whenToUse (recall keys on this). */
  trigger: string;
  /** the tool sequence to follow (today's action_template). */
  steps: string;
  /** the tools this recipe is allowed to use (bounds the reuse). */
  toolPolicy: string[];
  /** the check that closes the loop; a recipe WITHOUT one is only an advisory prose lesson. */
  verification: RecipeVerification | null;
}

/**
 * A skill is a CALLABLE recipe (use_skill for EXECUTION) only if it carries a verification AND concrete
 * steps AND a tool policy. Without the verification it is an advisory lesson, not a recipe — reusing it
 * would be a leap of faith ("Skills compound" needs the closed loop).
 */
export function isCallableRecipe(r: Pick<Recipe, 'verification' | 'steps' | 'toolPolicy'>): boolean {
  return r.verification != null && r.steps.trim().length > 0 && r.toolPolicy.length > 0;
}

/** Tool names recovered (best-effort) from a plan's step prose to form a recipe's tool_policy. */
const TOOL_NAME_HINTS: readonly string[] = [
  'webSearch', 'webFetch', 'shell', 'readFile', 'writeFile', 'pariGp', 'z3Verify', 'leanCheck', 'magnitude',
  'deep_explore', 'search_notes', 'search_skills', 'get_fact', 'list_facts', 'store_fact', 'use_skill',
  'planAndExecute', 'schedule_reminder', 'reply_with_media', 'browser',
];

export interface RecipeAuthorInput {
  planId: string;
  /** the deliverable labels the plan declared (its spec). */
  deliverables: string[];
  /** the plan's step-template text (action_template) — scanned for tool names. */
  stepText: string;
}

/**
 * Author the recipe fields (verification + tool_policy) from a VERIFIED plan-close success (H2 P1). The
 * plan_close spec-coverage gate having passed IS the verification — an assertion that the declared
 * deliverables were covered; the tool policy is recovered best-effort from the step text. Pure.
 */
export function buildRecipeFields(
  input: RecipeAuthorInput,
): { verification: RecipeVerification; toolPolicy: string[] } {
  const toolPolicy = TOOL_NAME_HINTS.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(input.stepText));
  const check = input.deliverables.length
    ? `${input.deliverables.length} declared deliverable(s) covered: ${input.deliverables.slice(0, 6).join('; ')}`
    : `plan ${input.planId} closed success (spec-coverage gate passed)`;
  return { verification: { kind: 'assert', check: check.slice(0, 300) }, toolPolicy };
}

/**
 * Whether to author a recipe from a finished trajectory. Only from a LEDGER-VERIFIED success (S1 — never
 * from a narrated success, which could be fabricated) AND only when a verification check is present (so
 * the recipe is callable). Pure.
 */
export function shouldAuthorRecipe(trajectory: {
  /** plan_close('success') / deep_explore solved. */
  closedSuccessfully: boolean;
  /** the steps' results came from real tool ✓ in the execution ledger (S1), not from narration. */
  ledgerVerified: boolean;
  /** a verification check that confirms "done" is available to attach. */
  hasVerification: boolean;
}): boolean {
  return trajectory.closedSuccessfully && trajectory.ledgerVerified && trajectory.hasVerification;
}

/**
 * On REUSE, the recipe's verification is run; this maps the outcome to the next maturity move
 * (SkillClaw-style evolution — a recipe that stops working is caught by its own verification, not a human).
 */
export function recipeReuseMaturityMove(verificationPassed: boolean): 'promote' | 'demote_revise' {
  return verificationPassed ? 'promote' : 'demote_revise';
}
