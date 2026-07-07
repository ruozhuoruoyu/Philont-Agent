# Selfhood Closure — wire the last hop of every self loop

Status: FULLY IMPLEMENTED 2026-07-06 (WS0 README + WS6 mouth + WS1 traits + WS2 params + WS4
self-observations + WS5 recipe reuse + WS3 constitution proposals; per-WS commits on main).
Follow-up landed same day: the `/autonomy` status surface (WS6 §8 — GET /api/autonomous/selfhood,
the '/autonomy' chat command, and a Selfhood section in the web-ui autonomy dashboard) and
producer (b) for value_annotation proposals (a self-observation persisting ≥14 days despite
prompt-level visibility files a ratifiable value annotation).
Author: ruozhuoruoyu.
Companion to `motivation_loop_architecture.md` (the spine) and `execution_ledger_anchor.md` (S1).
Anchored to real `file:line`.

## 1. Problem — every self loop breaks at its last hop

README §Selfhood Engineering makes five being-claims: a live identity, drives tuned by the agent's
own personality, self-learning that compounds, a self-model, proactive reporting. The audit shows the
machinery for each exists — and each is severed exactly one hop before it would change anything:

| # | Self loop | What exists (real) | The broken last hop |
|---|---|---|---|
| 1 | experience → traits → behavior | `deriveTraitProfile` (`drives_to_goals.ts:40`), `traitTunedContract` (`:55`) — the math is written and tested | **Both have zero call sites.** `CuriosityDriver` is constructed without `traits` (`chat-handler.ts:1947-1957`) → falls back to `DEFAULT_TRAITS` forever. Every instance has the identical, immutable "personality". |
| 2 | outcomes → param tuning → behavior | `SessionDriveReflector` is wired (`chat-handler.ts:543`) and really tunes `cooldownMs` in `memory_drive_configs` (`drive_reflector.ts:181-230`), bounds-checked and audit-logged | **No runtime code reads the params back.** `DriveConfigStore` has no consumer outside the reflector itself; `chat-handler.ts:608` admits drives "can be dynamically loaded … later". The self-tuning loop writes to a dead end. |
| 3 | experience → identity | Constitution seeded from `constitution_defaults.ts` into the bootstrap root pursuit; load-hash audited (`pursuit.ts:520`) | **Write-once, frozen.** Runtime writes to `constitution_*` are rejected (`pursuit.ts:7-9`); the evolution channel `constitution_proposals` is "future iteration" (`pursuit.ts:551`, `drive_reflector.ts:27`). A system prompt stored in SQLite is still a system prompt. |
| 4 | experience → self-model | K7 bridge self-verifies commitments (`k7_bridge.ts`) — genuinely self-referential | **The agent is forbidden to know itself.** The autonomous executor rejects `namespace='self'` facts (`executor.ts:224, 321`); the reflector extracts task-level skills/lessons only. Nowhere does the system record "I tend to fail in way X". |
| 5 | skills compound | Recipe fields authored at verified plan close (`plan_tools.ts:19` → `buildRecipeFields`); recall shipped (db22ae5) | **`recipeReuseMaturityMove` (`skill_recipes.ts:86`) has zero call sites.** Reuse never runs the recipe's verification, so "a recipe that stops working is caught by its own verification" is unimplemented. Skills accumulate; they don't compound. |
| 6 | self → observable behavior | Interrupt sink has a full high-severity path: web-ui `finding` fan-out + urgent push (`chat-handler.ts:2080-2114`) | **Dead code.** `loop.ts:220-224` fires severity `'normal'` in *both* ternary branches; `ExecutorLlmOutput.shouldEscalate` is prompted, parsed (`executor.ts:311`) and then dropped. Push additionally requires a per-peer subscription nobody creates. The mouth is sealed. |

Working definition used throughout: **a self is a model that (a) changes with experience, (b) changes
behavior, and (c) whose difference is externally observable.** Today (a) is forbidden or frozen,
(b) is severed by constants and dead-end tables, (c) is sealed. "自驱感受不到" and "self 未兑现"
are the same defect.

