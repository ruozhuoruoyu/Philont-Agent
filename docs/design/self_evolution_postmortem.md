# Self-Evolution Post-Mortem — Why the Loops Never Closed, and What 2026 RSI Work Adds

Status: WRITTEN 2026-09-20. Companion to `self_learning_redesign.md` (the plan) — this is the
diagnosis, the external evidence, and the list of what was absorbed and what was deliberately not.
Author: ruozhuoruoyu

---

## 1. The claim under examination

philont has carried "self-learning" since spring: turn-close reflection distilling routing rules,
playbooks and skills; a skill maturity ladder; a routing-rule confidence machine; an idle-time
session reflector; and since summer a mechanical-repair loop. Production never showed the effect
that machinery promised. The numbers that make the case (all from the code's own counters and the
7-day learning-stats dumps):

| Signal | Value | What it means |
|---|---|---|
| routing rules stored / `validated` | 1022 / 0 | not one rule ever earned its confidence tier |
| `reflect.fire` / `routing_rule` produced (one week) | 753 / 800 | reflection never lacked output |
| same tool failure recurring in that week | ×38 | the output changed nothing |
| `use_skill` calls per turn | ~2% | the maturity ladder's only feedback edge almost never fires |
| skill "confirmed" meaning | fetched twice | `incrementUseCount` credited a fetch as a success |
| playbooks retired | 0 | created once, injected forever, never validated |

## 2. Root cause: unverified artifacts, produced faster than anything measured them

Each sub-loop failed for a locally different wiring reason (documented in
`self_learning_redesign.md` §1), but the reasons share one shape:

1. **Creation had no gate.** Every reflection could write; nothing had to be true first. A
   routing rule was born from a single turn's last 12 messages, a playbook from one failure, a
   skill from one apparent success — the LLM's own reading of its own transcript.
2. **Measurement was sparse, and success-only where it existed.** `recordRuleOutcome` recorded
   success on clean turns and *nothing* on failed turns ("ambiguous"), so the confidence machine
   was a one-way ratchet that still never reached `validated`, because promotion required the same
   keyword-matched rule to be re-injected on consecutive clean turns — and injection was keyed on
   user-message keywords, not on the failure the rule was about.
3. **Nothing retired.** Playbooks were exempt from the draft cap and had no outcome edge. Rules
   decayed on age only. The store grew; the prefix grew; recall quality fell (the FIFO conveyor
   that deleted never-tried hypotheses was the first thing the 2026-08 audit found).
4. **Every fix added another attribution edge** — "did THIS artifact help THIS turn?" — which is
   the hardest signal to obtain in a chat agent. The paradigm, not the wiring, was the problem.

Meanwhile every real production failure fixed in the same period (fabricated "已跑通", auth
questions read as consent, offered words nobody matched, UUID mis-transcription, naming splits
that dropped every push for months) was a **grounding** failure, not a missing skill. The learning
machinery was optimizing an axis on which the agent was not failing, while the axis on which it
was failing had no learner at all — only hand-written gates.

## 3. External evidence (2026)

The recursive-self-improvement literature of 2026 measured the same thing at scale. The relevant
results, with what each one says about §2:

- **Verification hierarchy** (survey of 1,250 papers, arXiv 2607.07663): demonstrated
  self-improvement strength tracks the strength of the verification signal — formal verifiers >
  execution feedback > learned judges > the model's own assessment. Ten rounds of ungrounded
  self-critique lose 55% of their information content: reformulation, not progress. *philont's
  reflection was at the bottom rung.*
- **LLM-authored skills show no measurable gain** (SkillsBench, via the same survey): human-written
  skills +16.2 points, LLM-written ≈ 0 without evaluation-guided refinement. *The skill store's
  1022 rules were the expected outcome, not a bug.*
- **Self-authored verification is unreliable** (arXiv 2607.24300): an agent that edits both its
  policy and its own tests reaches self-scores above 0.7 in every run while 15 of 35 final policies
  score below random. The remedy (SEAL) is a sealed, agent-invisible held-out audit returning only
  accept/reject. *This is why the learning judge has deterministic guard rails outside the model.*
- **Unguarded context evolution is high-variance** (RSEA, arXiv 2606.28374): a rewriting playbook
  gained on one benchmark and collapsed 0.43 → 0.14 on another; the fix is a keep-better gate on
  a disjoint held-out split, with reversion to the baseline. *Playbooks injected forever with no
  gate are exactly the unsafe configuration.*
- **Reward hacking widens with steps** (Reward Hacking in Self-Improving Code Agents): proxy
  gains without real gains rise from 26% at 10 steps to 58% at 100. *A loop that runs longer
  without an external check gets worse, not better.*
- **ModularRSI** (arXiv 2609.14857, IQuestLab/ModularRSI) — evolved a coding harness with
  **DeepSeek-V4-Flash**, philont's own model: five modules evolved each within a restricted scope;
  same-task success/failure trajectories paired by a read-only "contrast investigator" whose
  finding is pinned to one module; findings clustered by how many *distinct tasks* support them
  before anything is implemented; a reward-blind review that judges mechanism, not score; a
  benchmark-disjoint evolution set. The evolved modules are, in effect, the catalogue of ways
  V4-Flash fails on long tasks: evidence-gated completion, rejecting task_complete while extracted
  requirements are still pending, repeated-command detection, an inspection-only guard,
  parse-error recovery that shows the model its own malformed output and escalates to a strict
  template, full observation instead of truncated stubs, and a background-process-death check.
  Gains are modest (TerminalBench 47.6 → 52.4, SWE-Bench Verified 73.4 → 76.5) but transfer across
  tasks and across foundation models.

