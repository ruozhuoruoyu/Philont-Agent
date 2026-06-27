# Motivation-Loop Architecture — philont's personality drive on a goal-loop spine

Status: DESIGN — master framing. Author: ruozhuoruoyu.
This is the capstone that reorganizes the scattered loop-engineering workstreams into ONE architecture.
Detail docs: `execution_ledger_anchor.md`, `sub_agent_capability.md`, (`goal_loop_runtime.md` — to write).

## 1. Thesis

philont's self-drive is **intrinsic / personality-based** (好胜心 / 好奇心 / 尽责 — competitiveness,
curiosity, conscientiousness), not goal-based. Loop engineering's self-drive is **goal-based** (a goal +
a stop condition + a contract). These are not competitors — they are different layers of one motivation
stack:

> **philont = an intrinsic personality drive (the WHY / energy / persistence)
> on a goal-loop discipline spine (the direction / bounds / truth / convergence).**
> Without the spine, the drive runs away — divergence and fabrication (both observed this cycle).
> Without the personality, it is a soulless cron.
> Together: **trustworthy (spine) + proactive (personality) + continuous (loop)** — the positioning charter.

The single most important reframe: **most of the bugs fixed this cycle were the same root** — personality
energy with no goal-loop discipline:
- deep_explore infinite divergence (好胜/好奇 generating hypotheses forever) → the ceiling/phase-gate fixes
  were imposing loop discipline.
- fabrication (the "confident second brain" persona rewarding "sounds solved") → the execution-ledger
  anchor is the truth discipline.
- recite-without-running / no-follow-up → missing the loop's ACTION/REPORT contract.

So: don't replace the personality with goals — **give the personality a spine.** The personality is
philont's differentiator (a pure goal-loop agent is a commodity); the spine is the missing discipline.

## 2. The three layers (the motivation stack)

```
MOTIVATION   intrinsic traits (好胜/好奇/尽责)  ──generate + flavor──┐
                                                                    ↓
             user-assigned goals  ────────────────────────────→  GOAL = def-of-done (resolutionCriteria)
                                                                         + contract (trigger/budget/stop/report)
                                                                         ↓ (contract TUNED by traits)
GOAL-LOOP                                                  self-driving tick (generalized auto-advance)
                                                                         ↓ each tick body
EXECUTION                                       plan (task slice) / deep_explore (reasoning) / tools
                                                                         ↓ reads
TRUTH                                           execution-ledger anchor (this-turn ledger + tree + plan state)
                                                                         ↓ steers
DIRECTION                                       trajectory score → continue / stop / escalate / switch-engine
                                                                         ↓
REPORT                                          proactive milestone / stuck / ask (traits flavor: 好胜=进展 / 尽责=卡住)
```

The personality×loop integration point is **trait-tuned contracts**: a generic loop has a fixed
budget/stop; philont's is set by traits — 好胜 → try more rounds before declaring stuck; 好奇 → diverge
wider per tick; 尽责 → report stuck earlier. This is what makes it a *personality* running a loop, not a
cron.

## 3. Audit — what exists vs the gap (reorganized)

| Loop-engineering element | philont's existing piece | Gap |
|---|---|---|
| Loop = cron + decision-maker | autonomous tick + drivers; deep_explore auto-advance | drives fire ONE-SHOT research, not goals; auto-advance is deep_explore-only + opt-in + off |
| Goal w/ def-of-done | pursuit.resolutionCriteria | disconnected from plan + from any loop |
| Tick body (decompose/execute/revise/close) | **plan** (`plan_protocol_gate`, `PlanStore`, plan.md inject, close→playbook) | REACTIVE entry (user-turn + slow-classify), bounded, user-pull — a great BODY, wrong LOOP entry |
| Anchor / progress-on-disk | plan.md inject + reasoning tree + facts/notes | three SILOS; model still answers from the 25 KB narrative, not the ledger |
| Feedback / "the mechanism that says no" | honesty / viability / numeric / fabrication / barrier gates | **ahead of frontier** — keep as backstop |
| Stop / budget caps | per-tick/daily caps, no-progress stop, candidate ceiling | present; need a trajectory-level signal above per-round |
| REPORT (proactive) | autonomous fires interrupts (next-turn context only) | **no user-facing proactive report** |
| Skills compound | reflection→skills + recall (db22ae5) | skills aren't verified recipes; authoring from success missing |
| Sub-agents / parallel | mini-agent-loop + planAndExecute (sequential) | no parallel isolated-context orchestration |

