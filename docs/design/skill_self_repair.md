# Skill Self-Repair (H3) — from demote-and-forget to diagnose-and-rewrite

Status: IMPLEMENTED (P0–P2), shipped default-off behind `PHILONT_SKILL_REPAIR`. Author: ruozhuoruoyu.
The sequel to `skill_recipes.md` (H2): H2 built the verification contract that CATCHES a recipe that
stopped working; H3 closes the loop it left open — what happens after the catch. Anchored to real
`file:line`.

## 1. Why

`recipeReuseMaturityMove(verificationPassed): 'promote'|'demote_revise'` (`skill_recipes.ts:86-88`)
already fires today. Consumed at `reflector.ts:455`: on `demote_revise` it demotes the recipe's maturity
to `playbook` and writes a self-observation fact (`recordRecipeDecayObservation`,
`self_observation.ts:139-155` → `obs.recipe-decay`) — **and stops**. Nothing diagnoses *why* the recipe
failed, and nothing produces a better version. The signal SkillHone (Tencent/WeChat,
[arXiv:2606.08671](https://arxiv.org/abs/2606.08671)) is built around — decision history as an
optimization signal, diagnose → revise → evidence → outcome — is exactly the tail philont already
detects and then discards.

The pieces to close it already exist, each built for a different purpose: the trigger
(`recipeReuseMaturityMove`), the raw evidence (execution ledger + `linked_skill`), the diagnostic engine
(`deep_explore`), the scheduling harness (autonomous drivers), and the thrash guard
(`countSameRootCauseFailures`). This spec composes them. It does not add a fifth subsystem.

## 2. What exists (build on these)

- **The trigger.** `recipeReuseMaturityMove` (`skill_recipes.ts:86-88`), consumed at `reflector.ts:455`
  (`recordLinkedSkillOutcomes`, `reflector.ts:405-475`) — fires today; the "revise" outcome currently only
  demotes maturity and writes a note.
- **The evidence — half-wired.** `Action.linkedSkill` (`types.ts:123/133`), written at
  `chat-handler.ts:7762` when a `use_skill` call executes tools, persisted in `memory_actions.linked_skill`
  (`schema.ts:137-146`, already indexed: `idx_actions_skill ... WHERE linked_skill IS NOT NULL`). The link
  exists as data AND is indexed — only the query method is missing: the only consumer
  (`recordLinkedSkillOutcomes`) groups actions already loaded for the *current session*, never "every past
  failure of skill X across every session," which is what a diagnosis needs.
- **The scheduling harness.** `Driver{ name; propose(snap: MemorySnapshot): InitiativeProposal[] }`
  (`autonomous/types.ts:117-127`), pure. `MemorySnapshot` (`types.ts:92-110`) already carries `skills`.
  Registered in `AUTONOMOUS_DRIVERS` (`chat-handler.ts:2106-2143`), wired into `startAutonomousLoop`
  (`chat-handler.ts:2404-2412`) alongside `GapDriver` / `CuriosityDriver` / `PursuitDriver` — a fourth
  driver plugs in exactly the same way.
- **The diagnostic engine.** `deepExploreTool.execute({action:'start', goal, mode})`
  (`server/src/deep_explore.ts`, tool built at `chat-handler.ts:1894/1920`) is a plain async function,
  callable from server code outside the LLM tool-call path. `advanceSession` (`chat-handler.ts:1921`) is
  already driven by non-LLM code today via `createAutoAdvanceLoop` (`chat-handler.ts:2490-2495`) — "server
  code runs a multi-tick deep_explore session with nobody typing 'continue'" already ships. Pointing that
  same machinery at the agent's own recipe instead of an external question is new; the machinery is not.
- **The thrash guard.** `countSameRootCauseFailures` (`failure_signatures.ts:195-205`) +
  `CURIOSITY_STUCK_SUPPRESS_THRESHOLD` (`chat-handler.ts:2097-2140`) + `SessionDriveReflector` cooldown
  tuning (`drive_reflector.ts:106`). Note the codebase already has a *second*, separate same-root-cause
  ladder in `viability_gate.ts:236-242` (3/6/9 tiers for the plan-close gate) — this design reuses the
  curiosity-driver vocabulary and must not add a third.

## 3. Design

### 3.1 The two real gaps (no more)

1. **No skill revision history.** `updateSkill` (`skills.ts:471-497`) does a destructive
   `UPDATE ... WHERE name=?` — zero history retained. Without a before/after record, "did the rewrite
   actually help" is unmeasurable, which defeats the point of repairing at all.
2. **No queryable skill→failure linkage.** The `linked_skill` column and its index already exist; there is
   no `ActionLog.getBySkill()`. A diagnosis needs "all past failed executions of this skill," not "this
   session's actions."

Everything else below is composition, not new infrastructure.

### 3.2 The loop

1. **Trigger** (unchanged). `recipeReuseMaturityMove` returns `demote_revise` → `reflector.ts:455` demotes
   to `playbook`, writes `obs.recipe-decay`, exactly as today.
2. **Propose** (new `SkillRepairDriver implements Driver`). Each autonomous tick, scan
   `snapshot.skills` for recipes at `maturity==='playbook'` with `verification != null` (a demoted
   *recipe*, not a demoted prose lesson — see Decision 1) and repair-attempt count under the ceiling
   (3.3). Emit one `InitiativeProposal` per candidate, budget-estimated like the existing drivers.
3. **Diagnose** (the shared K8 executor — *not* `deep_explore`). The proposal carries **no `plan`**: the
   evidence is already local. `StandardExecutor` resolves it through the new
   `InitiativeExecutorOptions.skillRepairContext` callback, which reads the recipe body plus
   `ActionLog.getBySkill(skillName, {onlyFailed: true, limit: 5})` (`linked_skill` stores the skill's
   *name*, matching `recordLinkedSkillOutcomes`'s existing lookup convention), and renders a diagnosis
   prompt instead of the generic research prompt. One single-turn LLM call, zero tool calls.

   > **Why not `deep_explore`.** An earlier draft of this doc routed the diagnosis through
   > `deep_explore(start, mode:'formal')`. That was wrong on two counts. Mechanically, `deep_explore` is
   > not in the autonomous read-only tool whitelist, so the driver could never have run. More
   > fundamentally, `deep_explore` is a multi-round, cross-day, resumable session engine for *open
   > questions*; "given these failed runs and this recipe body, what is the root cause and the fix" is a
   > **bounded judgement over evidence already in hand**. Spawning long-lived reasoning sessions from a
   > per-tick idle loop would make the repair loop non-continuous — the exact property this feature
   > exists to add. A repair is the same shape as every other K8 initiative, and uses the same executor.
4. **Rewrite.** The fix returns on `InitiativeRunResult.skillRevision`; the `skillRevisionWriter`
   OutcomeHook (`autonomous/skill_revision_writer.ts`) calls
   `SkillStore.reviseRecipe(name, { actionTemplate, verification, reason: 'skill_repair:<initiative id>: <diagnosis>' })`.
   A dedicated method, not `updateSkill`, because a revision needs the append-only history bookkeeping
   every other `updateSkill` field does not, and always re-enters the maturity ladder at `'draft'` (has
   not yet re-earned trust), regardless of the demoted `'playbook'` state it came from. The executor
   never writes skill state itself — mirroring how `pursuitProgressWriter` applies pursuit state.
   **An inconclusive diagnosis omits `skillRevision` entirely**: the initiative still succeeds, and the
   recipe simply stays advisory. A guessed rewrite would silently re-arm a broken recipe for callable
   reuse, which is strictly worse than no rewrite.
5. **Re-verify** (unchanged). Next recall+reuse runs `recipeReuseMaturityMove` exactly as today — the loop
   closes without touching the verification mechanism itself.

### 3.3 Thrash guard

A skill rewritten and immediately failing again is the same shape `countSameRootCauseFailures` already
guards against elsewhere. Track repair attempts per skill; gate `SkillRepairDriver` proposals the way
`CuriosityDriver.isSystemStuck` gates re-engagement (3.3 in Decisions) — N consecutive failed repairs backs
off and surfaces a self-observation ("this recipe has failed repair 3 times, needs a look") instead of
silently looping. Reuse the existing cooldown/threshold vocabulary; do not add a third same-root-cause
ladder.

## 4. Decisions (recommended defaults — edit here)

1. **Repair-needed signal.** Reuse `maturity==='playbook' && verification != null` as the query, rather
   than a new boolean column — it is already exactly what `demote_revise` sets today.
2. **Revision history shape.** `revision_history: string | null` — a JSON array of
   `{at, actionTemplate, verification, reason}` snapshots — nullable column on `memory_skills`,
   append-only from the rewrite step. Inline JSON, not a join table (mirrors how `RecipeVerification`
   is already stored inline, not normalized out).
3. **Repair-attempt ceiling.** 3 repairs (counted from `revision_history` entries whose `reason` carries
   the `skill_repair:` marker — a manual edit never counts against it) excludes the skill from future
   `SkillRepairDriver` proposals. Reuses `skill_maturity.ts`'s own "consecutive failures ≥ 3" deprecation
   threshold instead of picking a new arbitrary number.
4. **Inconclusive diagnosis is a first-class outcome.** The prompt explicitly permits omitting
   `skillRevision`, and the parser drops a malformed one rather than failing the initiative. An unrepaired
   recipe stays demoted to advisory — strictly safer than a guessed rewrite that re-arms it for callable
   reuse. `compute_recheck` recipes (whose verification wraps pariGp/z3) are the case where a single-turn
   judgement is weakest; today they take the same path, and the honest answer is that a low-confidence
   diagnosis should decline. If dogfooding shows they systematically produce bad rewrites, gate that
   `verification.kind` out of the candidate set rather than escalating the whole loop's machinery.
5. **Consent.** No new ask, but the feature ships **default-off** (`PHILONT_SKILL_REPAIR`). Recipe
   *demotion* already happens automatically today with no owner approval; recipe *rewriting* is a strictly
   larger step — it is the only autonomous driver whose outcome mutates a reusable artifact — so it stays
   opt-in until dogfooding proves it out. Visible after the fact via `/autonomy` and `revision_history`.
   (Contrast: constitution amendments stay owner-ratified — this feature does not touch that boundary.)

## 5. Rollout

- **P0** — schema only: `revision_history` column (nullable, back-compat) + `ActionLog.getBySkill()` +
  `SkillStore.reviseRecipe()`. Zero behavior change (nothing calls `reviseRecipe` yet). Unit tests on the
  query and the revision-history bookkeeping. **Shipped**: `schema.ts` v34→v35, `actions.ts`,
  `skill_repair.ts` (types + `isRepairCandidate`/`repairAttemptsExhausted`), `skills.ts:reviseRecipe`.
- **P1** — `SkillRepairDriver.propose()` (pure, unit-tested against a fixture `MemorySnapshot`).
  **Shipped.** Initially written with a `plan: [{tool:'deep_explore'}]` and left unregistered; both were
  corrected in P2 (see the note in 3.2 — the driver now emits no plan at all).
- **P2** — **Shipped.** The loop is closed end to end, default-off:
  - `StandardExecutor` gained `skillRepairContext` (resolves the recipe body + its failed ledger runs) and
    renders a diagnosis prompt for `kind==='skill_repair'`; `ExecutorLlmOutput.skillRevision` /
    `InitiativeRunResult.skillRevision` carry the fix back. A stray `skillRevision` on a non-repair
    initiative is dropped; a missing repair context fails the initiative **before** any LLM call.
  - `skillRevisionWriter` OutcomeHook (`autonomous/skill_revision_writer.ts`) applies it via
    `reviseRecipe`, stamping `REPAIR_REASON_PREFIX` so `repairAttemptsExhausted` can enforce the ceiling.
  - `SkillRepairDriver` registered in `AUTONOMOUS_DRIVERS` behind `PHILONT_SKILL_REPAIR` (**default off**);
    the server re-checks `isRepairCandidate` at execution time, so a recipe repaired or deleted between
    propose and run is never rewritten.
  - Verified three ways, from cheapest to most real:
    1. **Segment unit tests** — `driver.propose` / executor `skillRepairContext` path / `applySkillRevision`
       each in isolation (`autonomous_drivers`, `autonomous_executor`, `skill_revision_writer` test files).
    2. **End-to-end pipeline, canned LLM** (`agent-memory/tests/skill_repair_loop.test.ts`) — a real DB + a
       real `startAutonomousLoop` tick drives driver→executor→OutcomeHook and asserts the recipe is actually
       rewritten, re-enters `draft`, the old version lands in `revision_history`, a repaired recipe stops
       being a candidate (proven by the reverse-control: demote it again → it reappears, so the "0 proposals"
       is not just 24h dedup), and the attempt ceiling trips after three. Also asserts an empty driver set
       leaves the recipe untouched (the substance of "default off"). A subprocess test on the server side
       (`server/tests/skill_repair_flag.test.ts`) asserts the driver is absent by default and present only
       under `PHILONT_SKILL_REPAIR=1` (env is read at module load, so this needs a fresh process, not a
       post-import env mutation).
    3. **Real-model dogfood, on demand** (`server/scripts/skill-repair-dogfood.ts`, `npm run
       skill-repair:dogfood`) — seeds a genuinely broken recipe into a throwaway in-memory DB and runs ONE
       real LLM diagnosis, printing before/after for eyeball judgement. This is the only check that answers
       "does a real model produce a *good* fix", which no canned test can.

- **Next (P3, not started)** — flip the default on once dogfood + production runs show repaired recipes
  measurably outperforming their prior version, which `revision_history` makes measurable for the first
  time. Until there is data, "does the rewrite actually help" is exactly the question the Rutgers/UNC survey
  flags as unanswered by every existing benchmark ("no benchmark evaluates evolution longitudinally") — so
  it must be answered from production, not asserted here.

## 6. Non-goals

A user-facing skill-versioning UI (no diff viewer, no rollback surface yet — the history is for the
reflector/audit, not a product surface); repairing prose-lesson skills (`kind='positive'` without a
`verification` — not callable recipes, nothing to re-verify); a third same-root-cause threshold ladder
(reuses the two that exist); changing `recipeReuseMaturityMove` or the maturity state machine themselves
(unchanged); constitution/identity self-modification (recipes are not identity — this stays a
skill-layer feature, not a WS3 constitution-layer one).
