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
| ab4 | all + KEEP_BEST=on | see addendum | | | |

What the data say: (1) the bank is at ceiling for this model (13 of 14 runs 8/8 correct), so correctness
cannot show a learning effect; (2) within-configuration run-to-run variation in call counts (2–3x; one task
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
