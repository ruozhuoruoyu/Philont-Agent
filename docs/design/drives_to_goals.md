# Drives→Goals + Trait-Tuned Contracts (S4) — the personality × loop integration

Status: DESIGN. Author: ruozhuoruoyu.
The integration point of `motivation_loop_architecture.md`: where philont's personality meets the
goal-loop spine. Layers ON TOP of S2 (`goal_loop_runtime.md`) — ships after the runtime exists. Anchored
to real `file:line`.

## 1. Why

philont's drive is intrinsic/personality-based; today it produces ONE-SHOT read-only research, not goals.
The drivers (`autonomous/drivers/*`) `propose()` an `InitiativeProposal`; the executor runs read-only
tools, writes back to facts/notes/pursuits, and fires an interrupt that surfaces next turn. The energy is
real but **dissipates into background lookups**, never becoming a sustained, bounded pursuit.

S4 does two things:
1. **Drives→Goals** — a SUSTAINED drive becomes a committed goal-loop (S2), not a one-shot lookup.
2. **Trait-tuned contracts** — the constitution's drive parameters tune each goal-loop's contract (S2) and
   trajectory thresholds (S3). This is philont's differentiator: a *personality* running loops, not a cron.

## 2. The drives that exist (build on these)

- **好胜 / competitiveness** = `TaskCommitmentDrive` (`kernel_drives.ts:230` `TsTaskCommitmentDrive`) —
  "exhaust all tool-reachable options before giving up; don't hand tasks back casually".
- **好奇 / curiosity** = `CuriosityDrive` (`autonomous/drivers/curiosity_driver.ts`) — recurring
  un-researched tokens + high-stake untouched pursuits.
- **尽责 / conscientiousness** ≈ the `commitment_pressure` / `service_dormancy`→`BoredomThreshold`
  intrinsic signals (`chat-handler.ts:652`) — discomfort at leaving commitments hanging.
- Runtime: `TsDriveRuntime` (beforeTurn/afterTurn) scores outcomes and tunes `drive_config` WITHIN
  `constitution.driveBounds`. Guardrail already in the constitution
  (`constitution_defaults.ts:35`): "Never let curiosity detach from the user's goals into untethered
  busywork that burns time and budget."

## 3. Part A — Drives→Goals

### 3.1 The promotion rule
Not every drive fire deserves a goal-loop. Distinguish:
- **Quick lookup** (stays one-shot research initiative) — a single fact to verify, a token to skim.
- **Worth pursuing** (becomes a committed goal-loop) — high stake × recurrence × open-endedness:
  a hard open problem the agent keeps returning to, a high-stake pursuit aging untouched, a recurring
  theme it wants to UNDERSTAND not just look up.

A pure `shouldPromoteToGoal(driveFire, snapshot): boolean` (mirror the gate-style pure functions) reads
stake/recurrence/open-frontier and decides. Promotion = commit a goal-loop via S2's commit-goal entry,
with a tentative def-of-done the agent refines.

### 3.2 Consent
A drive-generated goal-loop that would run autonomous compute still needs S2's one "run autonomously"
consent — but a curiosity-born loop should ASK first ("我对 X 很好奇,想开个后台探索追下去,可以吗?"),
honoring the constitution guardrail. The personality PROPOSES; the user (or a standing consent) DISPOSES.

## 4. Part B — Trait-tuned contracts

Map drive parameters (within `driveBounds`) to S2 contract + S3 thresholds. The traits TUNE, never
override, the spine:

| Trait (engine) | Tunes | Effect |
|---|---|---|
| **好胜** (TaskCommitmentDrive) | S2 budget, S3 stuck threshold, switch-engine eagerness | higher round/budget before declaring stuck; bias "actually solve" over "survey"; try switch-engine before giving up |
| **好奇** (CuriosityDrive) | S2 tick breadth, Drives→Goals rate | wider diverge per tick; generates more candidate goals — but bounded by the constitution guardrail + per-loop budget |
| **尽责** (commitment_pressure) | S2 report cadence, S3 escalate sensitivity | reports stuck/progress earlier and more often; lower tolerance for leaving open threads → drives the proactive-ask |

The same energy that caused this cycle's runaway (好胜/好奇 with no bounds → infinite divergence /
fabrication) becomes PRODUCTIVE once it tunes a contract that has S1 truth + S2 stop/budget + S3
trajectory as the floor. **Traits set how hard/wide/loud; the spine sets where/when-to-stop/what's-true.**

## 5. Decisions (recommended defaults — edit here)

1. **Promotion bar.** Conservative — most fires stay one-shot; only clearly sustained/high-stake become
   goal-loops (avoid spawning loops that burn budget — the constitution guardrail).
2. **Curiosity loops ask first.** A user-assigned goal may auto-run (with commit consent); a
   curiosity-born loop ASKS before going autonomous. Non-negotiable (the guardrail).
3. **Trait→param mapping is bounded.** Tuning stays within `driveBounds`; the reflector keeps tuning via
   `drive_outcomes` (existing). S4 only adds the contract/threshold MAPPING, not new unbounded knobs.

## 6. Rollout (after S2)

- **P0** the pure mappings: `shouldPromoteToGoal(...)` + `traitTunedContract(driveConfig): ContractDefaults`
  + unit tests. No wiring → zero behavior.
- **P1** drivers can emit a "promote to goal-loop" proposal (curiosity/pursuit drivers first); behind
  `PHILONT_DRIVES_TO_GOALS` default off → dogfood.
- **P2** trait-tuned contracts wired into the GoalLoopDriver's defaults + S3 thresholds.

## 7. Non-goals

Changing the constitution's identity/values; unbounded drive knobs; auto-running curiosity loops without
the ask; removing the "don't detach into busywork" guardrail (S4 enforces it, doesn't relax it).
