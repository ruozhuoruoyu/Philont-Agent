# Memory → Behaviour: what the philosophers experiments say about philont's learning loop

Status: EVIDENCE + FIRST CHANGES (2026-10-03). Author: ruozhuoruoyu (experiments run in the
`Philosophers` repo, experiments 89–109; this document maps them onto philont's code paths).

This is not a redesign. philont's own post-mortem (`self_evolution_postmortem.md`) already reached the
central diagnosis — unverified artifacts were produced faster than anything measured them. The
philosophers programme asked the next questions with controlled, falsifiable runs on two simulators
(ScienceWorld, PHYRE) and on this product's exported action ledger: **where** a verified lesson should
attach, **what shape** a skill should take, **what** can be predicted before acting, and **how** to tell a
real effect from run-to-run noise. Each finding below carries the number that established it and the
philont code path it bears on.

## 1. Findings that transfer, with the code path they touch

| Finding | Evidence | philont path | Status |
|---|---|---|---|
| **Memory reaches behaviour through the candidate set, not the prompt.** The same experience (facts, failed actions, best trajectory) scored 37.3 when it removed failed actions from the choices, 18.3 when it was written into the prompt as "do not repeat X", 34.2 with no memory at all (27B; 38/80 episodes judged failed under the prompt coupling; same ordering at 9B over 3 seeds). | exp 104 | `buildMemoryPrefix` injects "my past failure patterns" and 20 anti-patterns as text; the only candidate-set restriction is the per-turn tool block (`chat-handler.ts` in-turn-tool-block) | principle; see §2 for why the ScienceWorld veto itself does not transfer |
| **Predict before acting, from state not content.** On this product's ledger (27,528 calls): tool identity + recent failure streak predicts failure with AUROC 89.8 (base rate 82.7); skipping P(success)<0.5 drops 13% of calls, avoids 50% of failures, loses 5.5% of successes. Content embeddings add nothing overall. | exp 100 | no pre-call prediction existed; all gates are post-hoc | **shipped, shadow**: `server/src/failure_predictor.ts`, controller `failure_predictor` |
| **Unrelated recall is not neutral.** Retrieving facts from other tasks by similarity turned a 5/5-solved task into 5/5 failures (27B); the SRDP formalisation (Memento 2) keeps an explicit void case. | exp 103; Memento 2 | `skill_recall.ts` fills every empty slot from the global top-N; with a CJK query against an English corpus `matchedByRelevance` is 0 on every turn | **shipped, opt-in**: `PHILONT_SKILL_RECALL_NO_FILL` |
| **Reflection-as-text does not change a 9B/27B agent's behaviour.** CLIN-style causal sentences in the prompt: 9B below zero-shot, 27B flat; the same knowledge applied to the candidate set: +15 / +30 over five episodes. | exp 103 | turn-close reflection writes routing rules / playbooks as text | not acted on: philont's model is a frontier API model, for which the small-model negative may not hold; philont's own adoption counters (1022 rules / 0 validated; same failure ×38) are the relevant data |
| **A skill must store the dimension the model lacks.** PHYRE: a program storing the continuous placement the agent could not propose solved 26.0% vs 15.0% (three independent runs); ScienceWorld: a program storing the order of operations the agent already knew had no effect (three variants between two baseline runs). | exp 107–109 | `memory_skills` action templates are procedures; the parameters philont's model lacks are project-specific commands, paths, field names (`mechanical_fix`, `plan.md` operational knowledge) | principle; no change yet |
| **Growth does not degrade; write-time arbitration is not supported.** Raw per-task memory to 900 facts: revisit after ~95 episodes scores above the first round (two models, four runs); merging / forgetting / cross-task retrieval differences are inside run-to-run noise. | exp 105 | facts take-latest by exact (namespace, key) — consistent; rule dedup by Jaccard ≥0.7 — the kind of similarity merge exp 89 measured at −10 | keep as is |
| **One run is not a result.** Same 27B configuration twice: 48.6 vs 30.9; 43/105 episodes identical, the rest diverged once a greedy step differed and the memory followed. | exp 105 noise study | replay bench runs each fixture twice per tick — consistent; the learning layer as a whole has no before/after | rule for any future wiring |

## 2. What did NOT transfer: the exact-action veto on this product's ledger

The ScienceWorld result (103/104) is a veto on the exact action that was judged a failure. Replaying the
exported ledger (27,528 calls, 39 sessions, 4,077 failures) with the same rule:

| veto key | threshold | failures avoided | successes wrongly blocked |
|---|---|---|---|
| exact (tool, normalised params), failed in ≥2 sessions, never succeeded | — | **0** | 0 |
| (tool, parameter feature: shell command head / path dir / URL host / gp first line), ≥2 sessions, fail-rate ≥0.5 | 0.5 | 134 (3.3%) | 54 (0.23%) |
| same, fail-rate ≥0.9 | 0.9 | 35 (0.9%) | 6 |
| `shell:cmd-not-found:<cmd>` remembered across sessions | — | 0 (the class does not occur in this ledger) | 0 |
| upper bound: any failure whose signature had already recurred in ≥2 sessions | — | 771 (18.9%) | — (signature is only visible in the result, not predictable from the call) |

Real tool traffic almost never re-issues the same normalised call across sessions; the failures that
recur are content errors (gp syntax, shell specifics) whose repeat is not predictable from the call's
text. Failure on this ledger is a property of the agent's **state** (a failing streak), which is exactly
what the predictor conditions on. So the candidate-set principle stands, but on this traffic its
instrument is the predictor, not a veto table. A veto table is not implemented.

## 3. What was shipped in this change

1. `server/src/failure_predictor.ts` — online logistic regression on [bias, tool one-hot, fails/5,
   fails/20, last-same-tool-failed]; conservative step (lr 0.05, L2 1e-3 — the offline study showed the
   online head collapses without regularisation); warm-started from the last 30 days of the ledger at
   startup; **shadow only**. Each real dispatch is scored before execution and the (P(fail), outcome)
   pair is recorded to metrics (`predictor.shadow.{hi,lo}.{fail,ok}`) and the audit log
   (`failure_predictor_shadow`). Controller id `failure_predictor`; `PHILONT_FAILURE_PREDICTOR=off`
   disables. `renderLearningStats` prints the calibration split.
2. `server/src/skill_recall.ts` — `PHILONT_SKILL_RECALL_NO_FILL` (default off): a section with zero
   relevance matches stays empty instead of filling from the global top-N; partial matches still fill.
3. Tests: `server/tests/failure_predictor.test.ts`, additions to `server/tests/skill_recall.test.ts`.

Nothing here drives a decision yet. The sequence is the one the learning judge followed: shadow until
the logged pairs reproduce the offline separation, then decide what a high P(fail) should do (a hint,
a research nudge, a skip) and measure it with the learning layer on and off, two runs each.

## 3a. Second batch (2026-10-04)

4. `agent-memory/src/cases.ts` + schema v50 `memory_cases` — **judge-verified cases**: `(goal, tool trace
   with per-call success, verdict, basis, evidence)` appended at turn close when the learning judge returns
   `success` or `failure` (`chat-handler.ts`, judge `.then`). Append-only, bounded (5000), no write-time
   merging. Read side `PHILONT_CASE_RECALL` (default off): up to 3 cases whose goal overlaps the current
   message (Jaccard > 0, no fill) rendered as one line each under "Earlier runs of similar tasks". This is
   the Memento form of memory — the run itself with its outcome, written by the mechanism layer — offered as
   a verifiable alternative to distilled prose. Metrics `case.recorded.{success,failure}`, `case.inject.turns`.
5. `agent-memory/src/extractor.ts` — **novelty gate** (default on, `PHILONT_EXTRACTOR_NOVELTY_GATE=off`):
   an extracted fact identical to the stored value for its key, or a near-verbatim duplicate (token Jaccard
   ≥ 0.9) of another active fact in the namespace, is skipped and audited as `store_fact_skipped_duplicate`.
   Same-key different-value writes still take the supersede path. Exp 96 is the evidence that novelty is
   the right selection criterion; the gate is deliberately narrow because exp 105 found growth itself harmless.
6. `server/scripts/learning-ab.ts` + `learning-ab.tasks.json` — **the before/after harness**: runs the
   headless agent over a fixed task bank under a baseline and a treatment env, `--runs` times each (default
   2), every run in a fresh sandbox HOME with memory accumulating across the bank; writes per-task outcomes,
   the sandbox's `learning_metrics`, and `report.md` with per-task agreement across runs next to the
   configuration difference. Reading rule printed in the report: an effect smaller than the within-config
   disagreement is not a result.

## 3b. The shipped TypeScript predictor replayed on the exported ledger

Same protocol as the offline study (time order, warm on the first 70% = 19,269 calls, score the last
8,259, online update after each outcome):

| | AUROC | calls | failure rate |
|---|---|---|---|
| predictor, P(fail) ≥ 0.5 | **0.928** | 1,152 | **74.8%** |
| predictor, P(fail) < 0.5 | | 7,107 | 7.9% |
| per-tool base rate (first 70%) | 0.821 | | |

The online version scores above the offline batch fit (0.898) because it keeps adapting through the
test stream. This is the separation the shadow counters have to show in production before anything is
wired to the prediction.

## 3c. Third batch (2026-10-04): learn-time gates and evaluation rules from the RSI survey

From `rsi_survey_2026.md` §3, all flag-gated:

- **Keep-best revision acceptance** (`agent-memory/src/skill_repair.ts` keepBestDecision / versionRecords,
  applied in `SkillStore.recordSkillOutcome`; `PHILONT_SKILL_KEEP_BEST` shadow default | on | off). Each
  `reviseRecipe` snapshot now carries the cumulative success/failure totals at supersede time, so every
  version's own record is reconstructible. After an outcome on a recipe whose live version came from the
  repair driver and has ≥3 outcomes, if its Laplace rate is below the best earlier version's (≥3 outcomes),
  mode `on` restores that version through `reviseRecipe` (snapshotting the displaced one, ladder restarts
  at draft); shadow only reports. A restored version is not judged again against the one it displaced.
  Source: SkillRevise / Skill-α rollback reward / RSEA. Metrics `skill.keep_best.<action>.<applied|mode>`,
  audit `skill_revision_reverted` / `skill_keep_best_shadow`, controller `skill_keep_best`.
- **Self-authored skill safety scan** (`agent-memory/src/skill_safety.ts`, applied in `createSkill` and
  `reviseRecipe`; `PHILONT_SKILL_SAFETY_SCAN` default on). Ten pattern families (destructive rm, disk wipe,
  fork bomb, world-writable root, kill-all/shutdown, pipe-to-shell, sudo, credential exfiltration, disabling
  PHILONT_* gates / --no-verify, covering tracks). A hit on create stores the skill as `deprecated` (auditable,
  never recalled) with a `[quarantined by safety scan: <rule>]` suffix; a hit on revise refuses the revision.
  Externally imported SKILL.md files are exempt (`SkillInput.safetyScan: false`; their boundary is
  `skill_install_boundary`). Source: Practice Makes Unsafe / SafeEvolve. Metrics `skill.quarantine.<stage>`,
  audit `skill_quarantined`, controller `skill_safety_scan`.
- **A/B harness evaluation rules** (`server/scripts/learning-ab.ts`): `--holdout <family,…>` runs those tasks
  only at the end of each run (frozen held-out view; SEAGym), `--shuffle` runs the evolution stream in a
  seeded per-run order shared by both configurations (Fragility), the report prints the model in use
  (AgentStream) and ID / held-out columns separately. Two `holdout` tasks added to the bank.

Verification: agent-memory 1559/1559, server 1846/1846, tsc clean in both; mock-provider A/B smoke with
`--holdout holdout --shuffle --runs 2` produces the two-column report and distinct orders per run. Not yet
run against a real model (gateway 429) — every number in this file remains offline or synthetic.

## 3d. First real-model rounds of the learning A/B (2026-10-04, glm-5.3 via the owner's gateway)

Harness: `scripts/learning-ab.ts`, bank of 10 file/shell tasks (8 evolution + 2 held-out, two near-repeats),
2 runs per configuration, fresh sandbox HOME per run, memory accumulating across tasks within a run, held-out
tasks last, evolution order shuffled per run (same order for both configurations). Correctness from an
expected-answer regex per task; efficiency (tool calls / failed calls / seconds per task) from the sandbox
`memory_actions` ledger. Raw outputs stay on the owner's machine.

**A bug first.** Round 1 showed every learning metric at 0: headless defaults its memory DB to a path under
each task's `--output`, so no memory ever crossed a task boundary. Fixed in e5460e3 (`--memory-db` per
sandbox). Round 1 is kept as the "fresh memory per task" reference.

