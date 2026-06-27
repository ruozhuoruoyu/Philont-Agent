# Goal-Loop Runtime (S2) + Trajectory Scoring (S3)

Status: DESIGN. Author: ruozhuoruoyu.
Closes the spine of `motivation_loop_architecture.md`. Depends on S1 (`execution_ledger_anchor.md`) —
**truth before autonomy**. Tuned by S4 (drives→goals + trait contracts). Anchored to real `file:line`.

## 1. Scope

- **S2 — Goal-loop runtime**: commit a goal → run it tick-by-tick until def-of-done / stuck / budget,
  reporting proactively. The "loop engineering" capability proper. Generalizes
  `deep_explore_autoadvance` from deep_explore-only to ANY goal.
- **S3 — Trajectory scoring**: the loop's sense of direction — a multi-tick progress metric that drives
  continue / stop / escalate / **switch-engine**.
- **Entry redesign (the crux)**: the reactive plan path and a goal-loop are DIFFERENT scenarios. Keep
  reactive plan for "do X now"; ADD a commit-goal entry for "pursue X over time" (see `motivation_
  loop_architecture.md` §3 for why plan is a great tick BODY but the wrong loop ENTRY).

## 2. Build on these (do NOT reinvent)

- `deep_explore_autoadvance.ts` — already a per-session background tick loop with stuck-stop
  (`no_progress_rounds` ≥ STUCK_STOP → escalate) + `notify` + `runInContext` (background cap). **This is
  the proto goal-loop driver — generalize it**, don't write a new one.
- **pursuit** (`PursuitStore`, types.ts `PursuitStatus = active|paused|shadow|achieved|archived|abandoned`)
  — the long-horizon GOAL shell: `resolutionCriteria` (= def-of-done / STOP), `openQuestions`,
  `evidenceRefs`. The natural home for a goal-loop's identity.
- **plan** (`PlanStore`, `plan_protocol_gate`) + **deep_explore** (the tree) — the tick BODY.
- `reasoning.summarizeSession()` (open/proved/dead), `noProgressRounds`, `viability_gate` — per-round
  progress signals S3 aggregates into a trajectory.
- `notify` (chat-handler.ts:2027 — `webuiClients.send('milestone')` + `pushDispatcher.enqueue(...)`) — the
  REPORT channel. philont is single-user → no per-owner routing needed.

## 3. S2 — the Goal-Loop

### 3.1 The record
Reuse **pursuit** as the goal shell; add loop-control fields (a small companion table or columns on
pursuit, no new top-level entity):
- `contract`: { trigger (cadence/continuous), budget (tokens/$/rounds ceiling per loop), stopExtra,
  reportCadence } — **defaults trait-tuned (S4)**.
- `bodyKind`: `'deep_explore' | 'plan' | 'research'` — which tick body advances it.
- `loopStatus`: `running | paused | stuck | done`.
- `trajectory`: rolling score + last-tick ts (S3).
- def-of-done = `pursuit.resolutionCriteria` (or deep_explore `solved`/`finalize`).

### 3.2 Entry — two DISTINCT entries (the redesign)
1. **KEEP reactive plan** (`task_mode_classify('slow') → plan_protocol_gate → execute → plan_close`) for
   "do this complex thing now, synchronously, while the user is here". Unchanged.
2. **ADD commit-goal entry** — a `goal_loop` action (`start | pause | stop | status`) that commits a goal
   + contract to the loop registry. A goal-loop is NOT entered because "this message looks complex"
   (that is reactive plan); it is entered by an explicit commitment to pursue over time. Commit sources:
   - **user** ("把 X 推进到 Y / 持续盯着 Z");
   - **drives→goals (S4)** — an intrinsic fire becomes a committed goal, not a one-shot lookup;
   - **auto-promote a quiet open deep_explore** — the proactive-ask (old ②): on "继续/yes" the open
     session is committed as a running goal-loop. ② is thus the REPORT/commit edge of S2, not a patch.

### 3.3 Driver — generalize `deep_explore_autoadvance`
A unified **GoalLoopDriver** (server-side, mirrors `createAutoAdvanceLoop`): each tick scans committed
`running` goal-loops; for each, advance **one bounded unit** by `bodyKind`
(deep_explore continue / plan next-step / research batch) in a background `runInContext`, respecting the
loop budget + one-unit-per-tick, then update `trajectory` (S3), evaluate STOP, and REPORT milestones via
`notify`. `deep_explore_autoadvance` becomes the `bodyKind='deep_explore'` special case.

