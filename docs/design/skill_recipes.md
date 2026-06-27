# Skill Recipes (H2) — verified callable recipes authored from successful trajectories

Status: DESIGN. Author: ruozhuoruoyu.
The supply side of skills. Recall (the demand side) is done — see `skill_recall_consolidation.md`
(commit db22ae5). Anchored to real `file:line`.

## 1. Why

Loop engineering: **"Skills compound; prompts burn"** — a named skill (recipe = prompt + tool policy +
verification) gets cheaper every reuse; an ad-hoc prompt re-derives logic each cycle. Today philont's
skills come from REFLECTION distillation (`idle_consolidator` reflector → action templates) — they are
prose lessons, NOT callable verified recipes, and they carry no "definition of done" so reusing one is a
leap of faith. The frontier (e.g. SkillClaw — skills evolve collectively, verified on reuse) authors
recipes from SUCCESS and lets them evolve.

## 2. What exists (build on these)

- `SkillStore` + `Skill` (action_template, kind positive/negative, maturity draft→confirmed→stable→
  playbook) + the `skill_maturity` state machine (`recordSkillOutcome`).
- `plan_close('success')` and deep_explore `solved`/`finalize` — the moments a trajectory is KNOWN good.
- The execution-ledger (S1) — the source of truth for "did this recipe's steps actually succeed".
- Recall (db22ae5) — surfaces relevant skills by task; a recipe just needs to BE a good skill.

## 3. Design — a recipe is a skill with a verification contract

Extend `Skill` (no new entity) with the recipe parts that make reuse trustworthy:
- **trigger** — `whenToUse` + `task_signature` (already exist; recall keys on them).
- **steps** — the tool sequence (today's `action_template`, but structured enough to follow).
- **tool-policy** — the whitelist the recipe is allowed to use (bounds the reuse).
- **verification** (NEW) — a check that says "done correctly", e.g. a test/assert, an expected
  tool-result shape, a z3/pariGp re-check. A recipe WITHOUT a verification stays a prose lesson, not a
  callable recipe. The verification is what makes the loop closed (write→run→**read result→confirm**).

## 4. Authoring — promote a verified success into a recipe

- **Trigger to author**: `plan_close('success')` with its steps having passed their checks, OR a
  deep_explore solve, OR a repeated successful tool sequence detected in the ledger. (Not from a single
  narrated success — from a LEDGER-verified one; ties to S1.)
- **What gets captured**: the task_signature (trigger), the actual successful tool sequence (steps,
  read from the ledger, not the narrative), the whitelist used (tool-policy), and the success check that
  passed (verification).
- Starts `maturity='draft'`; promoted to `confirmed`/`stable` by the existing state machine on repeated
  successful reuse; **demoted/revised when it fails its OWN verification on reuse** (SkillClaw-style
  evolution — a recipe that stops working is caught by its verification, not by a human).

## 5. How it composes

- **Recall (db22ae5)** surfaces the right recipe by task relevance — the demand side already shipped.
- **Goal-loops (S2)** — a loop tick can call a recipe instead of re-deriving steps; recipes make loops
  compound (cheaper each tick) — the whole "skills compound" point, realized inside the spine.
- **S1 (ledger)** — both the AUTHOR source (verified steps) and the REUSE check (did the recipe's steps
  succeed this time).
- **Negative recipes** — the existing anti-pattern skills (kind='negative') are the dual: "recipe for
  what NOT to do". Recall already injects them; authoring from FAILURE (plan_close('failure')) already
  feeds playbooks.

## 6. Decisions (recommended defaults — edit here)

1. **Verification requirement.** A skill may be authored as a prose lesson (today's behavior) OR a
   callable recipe; only recipes WITH a verification are marked callable/`use_skill`-pullable for
   execution. Recommend: gate "callable recipe" on having a verification; lessons stay advisory.
2. **Author source.** Only from LEDGER-verified successes (S1), never from narrated success — prevents
   authoring a recipe from a fabricated trajectory.
3. **Evolution.** Reuse runs the recipe's verification; pass → bump maturity; fail → demote + flag for
   revision. No silent persistence of a recipe that stopped working.

## 7. Rollout (after recall db22ae5; can precede or follow S2)

- **P0** extend the Skill schema with `verification` + `tool_policy` (nullable; back-compat — existing
  skills have none and stay prose lessons). Unit tests on the recipe shape + the callable gate.
- **P1** author-on-success hook: `plan_close('success')` / deep_explore solve → propose a draft recipe
  from the ledger-verified steps; behind `PHILONT_SKILL_RECIPES` default off → dogfood.
- **P2** verification-on-reuse + maturity evolution (SkillClaw-style).

## 8. Non-goals

Replacing reflection-distilled lessons (they stay as advisory skills); authoring from narrated/unverified
success; a separate recipe store (recipes ARE skills); changing recall (db22ae5 already surfaces them).