## 2. Principles

- **Wire, don't build.** Every workstream below is predominantly connecting pure functions that
  already exist and are already tested. New code is small and mostly plumbing + one aggregator.
- **The self-model grows only from ledger evidence.** Same spine as S1: no self-fact without
  `sourceRefs` pointing at real action/tool records. The model never free-writes its self-image.
- **Identity changes only by proposal + owner ratification.** The agent proposes with evidence;
  the human approves. Red lines are immutable, period.
- **Every self-domain write is audited.** The `self_domain_write` audit event already exists
  (`drive_reflector.ts:208`); all new writers reuse it.
- All flags follow house convention: default ON, `=0/off/false/no` kills.

## 3. WS1 — live traits: wire `deriveTraitProfile` into the drivers

**Goal:** each instance's competitiveness / curiosity / conscientiousness is derived from its own
lived record and actually tunes behavior.

- New server helper `currentTraitProfile(memory): TraitProfile` — reads real signals into
  `DriveSignals` (`drives_to_goals.ts:24-32`), then `deriveTraitProfile`:
  - `competitiveness` ← TaskCommitmentDrive fire-rate EWMA (kernel drive outcomes / handoff
    interventions per week, normalized 0..1);
  - `curiosity` ← curiosity-initiative success EWMA from `memory_drive_configs.effectiveness_json`
    (kind `curiosity`), fallback recurrence of settled curiosity initiatives;
  - `conscientiousness` ← mean `commitment_pressure` drive-signal level over the trailing 7 days.
  - Missing signal → neutral 0.5 (already the contract of `deriveTraitProfile`). Pure; recomputed
    once per autonomous tick and once per idle tick — never cached across restarts.
- Pass `traits: currentTraitProfile(memory)` into the `CuriosityDriver` config at
  `AUTONOMOUS_DRIVERS` construction (`chat-handler.ts:1947`) — the field already exists
  (`curiosity_driver.ts:142-143`) and already flows into `shouldPromoteToGoal`
  (`curiosity_driver.ts:242`). Note: construction is module-load-time; make the config field a
  provider callback (`traits: () => currentTraitProfile(memory)`) so each tick sees fresh values.
- Call `traitTunedContract(traits)` at goal-loop creation (the `promote_goal_loop` path,
  `curiosity_driver.ts:244-255` → goal_loop runtime) so rounds / `stuckAfter` / `reportEvery`
  genuinely differ per instance history. Traits tune, never override, the spine — the function
  already clamps (`stuckAfter > switchAfter` invariant, `drives_to_goals.ts:62`).
- Flag: `PHILONT_TRAITS_LIVE` (default ON).

**Acceptance:** two DBs with different failure/curiosity histories produce different
`TraitProfile`s, a different promotion bar, and a different loop contract — assert in an
integration test with two seeded fixtures.

## 4. WS2 — give `memory_drive_configs` a consumer

**Goal:** the parameter the reflector tunes changes real scheduling, closing
outcomes → tuning → behavior.

- Seed one config row per K8 driver kind (`gap` / `curiosity` / `pursuit`) at bootstrap if absent,
  `params_json = { cooldownMs: <current hardcoded default> }`.
- Consumers read tuned `cooldownMs` with the hardcoded value as fallback:
  - `CuriosityDriver` re-research cooldown (token-gap recurrence window);
  - `PursuitDriver` stall window (currently fixed 7d);
  - `GapDriver` re-check interval.
  Loaded once per autonomous tick alongside the existing `MemorySnapshot` (`loop.ts:167`) — one
  extra SQLite read, no per-proposal queries.
- Out-of-bounds proposals keep flowing to audit only, until WS3 gives them a ratification surface.

**Acceptance:** manually halve a `cooldownMs` row → next tick provably schedules the affected
driver's proposals at the new cadence (unit test on the driver with injected config).

## 5. WS3 — `constitution_proposals`: identity that evolves by ratification