### 3.4 The Loop Contract (per goal-loop)
- **TRIGGER** scheduled cadence (reuse the autonomous tick / a dedicated interval) — recommend scheduled,
  not continuous (continuous is harder to bound).
- **SCOPE** the one pursuit/session.
- **ACTION** one bounded unit (a deep_explore round / a plan step / a research batch).
- **BUDGET** per-loop tokens/$/rounds ceiling, ABOVE the per-tick caps (loop-engineering: cost moved to
  loop management — Uber's $1500/mo cap cautionary tale).
- **STOP** def-of-done met | stuck (S3 flat trend N ticks) | budget exhausted | user pause.
- **REPORT** milestone (progress) / stuck (ask) / done (summary) — cadence trait-tuned (S4: 好胜 reports
  progress, 尽责 reports stuck earlier).

### 3.5 Auth / safety (non-negotiable)
- A goal-loop that runs deep_explore/plan in the background needs **one explicit "run autonomously"
  consent at commit** (reuse the `auto_on` pattern) — never run unsupervised compute without it.
- **S1 is a hard precondition**: a background loop that can fabricate is worse than no loop. S2 ships
  AFTER the execution-ledger anchor. The teeth (honesty/viability) still apply inside each tick.
- No nested goal-loops; the per-loop budget is the runaway backstop.

## 4. S3 — Trajectory scoring + meta-control

### 4.1 The metric
Per goal-loop, a rolling progress score over the last K ticks — does the trend show NET progress toward
def-of-done? Inputs: newly settled/proved nodes, open-frontier delta, plan steps done, evidence added,
proximity to `resolutionCriteria`. This sits ABOVE the existing binary per-round `noProgressRounds`: a
TREND, not a single-round flag.

### 4.2 What the score drives (meta-control)
- **continue** — progressing.
- **stop** — def-of-done met.
- **escalate / REPORT** — stuck (flat trend N ticks) → ask the user.
- **switch-engine** (NEW, the high-value one) — detect "this `bodyKind` is not converging on this goal"
  → switch body (e.g. formal+pariGp on a meta-mathematical goal settled 0 in 2 rounds → switch to
  deliberate/literature). **Directly fixes the observed P-vs-NP waste** (~400 s, 0 nodes, all real
  output came from the web/deliberate path).
- **replan** — stuck-but-alive → trigger `plan_revise` / a different decomposition.

### 4.3 Shape
`scoreTrajectory(history): { score, trend, decision }` — a PURE function (mirror `phase_gate.ts` /
`viability_gate.ts`): the driver gathers tick history, the function decides. Trivially unit-testable; the
switch-engine and stuck thresholds are constants tuned by S4.

## 5. Decisions (recommended defaults — edit here)

1. **Commit entry shape.** A `goal_loop` action (start/pause/stop/status) — recommend, over silent
   pursuit auto-promotion. Explicit commitment = explicit consent.
2. **Cadence.** Scheduled (reuse autonomous tick or a dedicated interval), not continuous.
3. **Switch-engine policy.** Conservative: N=2–3 flat ticks on a body before switching; log the switch.
4. **Auth.** One "run autonomously" consent per loop at commit (auto_on pattern).
5. **Stuck → REPORT vs auto-switch.** Default: switch-engine ONCE, then if still flat → REPORT/ask (don't
   silently thrash engines).

## 6. Rollout (phased, flag-gated, default off; AFTER S1)

- **P0** GoalLoop record + contract types + `scoreTrajectory` pure fn + unit tests (truth table:
  progress→continue, flat→stuck, met→stop, meta-math-0-progress→switch). No driver wiring → zero behavior.
- **P1** GoalLoopDriver generalizing `deep_explore_autoadvance` (deep_explore bodyKind first), behind
  `PHILONT_GOAL_LOOP` (default off → dogfood).
- **P2** commit-goal entry (`goal_loop` action) + quiet-open-session → proactive-ask → commit (absorbs ②).
- **P3** plan/research bodyKinds; switch-engine meta-control live.
- **Then S4** drives→goals + trait-tuned contracts layered on this runtime.

## 7. Non-goals

Replacing reactive plan; unsupervised compute without commit consent; continuous (non-ticked) loops;
distributed/remote execution; changing the personality/constitution (S4 tunes the contract, never the
identity).