| round | treatment | ID correct (base / treat, 2 runs) | calls per task (base / treat) | case.inject.turns | note |
|---|---|---|---|---|---|
| ab1b | CASE_RECALL + NO_FILL | 8/8, 8/8 / 8/8, 8/8 | 5.2, 5.4 / 5.7, 7.2 | 0 / 9, 9 | cases injected on 9 of 10 turns, no efficiency change |
| ab2 | CASE_RECALL | 8/8, 8/8 / 8/8, 8/8 | 6.5, 2.9 / 6.1, 5.7 | 0 / 9, 9 | baseline runs differ 2x from each other |
| ab3 | NO_FILL | 8/8, 8/8 / 7/8, 8/8 | 5.0, 5.1 / 6.1, 4.3 | 0 / 0 | no skill recall fired in either arm (bundled skills do not match these goals) |
| ab4 | CASE_RECALL + NO_FILL + KEEP_BEST=on | 8/8, 8/8 / 8/8, 8/8 | 6.4, 5.1 / 5.8, 4.7 | 0 / 9, 9 | treatment slightly faster/fewer failures (0.2/0.0 vs 0.4/0.1 per task), opposite sign to ab1b; keep-best and safety-scan metrics 0 (no skill was authored or repaired) |

What the data say: (1) the bank is at ceiling for this model (13 of 14 runs 8/8 correct), so correctness
cannot show a learning effect (17 of 18 runs 8/8 with ab4); (2) within-configuration run-to-run variation in call counts (2–3x; one task
11/13/4/6) exceeds every configuration difference; (3) the mechanisms work as designed — the judge records
4–9 success cases per 10-turn run, case recall injects on 9/10 turns, the predictor scores every call in
shadow (P(fail) ≥ 0.5 once per run, and that call succeeded; failure rate of the bank ≈ 4%), reflection
fires 0–5 times — but none of them has anything to improve: the repeat tasks already take 1–2 calls without
memory. This is the product-side instance of philosophers exp 108 (a procedure the model already has adds
nothing) and the mirror of exp 110 (the same memory forms gain +9 to +17 on ScienceWorld, where the model
starts at 40%).

