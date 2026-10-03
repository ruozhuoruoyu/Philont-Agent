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
