# Skill Self-Repair (H3) — from demote-and-forget to diagnose-and-rewrite

Status: DESIGN. Author: ruozhuoruoyu.
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
3. **Diagnose** (reuse `deep_explore`, don't rebuild reasoning). When the proposal runs: fetch failed
   trajectories via `ActionLog.getBySkill(skillName, {onlyFailed: true, limit})` (`linked_skill` stores the
   skill's *name*, matching `recordLinkedSkillOutcomes`'s existing lookup convention), then call
   `deepExploreTool.execute({ action:'start', mode:'formal', goal: <diagnosis prompt: failed
   trajectories + current recipe body + its verification> })`. "Why did this recipe fail, and what should
   the corrected steps/verification be" is the same shape of task `deep_explore` already handles for open
   questions — this points it at the agent's own artifact instead.
4. **Rewrite.** On a `solved`/`finalize` outcome, extract the proposed revision and call
   `SkillStore.reviseRecipe(name, { actionTemplate, verification, reason: `skill_repair:<session id>` })` —
   a dedicated method (shipped in P0), not `updateSkill`, because a revision needs the append-only history
   bookkeeping every other `updateSkill` field does not, and always re-enters the maturity ladder at
   `'draft'` (has not yet re-earned trust), regardless of the demoted `'playbook'` state it came from.
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
3. **Repair-attempt ceiling.** 3 consecutive failed repairs excludes the skill from future
   `SkillRepairDriver` proposals and raises a `recordRecipeDecayObservation`-style self-fact for the owner
   (visible in `/autonomy`). Reuses `skill_maturity.ts`'s own "consecutive failures ≥ 3" deprecation
   threshold instead of picking a new arbitrary number.
4. **Diagnosis mode.** `deep_explore` `formal`, not `deliberate` — "does this tool sequence actually work"
   is machine-checkable, closer to a proof than a belief. A session that can't reach `solved` reports
   inconclusive rather than force-writing a low-confidence rewrite.
5. **Consent.** No new ask. Recipe demotion already happens fully automatically today with no owner
   approval — this is skill CONTENT, not constitution/identity, so the existing governance level applies
   unchanged. Visible after the fact via `/autonomy` and `revision_history`, not gated before the fact.
   (Contrast: constitution amendments stay owner-ratified — this feature does not touch that boundary.)

## 5. Rollout

- **P0** — schema only: `revision_history` column (nullable, back-compat) + `ActionLog.getBySkill()` +
  `SkillStore.reviseRecipe()`. Zero behavior change (nothing calls `reviseRecipe` yet). Unit tests on the
  query and the revision-history bookkeeping. **Shipped**: `schema.ts` v34→v35, `actions.ts`,
  `skill_repair.ts` (types + `isRepairCandidate`/`repairAttemptsExhausted`), `skills.ts:reviseRecipe`.
- **P1** — `SkillRepairDriver.propose()` (pure, unit-tested against a fixture `MemorySnapshot`).
  **Shipped, but deliberately NOT registered into `AUTONOMOUS_DRIVERS`** (`server/src/chat-handler.ts`)
  yet: the shared `InitiativeExecutor` writes facts/notes back on completion, not skill revisions — with
  no `OutcomeHook` to turn a finished diagnosis into a `reviseRecipe()` call, registering the driver today
  would spend real `deep_explore` budget and produce nothing (see the driver's own doc comment for detail).
  The `PHILONT_SKILL_REPAIR` flag + registration + the `OutcomeHook` are P2, together — splitting them
  further doesn't buy a safe intermediate state.
- **P2** — an `OutcomeHook` (mirroring `pursuit_progress_writer.ts`'s pattern) that, on a `skill_repair`
  initiative's `done` result, extracts the proposed revision and calls
  `SkillStore.reviseRecipe(name, { ..., reason: 'skill_repair:' + initiative.id })` — the
  `REPAIR_REASON_PREFIX` marker `repairAttemptsExhausted` (shipped in P0/P1) already checks for. Register
  `SkillRepairDriver` into `AUTONOMOUS_DRIVERS` behind `PHILONT_SKILL_REPAIR` (default off) alongside the
  hook. Flip the default on once a dogfood pass shows repaired recipes measurably outperforming their
  prior version — measurable for the first time, via `revision_history`.

## 6. Non-goals

A user-facing skill-versioning UI (no diff viewer, no rollback surface yet — the history is for the
reflector/audit, not a product surface); repairing prose-lesson skills (`kind='positive'` without a
`verification` — not callable recipes, nothing to re-verify); a third same-root-cause threshold ladder
(reuses the two that exist); changing `recipeReuseMaturityMove` or the maturity state machine themselves
(unchanged); constitution/identity self-modification (recipes are not identity — this stays a
skill-layer feature, not a WS3 constitution-layer one).