Decision: no flag default changes from these rounds — no gain and no harm are both unmeasurable here. The
measurement itself is the result: the harness runs end to end on a real model, with held-out / shuffle /
correctness / efficiency columns and a known noise floor. Next: a bank where the model's first-round
accuracy is 50–80% and failures repeat (missing tools, environment traps, multi-step dependencies), ≥3 runs
per configuration; only then are CASE_RECALL / NO_FILL / KEEP_BEST defaults a data question.

## 3e. LifelongAgentBench OS (2026-10-04, glm-5.3): the first bank with headroom

Setup: 60 of the benchmark's 500 OS tasks (9–12 bash steps, 29 skills, script-judged) in dataset order; one
container per task (the benchmark's own image), philont's shell tool redirected into it via `PHILONT_SHELL_BIN`
(agent-tools, 8fd092d; **agent-tools must be rebuilt — the server loads its dist**); one sandbox + one memory
DB per run; 240 s wall per task. Baseline = shipped defaults; treatment = `CASE_RECALL=1, NO_FILL=1,
KEEP_BEST=on`. Two runs each. Harness: philosophers `experiments/112-philont-lab-os/`.

| run | correct | first/second half | hit 240 s wall | calls / failed calls per task | s/task |
|---|---|---|---|---|---|
| base r1 / r2 | 68.3 / 73.3 | 70→67 / 70→77 | 35 / 33 | 11.2 / 0.45, 11.6 / 0.30 | 218 / 216 |
| treat r1 / r2 | 70.0 / 71.7 | 70→70 / 67→77 | 18 / 23 | 10.8 / 0.15, 10.9 / 0.22 | 204 / 211 |

Findings. (1) Accuracy is 70.8 in both groups, flat within runs, identical per skill: the model's competence
on this bank is ~70% and no memory form moved it (AgentStream's frontier-model result reproduced on a
product). (2) The treatment finishes inside the wall in both runs (18/23 vs 35/33 tasks timing out; cross-run
spread 2 and 5) with fewer failed calls. The metrics show why: the baseline's reflection authored a
"task failed" playbook and antipatterns that the popularity fill injected into 37–41 of 60 turns; NO_FILL
suppressed that (0 injections) and the prompt carried 59 judge-verified cases instead. Irrelevant recall is
not neutral — here it costs time, not score (philosophers exp 103 in product form). (3) The learning judge
recorded 22–40 successes and **zero failures** in every run although 16–19 tasks were wrong: without a
deterministic rail it cannot see failure, so the case store is positive-only and the failure→constraint loop
has no input. (4) `skill.quarantine.create` counted 1–3 per run but no quarantined row survived in the
store; audit location to check (likely removed by draft pruning).

Decisions: NO_FILL has its first directional evidence (efficiency, 2/2 runs, visible mechanism) — one more
run with a shuffled order before flipping the default. CASE_RECALL injected on 59/60 turns with no
measurable effect; KEEP_BEST had nothing to act on. Next: feed the benchmark's exit code to the judge as a
deterministic signal so failures enter the case store; then the veto/predictor have something to learn from.

## 3f. LifelongAgentBench OS, batch 2 (2026-10-05): three configurations × two task orders

base (shipped) / nofill (`NO_FILL` only) / full (`NO_FILL` + `CASE_RECALL` + `KEEP_BEST=on` + the benchmark's
exit code written into `memory_cases` as the verdict, replacing the judge's row for that task). 60 tasks, same
shuffled order across configurations within a seed.

| config | correct s1 / s2 | timeouts | calls / failed per task | paired vs base (only-base / only-this correct) |
|---|---|---|---|---|
| base | 73.3 / 61.7 | 19 / 15 | 13.2 / 0.23, 13.1 / 0.52 | — |
| nofill | 78.3 / 63.3 | 20 / 15 | 12.9 / 0.40, 10.9 / 0.38 | 1/4, 3/4 |
| full | 73.3 / 66.7 | 23 / 13 | 12.0 / 0.35, 12.3 / 0.23 | 1/1, 2/5 |

1. **The §3e timeout halving is retracted as a general effect.** Batch-2 baselines produced no antipattern /
   playbook fill injections at all (the batch-1 baselines had 37–41 turns of them because reflection authored a
   "task failed" playbook early), so NO_FILL had nothing to block and the timeouts are equal. It remains a
   conditional mechanism: when the fill would inject zero-relevance lessons, suppressing them saves time; it never
   hurt (≥ base in 4/4 runs). **Default → on**, on the grounds that the path only ever adds noise.
2. **Failure cases in the store change nothing.** full holds 13 / 18 failure + 41 / 40 success cases and injects on
   59/60 turns; same-skill revisit accuracy 75 / 65 vs base 75 / 62; per-skill accuracy full ≈ nofill. A failure
   case rendered as prompt text does not alter behaviour (philosophers exp 104 again). Next: turn failure cases into a
   constraint at the tool-call layer (the failed command shape of a same-family task as a pre-dispatch warning or
   candidate narrowing), not more prompt text. `CASE_RECALL` stays off.
3. **Judge calibration, first truth column.** Over six runs the judge said success on 269 tasks of which **57 (21%)
   fail the evaluation script**; it said failure once; it was silent on 130 tasks (36%). It is blind to "did it, but
   not quite right" (permission bits, group ownership, a missing file). This fills the row the postmortem (§5.3)
   deferred for lack of a truth source.
4. **Safety scan false positives.** 8 quarantines across six runs, all legitimate task-family skills (`sudo -u
   outsider ls` as a permission check; `rm -f /var/log/chsh_failure`). Bare `sudo` and any `rm` under /var/log are
   normal on an administration task set. Rules narrowed in a8d3eda (sudo only wrapping destructive commands;
   /var/log only system logs / wildcard / history); agent-memory dist rebuilt before batch 3.
5. **Order effect.** Every configuration scores 7–12 points lower under order s2 than s1; only same-order pairs are
   comparable (Fragility's finding reproduced). Same-order agreement 53–58/60.

Flags: NO_FILL default on; CASE_RECALL off; KEEP_BEST shadow (no skill repair occurred in any run). Batch 3 (tasks
60–179, base vs full, two orders) is running to see whether a longer stream or more accumulated failure cases
changes any of this.

## 3g. LifelongAgentBench OS, batch 3 (2026-10-05): 120-task stream under the new default

base = new default (relevance pool fixed, NO_FILL on); full = + CASE_RECALL + exit-code truth cases + KEEP_BEST.
Tasks 60–179, same order per seed.

| run | correct | thirds (40 each) | timeouts | playbook.inject.turns | reflect.new_skill | cases (succ+fail) |
|---|---|---|---|---|---|---|
| base L1 / L2 | 70.0 / 73.3 | 72-62-75 / 75-78-68 | 34 / 28 | 106 / 35 | 18 / 14 | 75+4 / 83+2 (judge) |
| full L1 / L2 | 66.7 / 72.5 | 68-58-75 / 75-82-60 | 27 / 20 | 99 / 118 | 24 / 7 | 80+40 / 87+33 (exit code) |

Same-order pairs: L1 only-base 8 / only-full 4; L2 8 / 7. Judge said success on 15–28 tasks per run that the
checker failed (18–33%).

1. No learning curve in 120 tasks in any run. 2. With the relevance pool fixed, the shipped learning layer
is finally active — playbooks selected by relevance on 35–118 turns, 7–24 reflection-authored task-family
skills, 119 turns of case injection in full — and accuracy is unchanged. For a model of this strength on these
tasks, telling it how it did it before (skill, playbook, case, failure case) carries no information.
3. Where the failures are: not procedure but the **checker's conventions** — an unnamed "status file" is
`status.txt` in the named directory (or `/status.txt`), "permissions 770" means exactly 770 (the agent set
2770), the report goes to the stated path. These are environment-specific, unknown to the model, and
derivable from the failing acceptance clause — the dimension the model lacks (philosophers spec item 9).
4. "Hitting the same wall N times" appears in 14–23 answers per run because the recurrence detector treats
similar tasks as one task; those tasks are 75–80% correct, so it is report noise, not a failure cause.
5. The judge still records only successes; failures enter the store only through the external signal.

Flags unchanged (CASE_RECALL off — 8 runs of injection with no effect; KEEP_BEST shadow — no repairs).
Next (batch 4, harness-side first): acceptance-convention learning — run the failing task's acceptance
clauses one by one, distil {when, rule, check} from the failing ones, apply to later tasks by trigger words,
with two couplings: prompt text vs a verification turn the task must pass before it is accepted (the
candidate-set-vs-prompt contrast of exp 104/110 in tool-agent form). If the gate wins, it becomes a philont
controller (answer-time regen with the applicable conventions) and the convention store a memory table.

## 3h. LifelongAgentBench OS, batches 4–7 (2026-10-05): seven learning forms, one ceiling, one conclusion

All against the same-order new-default baseline (base_n: 48/60 and 40/60 on orders s1/s2). Paired counts are
only-arm-correct / only-base-correct; "non-timeout" compares tasks where neither side hit the 240 s wall
(batches 5–7 ran under heavier concurrency, which inflated timeouts).

| arm | mechanism | s1 | s2 | paired | non-timeout |
|---|---|---|---|---|---|
| convp | distilled acceptance conventions as prompt | 48 | 38 | 3/3, 2/4 | 34 vs 33, 27 vs 28 |
| hedge | fixed convention text (prompt-engineering ceiling) | 44 | 38 | 2/6, 2/4 | 17 vs 18, 17 vs 17 |
| verify | self-written acceptance script, fix turn on failure | 45 | 39 | 1/4, 2/3 | 28 vs 27, 25 vs 25 |
| verifyconv | + distilled conventions | 43 | 38 | 0/5, 2/4 | 24 vs 25, 13 vs 14 |
| verifycases | + the real checker's failing clauses of similar earlier tasks | 47 | 41 | 2/3, 3/2 | 31 vs 32, 26 vs 27 |
| **feedback** | **the real checker's failing clauses fed back for one fix turn** (ceiling, not the benchmark protocol) | **54** | **58** | **7/1, 18/0** | **29 vs 25, 38 vs 24** |

Self-written verifiers said OK on 8–20 tasks per run that the real checker failed, whatever they were
conditioned on. Conclusions:

1. **No learning form moved accuracy** on this bank for glm-5.3 — cases, reflection skills/playbooks,
   failure cases, convention prompts, fixed conventions, three self-verifier variants. The model does not lack
   procedure.
2. **The one paired net win is the retrieval fix** (relevance pool + no-fill): 48 vs 44 (4/0), 40 vs 37 (5/2),
   half the timeouts. It is hygiene on the read side, now the default (c881f4e).
3. **Failures are acceptance-convention mismatches and are repairable with the right signal**: with the real
   checker's failing clauses, 28 of 35 failures were repaired (54/60, 58/60). But that signal did not transfer
   across tasks in any form tried: each task's checker conventions are its own, and similar tasks' clauses do
   not predict a new task's checks.
4. **Implication for self-evolution on frontier models**: the lever is the acceptance signal, not the memory
   form. The product primitive worth building is an **in-task acceptance–repair loop** — wherever a real
   acceptance signal exists (tests, a checker exit code, a user correction, a downstream error), feed the
   failing points back into one repair turn of the same task and re-check. Cross-task memory stays for
   retrieval hygiene (relevance, no-fill, judge calibration), not for score.
5. Evaluation discipline that held: two orders per configuration (order effect 7–12 points), same-order
   pairing, non-timeout comparison under uneven load, no result below ~4 tasks of 60.

Flag decisions (final): `PHILONT_SKILL_RECALL_NO_FILL` on (default); `PHILONT_CASE_RECALL` off;
`PHILONT_SKILL_KEEP_BEST` shadow; `PHILONT_FAILURE_PREDICTOR` shadow (P(fail) ≥ 0.5 fired once per run, never
on a failure — this bank's failure rate per call is ~3%); safety scan on with the narrowed rules.

## 3i. SOTA self-improvement methods head to head (2026-10-06, philosophers exp 113)

Same bank (LifelongAgentBench OS), same protocol (5 rounds, script-judged), two locally served models, eight
arms around one plain ReAct agent, three task orders × 120 tasks, paired within order.

| arm | Qwen3.5-27B Δ vs plain (3 orders) | Qwen2.5-7B Δ vs plain |
|---|---|---|
| experience replay (similar successful trajectories) | **+5.8** (3/3) | **+5.3** (2/3) |
| Agent Workflow Memory (induced workflows) | **+4.2** (3/3) | **+5.3** (2/3) |
| Memento case bank (task, plan, reward) | **+3.9** (3/3) | −4.7 |
| ACE evolving playbook | +1.7 (2/3, 4× tokens) | −1.4 |
| Reflexion (failure reflections) | +0.6 | **−7.2** (0/3) |
| ReasoningBank (distilled memory items) | −0.6 | −3.6 |
| acceptance-feedback loop (checker clauses → one repair turn; outside the protocol) | **+20.0** (72 gained / 0 lost) | +5.6 (repairs <15%) |

Plain ReAct: 27B 65.6, 7B 38.1; the benchmark's published 8B replay gain (0.43→0.50) is reproduced in size.
No arm shows a within-stream learning curve.

**Where philont stands.** philont's learning layer writes reflection prose (routing rules, playbooks, skill
text) — the family that does not win at 27B and is harmful at 7B. Its measured net win (§3f) is retrieval
hygiene, not content. Run through the local 27B, philont was wall-clock-bound (≈26k-token prompt, ~50 s per
call, 18–21 of 28 tasks hit the 300 s wall; 7B cannot drive its tool protocol), so its accuracy there is not a
capability number; the fair rerun needs a 900 s wall or a trimmed prefix.

**Recommendations for the self-evolution loop.** (1) Store experience as structured trajectories / induced
workflows retrieved by task similarity (replay + AWM form), not as reflection prose; keep the judge-verified
case store but render its *trace*, not a summary. (2) Build the in-task acceptance–repair primitive: wherever a
real acceptance signal exists (tests, checker exit code, user correction), feed the failing points back for one
repair turn and re-check — the only mechanism here that moved a frontier-class model by more than noise.
(3) Trim the per-call prefix so philont can be evaluated on local models at all. Flags unchanged
(NO_FILL on; CASE_RECALL off; KEEP_BEST shadow; predictor shadow; safety scan on).

## 3j. philont vs the methods on the same model (glm-5.3, same 60 tasks × 2 orders)

| arm | s1 | s2 | paired vs plain ReAct | s/task |
|---|---|---|---|---|
| philont + real acceptance feedback | **54** | **58** | 8/1, 17/0 | 239 / 223 |
| plain ReAct + acceptance feedback | **52** | **54** | 8/3, 13/0 | 28 / 29 |
| philont new default | 48 | 40 | 3/2, 1/2 | 189 / 182 |
| ReAct + Memento / Reflexion / ReasoningBank / ACE / AWM / replay | 44–48 | 38–43 | all within ±5, signs inconsistent | 22–29 |
| plain ReAct | 47 | 41 | — | 27 / 24 |
| philont shipped (old default) | 44 | 37 | 1/5, 1/5 | 204 / 207 |

On a frontier-class model, philont's learning layer and every published self-improvement method tie with a
memoryless ReAct agent; philont's new default equals plain ReAct in accuracy at seven times the latency, and
the old default was 3–4 tasks below it (the relevance bug). The only separation is the acceptance-repair loop;
philont's scaffold is marginally better than plain ReAct at the repair step (+2/+4, within noise). This is the
direct answer to "does philont beat AWM / Memento / ACE": no net win and no net loss in accuracy, a real loss
in cost. The gains these methods show at 27B (+4–6) and 7B (+5 for structured memory) vanish here.

## 3k. The acceptance–repair loop, shipped and measured (2026-10-06)

Shipped: `headless --acceptance-cmd <sh> [--acceptance-repairs n] [--acceptance-timeout s]` (acceptance_check.ts).
After the task turn the command runs through the same shell program as the `shell` tool; on a non-zero exit its
output — or, for a silent `&&` chain, the clauses that fail when run one by one (v2 diagnosis) — is handed back
verbatim as the next user message, the check re-runs, up to n repairs. The verdict is recorded as the session's
case (basis `acceptance_cmd`) and as metrics `acceptance.check.*` / `acceptance.repair.*`; controller
`acceptance_gate`. Tests: server 1852/1852.

Measured so far (glm-5.3, LifelongAgentBench OS, same 60 tasks × 2 orders as §3f):
- v1 (exit code only), 300 s wall: 42 / 41 — the loop fired on 8 / 3 of ~18 failures (the wall was spent before
  the check) and the agent, told only "exit code 1", repaired 1 / 0. With a 600 s wall (partial, 47 / 45 tasks):
  39 / 36 correct, repairs 7 / 8, fixed 3 / 1. The harness-side loop that named the failing clauses had repaired
  28 of 35 (§3h). The missing piece was the diagnosis, not the loop → v2 names the failing clauses; a 1200 s run
  is in progress.
- ScienceWorld (philosophers exp 114, `sw --accept` = score 100): philont stock 90.9 → with the loop 94.9 adapt;
  first-episode perfect tasks 6/10 → 9/10. The loop is an in-episode effect (the score is a real signal).

Decomposition on ScienceWorld, a world the model does not know (one run per arm, 80 episodes): plain agent 40;
plain agent that sees the legal-action list 57 (+17 tool affordance); philont with a fresh memory per episode 84
(+27 in-episode machinery); philont with its cross-episode memory 91 (**+7, the first positive measurement of the
learning layer**, at the edge of single-run noise); + acceptance loop 95. The learning layer's gain ranks behind
tool affordance and in-episode machinery, and appears only where the model lacks the world's mechanics.

## 3l. Verifier-centric self-improvement, tested (2026-10-07, philosophers exp 115)

Method under test: the learning layer accumulates an **executable check bank** grown only from real failures
(the checker's failing clauses), bound but never rewritten by the model, executed before acceptance with one
repair turn; plus the shipped acceptance loop; plus a learned "when to verify" gate.

| setting | plain | check bank | ACE playbook | replay / cases | real-feedback ceiling |
|---|---|---|---|---|---|
| LAB OS (conventions differ per task), 60 × 2 | 47 / 41 | 43 / 40 | — | — | 52 / 54 |
| ConvStream (8 templates, stable unstated conventions), 100 × 2 | 77 / 65 | **87 / 79** | **84 / 88** | 77–78 / 72–78 | 94 / 94 |

On ConvStream both failure-derived forms show the first within-stream curves of the study (ACE 75→95, bank
70→85); replay and cases do not. Per template: on the two conventions the model never guesses (unnamed
status file, literal mode) success memories score **0%**, failure-derived learning 38–64%, real feedback 82–86%.
The budget gate reaches AUROC 0.67 (judge alone 0.57) and is dropped: run every available check.

**philont's native acceptance loop v2** (headless `--acceptance-cmd`, clause-level diagnosis, 1200 s wall):
**59/60 and 56/60** on the LAB tasks (repairs 14→13 fixed, 19→15), above the harness-side loop (54/58) and far
above the stock agent (48/40). v1 with only the exit code repaired 6/32.

Implications for philont: (1) keep the acceptance loop on wherever a mechanical signal exists — it is the
only primitive that moved a frontier model, and diagnosis granularity is what makes it work; (2) the
cross-task learning layer should hold two kinds of memory with different triggers — success trajectories /
workflows for what the model can do, and failure-derived rules or executable checks for what it does not know
to check — and the second only pays where failures recur (a user's conventions, a codebase's tests), not on a
stream of unrelated tasks; (3) reflection prose remains the weakest form of either; a check bank or ACE-style
counted rules are the forms with evidence.

## 4. From the 2026 self-improvement literature, what this adds and what it repeats

philont's post-mortem already absorbed the verification hierarchy, SEAL-style sealed audits, RSEA's
keep-better gate and ModularRSI's contrast pairing. Three later results sharpen the same points:

- *On the Fragility of Self-Improving Agents: Variance, Task Order, and Underspecification*
  (arXiv 2608.18066) — self-evolution outcomes vary with task order and seed; this is the run-to-run
  noise measured above (±18 points) and the reason for the two-runs rule.
- *Practice Makes Unsafe: Skill Misevolution in Self-Improving LLM Agents* (arXiv 2608.12851) — skills
  drift toward unsafe shortcuts under reuse; philont's retire-on-contradiction and the predictor's
  shadow-first posture are the matching defences; it argues against any auto-enforced veto.
- *SEAGym* (arXiv 2606.17546) and *AgentStream* (arXiv 2608.00155) — held-out views for update
  validation and streaming-task evaluation; the sealed replay bench is philont's instance, still limited
  to tools with an oracle. Extending it to a fixed task bank with the learning layer on/off is the
  missing measurement named in §1.

Memento / Memento-Skills (Jun Wang, UCL): the structured case `(task, plan, verdict)` with the judge's
verdict as reward is the one piece worth copying wholesale — it replaces part of the reflection text with
a verifiable record; their learned retrieval policy added 0.4–1.3 points over similarity and is not
worth its online reward plumbing here; their skills did not transfer across GAIA's diverse tasks, the same
finding as PHYRE's zero cross-template transfer and philont's "most skills never triggered".