**Goal:** the README's "live identity shaped by what it has learned" becomes true — safely.

- Schema (name already reserved in code comments):
  `constitution_proposals(id, root_pursuit_id, field, current_text, proposed_text, rationale,
  evidence_refs_json, status: pending|approved|rejected, created_at, decided_at)`.
- Producers:
  - `SessionDriveReflector` out-of-bounds tunes (`drive_reflector.ts:203-221`) — today audit-only,
    additionally stored as a pending proposal ("relax curiosity cooldownMs bound to X, EWMA says
    the current bound starves it");
  - a consolidation-pass producer: when the same ledger-evidenced value conflict recurs ≥ N times
    (e.g. owner repeatedly overrides a default), propose a constitution *annotation*.
- Surfacing: pending proposals render as a section on the next user turn (same injection pattern
  as `user_pattern_inject.ts`, `chat-handler.ts:3772-3779`), with approve/reject captured like
  `detectPatternConfirmation`. Rate-limit: ≤ 1 pending proposal surfaced per day.
- On approve: `PursuitStore.setConstitution` (`pursuit.ts:488`) gains an **amend-with-provenance**
  path — append an annotation block (proposal id + date), never rewrite existing text.
  **`constitution_red_lines` is not amendable via this path — hard-coded refusal.**
- Audit: new `constitution_amend` event carrying proposal id; re-hash and log as in
  `constitution_load` (`pursuit.ts:520`) so the identity's history is tamper-evident.
- Flag: `PHILONT_CONSTITUTION_PROPOSALS` (default ON for producing/surfacing; amend always requires
  explicit owner approval regardless of flag).

**Acceptance:** a seeded recurring conflict produces exactly one pending proposal; approving it
appends an annotated value visible in the next turn's identity prompt; rejecting it suppresses
re-proposal of the same content for 30 days; red-line amendment attempts are rejected with an
audit entry.

## 6. WS4 — self-observations: a self-model grown from the ledger

**Goal:** the agent may know itself — but only through evidence. The executor ban
(`executor.ts:224`) stays; free-form self-narration remains forbidden.

- New `SelfObservationWriter`, run inside the existing idle consolidation pass
  (`chat-handler.ts:698-720` neighborhood). **v1 is pure aggregation, zero LLM calls** — no
  fabrication surface:
  - same-root-cause retry streaks before an approach switch (from the action ledger /
    `countSameRootCauseFailures`);
  - handoff-pattern interventions per week (kernel TaskCommitmentDrive outcomes);
  - plan closes auto-converted success→failure by spec-coverage (C1–C4);
  - honesty-gate regeneration count by branch;
  - recipe verification failures (from WS5).
- Each observation = a fact with `namespace='self'`, `sourceRefs` = the aggregated action ids —
  **empty refs rejected at write time**, mirroring the executor's anti-fabrication drop
  (`executor.ts:217-221`). Written via a dedicated store method that only this writer holds; the
  tool-facing `write_fact` path keeps rejecting `namespace='self'`.
- Consumers:
  - top-K (K=5, recency-decayed) rendered into the system prefix as
    `## What I know about my own tendencies` — the agent can finally say "I have retried this
    class of failure 4× before switching; switch now";
  - WS1 trait signals read these aggregates instead of recomputing raw scans.
- Flag: `PHILONT_SELF_OBSERVATIONS` (default ON).

**Acceptance:** seeded ledger with 3 same-root-cause streaks yields exactly the expected
observation facts with correct refs; prefix section appears and is capped at K; a write with empty
refs throws.

## 7. WS5 — recipes compound: wire reuse verification

**Goal:** "a recipe that stops working is caught by its own verification" becomes real.

- In the `use_skill` execution path (`agent-memory/src/tools.ts:247`): when the invoked skill
  `isCallableRecipe`, run its `RecipeVerification` after the steps execute; feed the boolean into
  `recipeReuseMaturityMove` (`skill_recipes.ts:86`) and apply the move through the existing
  `recordSkillOutcome` state machine (`skill_maturity.ts:6-16`) — `promote` on pass,
  `demote_revise` on fail (recipe drops to advisory-lesson status, `[lesson-only, no use_skill]`).
- A verification failure also emits a WS4 self-observation ("recipe X failed its own check on
  reuse") so decay is visible to the agent, not just to the DB.
- Flag: `PHILONT_RECIPE_REUSE_VERIFY` (default ON).

**Acceptance:** a fixture recipe whose verification passes gets promoted; flip the verification to
fail → skill demoted to advisory and excluded from `use_skill` candidates on the next recall.

## 8. WS6 — the mouth: make autonomous work observable at discovery time

(Specced in the autonomy audit; summarized here because observability is leg (c) of the self.)

- Thread `ExecutorLlmOutput.shouldEscalate` → `InitiativeRunResult.escalate` → `loop.ts` fires
  `'high'` when set (replacing the `'normal' : 'normal'` ternary at `loop.ts:220-224`) → the
  existing high-severity sink (`chat-handler.ts:2080-2114`) comes alive: web-ui `finding` fan-out +
  urgent push at the moment of discovery.
- First-contact auto-subscribe of the primary WeChat peer with an explicit opt-out line; without
  this, `PushDispatcher`'s per-peer gate (`dispatcher.ts:128-131`) keeps every channel silent.
- `/autonomy` status surface (web-ui panel + chat command): active pursuits, initiatives run today,
  budget spent, current `TraitProfile` (WS1) and top self-observations (WS4). Observability is half
  of felt selfhood — the traits and self-model become *visible*, not just operative.
- Fix the stale header doc in `autonomous_budget_env.ts:6-10` (claims 7000/4/2000; live defaults
  are 16000/8/2000 per `budget.ts:30-47`) while touching the area.

## 9. WS0 — README honesty alignment (ships FIRST)

The project's first claim is "never pretends to have succeeded when it hasn't". Until the WSs
above land, these README §Selfhood lines are pretended success and must be downgraded to explicit
roadmap markers:

- "tuned by the agent's own personality traits" → roadmap until WS1;
- "It reports progress proactively" → roadmap until WS6;
- "a live identity shaped by what it has learned" → roadmap until WS3+WS4;
- "a recipe that stops working is caught by its own verification" → roadmap until WS5.

One-line edit each ("(shipping: see docs/design/selfhood_closure.md)"). This ships before any
code: the honesty principle applies to the front page or it applies nowhere.

## 10. Rollout order, risks

Order: **WS0 (README) → WS6 (mouth) → WS1 (traits) → WS2 (params) → WS4 (self-observations) →
WS5 (recipes) → WS3 (constitution — needs the approval surface, land last).**
WS6/WS1/WS2/WS5 are wiring-dominant and independently shippable; WS4 introduces one new writer;
WS3 introduces schema + product surface.

Risks and containment:
- **Trait feedback instability** (traits raise activity → more outcomes → traits drift): all inputs
  EWMA-smoothed, outputs clamped 0..1, contract effects bounded by `traitTunedContract`'s existing
  multipliers (~0.6×–1.6×) and `driveBounds`.
- **Prefix bloat** from self-observations: hard cap K=5, recency decay, one-line renderings.
- **Constitution churn / prompt-injection into identity**: proposals only from the two whitelisted
  producers (never from tool output or web content), rate-limited, human-ratified, red lines
  immutable, amendments append-only + hash-audited.
- **Push noise** (WS6): existing rate limits (digest 4h / urgent 1h), quiet hours and 24h dedup in
  `dispatcher.ts:111-191` already contain it; auto-subscribe message includes the opt-out.

## 11. Definition of done

The working definition from §1, made testable end-to-end: two instances seeded with different
histories must (a) hold different self-models (facts + traits), (b) behave measurably differently
(promotion bar, loop contract, driver cadence, recipe pool), and (c) show that difference to their
owners unprompted (discovery-time escalation, digest, `/autonomy` panel). One integration test per
leg; all three green = selfhood closed.