The convergence matters more than any single number: a machine searching harness space on the
same model rediscovered the gates philont built by hand from production logs (honesty gate,
claim grounding, in-turn reflection, viability gate, plan protocol). What it found that philont
lacked is now closed (§4). What philont has that no benchmark exercises — the deployed failure
catalogue of §2's last paragraph — is the part worth writing up.

## 4. Absorbed on 2026-09-20

| Mechanism | Source | Where |
|---|---|---|
| Format-failure ladder: echo the model's own input, then the expected shape, then a strict one-call template; unknown tool names recorded and answered with the closest real names; format failures are their own signature class and never lock the tool | ModularRSI `parse_error_recovery` | `server/src/format_recovery.ts`, `failure_signatures.ts`, `llm-adapter.ts` (`safeJsonParse` no longer degrades to `{}`), `chat-handler.ts` rejection branches |
| Inspection-only streak nudge (trailing run of local read-only calls) | ModularRSI `planning_with_guard` read-only guard | `in_turn_reflection.ts` `detectInspectionStreak` |
| Positive artifacts require a judge-verified success (creation ≤ measurement) | RSEA keep-better gate; SEAL; redesign Phase 2.1 | `reflection.ts` `ApplyReflectionOptions.verifiedSuccess`, `reflection_runner.ts`, judge verdict hoisted in `chat-handler.ts` |
| Cross-turn evidence in reflection: this turn's failure classes counted across the ledger (sessions, occurrences) are rendered into the prompt; an avoid-only routing rule must name a signature seen in ≥2 sessions or it is withheld (a one-turn lesson is a playbook) | ModularRSI cross-task vote on findings | `reflection.ts` `signatureSupport`/`requireCrossTurnSupport`, `reflection_runner.ts` `buildCrossTurnEvidence` |
| Contrastive pairing: each recurring failure class is shown next to the same tool's later successful input | ModularRSI success/failure trajectory pairing | `reflection_runner.ts` `buildCrossTurnEvidence` (`allActions`), `reflection.ts` `renderCrossTurnEvidence` |
| Playbook negative edges: contradiction (shown, failure recurred; 3 in a row → deprecated) and disuse retirement (old, often shown, failure gone from the ledger) | redesign Phase 2.4 / 0.2 (demotion-only for prose) | `skill_maturity.ts`, `skills.ts` `retireStalePlaybooks`, `chat-handler.ts` prefix + turn close + idle tick |
| Routing rules' negative edge: avoid rules store their failure signature (schema v48); a rule injected in a turn where that signature recurred is recorded as failure and denied success credit | same contradiction rule as playbooks; redesign Phase 2.4 | `routing_rules.ts`, `chat-handler.ts` routing outcome block, `reflection_runner.ts` `rulesContradictedThisTurn` |
| Sealed replay bench: a fixed bank of pinned failures (≥2 sessions or rule-backed, one per class), re-run on idle under current rules with the tool as oracle; learned repair lines are candidates until they turn a fixture green where accepted rules did not; redundant/failed candidates dropped; a rule change that turns green to red is reverted | SEAL sealed audit; RSEA keep-better; ModularRSI benchmark-disjoint set + cross-task vote | `server/src/replay_bench.ts`, candidate ledger in `mechanical_fix_learning.ts`, idle tick in `chat-handler.ts`, `learning_stats.ts` |

Deliberately **not** absorbed:

- The evolution pipeline itself (Harbor/Terminus-2, Python, one Docker sandbox per task). philont
  has no task set with verifiers in its main domains; the release is CC BY-NC 4.0 and philont is
  MIT, so nothing is copied — the mechanisms above are re-implemented from the paper's description.
- Background-process death detection: philont's `process` tool already reports `exited(code)` on
  every `status` poll; the failure mode is the agent not polling, which the inspection/act split
  above does not address and a dedicated guard would only duplicate.
- Evaluator co-evolution (Red Queen Gödel Machine), two-timescale meta-skills (MetaSkill-Evolve),
  and agent self-modification of its own source (Darwin Gödel Machine): over-engineering at
  philont's scale without a held-out bench; "Simple Baselines are Competitive with Code Evolution"
  (arXiv 2602.16805) is the standing caution.

## 5. What is still missing, in order

1. **Widen the bench's reach.** The bench gates what has an oracle: repair lines for allow-listed
   answer-producing tools (pariGp, z3Verify, leanCheck by default; `PHILONT_REPAIR_REPLAY_TOOLS`).
   Draft recipes already replay through `draft_validation.ts` against the rolling ledger; moving
   them onto the pinned bank is the next step. Routing rules and playbooks remain ungated because
   prose has no executable check — the honest options are the judge-gated crystallization already
   in place and, later, offer-vs-withhold comparison on the judge's verdicts.
2. **Legacy rules.** The 1000+ rules written before today carry no signature and so have no negative
   edge beyond unproven-decay; they will leave through decay, not contradiction. That is acceptable —
   none of them ever reached `validated` either.
3. **Judge calibration** stays deferred: it needs a per-turn truth column, and none exists beyond the
   deterministic rails already applied. An owner-correction signal would provide one; building a
   confidence table before that source exists would be data nothing consumes.
4. **The development discipline itself**: a finding needs ≥2 distinct tasks before a patch, one
   module per patch, review that judges mechanism not score, replay on fixtures before ship. This
   is what ModularRSI automates; done by hand it is what stops the same class from shipping twice.