**philont is ahead on the discipline gates and stop/budget; behind on the SPINE that connects drives →
goals → a bounded self-driving loop → truth → report.**

## 4. Consolidated workstreams (supersedes the old ①②③④/A/B numbering)

### Spine (the structural core)
- **S1 — Execution-ledger anchor** (`execution_ledger_anchor.md`; was ①, absorbs C). Per-tick truth: this
  turn's tool ledger + reasoning-tree state + **plan step-status** unified into ONE authoritative block the
  model answers from. Roots out fabrication at generation time; makes the gates a rare backstop.
- **S2 — Goal-loop runtime** (`goal_loop_runtime.md`, to write; was A + the entry redesign, absorbs ② and
  auto-advance). **Entry change**: keep the REACTIVE plan entry for "do X now"; ADD a **commit-goal entry**
  (a goal → a pursuit-as-loop + contract), driven by **generalizing `deep_explore_autoadvance` into a
  unified goal-loop driver** (it already has tick + stuck-escalate + notify). plan/deep_explore become the
  tick BODY; the proactive ask + auto-advance become this loop's REPORT/TRIGGER parts.
- **S3 — Trajectory scoring + meta-control** (was B). A multi-turn progress metric per goal that drives
  continue/stop/escalate/**switch-engine** — e.g. detect "formal+pariGp on a meta-math goal settled 0 in 2
  rounds → switch to deliberate" (the observed P-vs-NP waste). The loop's sense of direction.
- **S4 — Drives→Goals + trait-tuned contracts** (NEW, from the §1 synthesis). Intrinsic drives generate
  GOALS (not one-shot lookups); traits tune each goal-loop's contract (persistence/breadth/report). The
  personality×loop integration — philont's differentiator.

### Hands / supply (capabilities the spine uses)
- **H1 — Sub-agent parallel orchestration** (`sub_agent_capability.md`; was ④). Parallel isolated-context
  tick bodies. Zero-wiring P0 is safe to land anytime.
- **H2 — Skills as verified recipes + recall** (was ③). Recall done (db22ae5); remaining = author a
  callable verified recipe from a successful trajectory → loops compound (Skills compound; prompts burn).

## 5. Sequencing (dependency-ordered)

1. **Phase 1 — Truth & first REPORT.** S1 execution-ledger anchor (highest leverage; everything downstream
   trusts the ledger). Ship the proactive-ask as the first REPORT slice (it is already recon'd / ready).
2. **Phase 2 — Spine.** S2 goal-loop runtime (commit-goal entry + generalized driver) + S3 trajectory
   score. This is the "loop engineering" capability proper.
3. **Phase 3 — Personality on the spine.** S4 drives→goals + trait-tuned contracts.
4. **Anytime / parallel.** H1 sub-agent P0 (zero behavior change); H2 recipe-authoring later.

Already landed this cycle (instances of the spine discipline, not yet the spine itself): deep_explore
candidate ceiling (f2cfb79), 假说≠维度 (80c8fb1), skill recall (db22ae5), file-logger (892086c),
announce-stall gate (c40e464), default-on flags (7b93288), continue ping-pong fix (02382c2),
force-continue (3ed149d).

## 6. Principles / guardrails

- **Keep the personality.** Traits TUNE the contract; they are never overridden by it. A goal-loop without
  personality is a commodity cron.
- **The spine is discipline, not a cage.** Its job is direction + bounds + truth + convergence, so the
  drive produces *bounded, verified, reported* progress instead of runaway/fabrication.
- **Truth before autonomy.** S1 (ledger) ships before S2 (self-driving loops) — an unsupervised loop that
  can fabrication is worse than no loop. The ledger is the precondition for trusting autonomy.
- **Flag-gated, default-off until proven; flag-off byte-identical** (the skill-recall / file-logger
  pattern). Gates stay as backstop even after the ledger makes them rare.
- **One level of loop nesting; sub-agents read-only by default; verification teeth always apply.**

## 7. Non-goals

Replacing the personality/constitution with a goal stack; removing the honesty gates; distributed/remote
execution; changing memory storage.
