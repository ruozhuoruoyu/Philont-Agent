# Self-Learning Redesign — Verify-then-Condense

Status: PROPOSED (2026-07-15). Baseline for iteration, not yet implemented.
Author: ruozhuoruoyu

This plan consolidates a code-level audit of philont's self-learning loops and a design
discussion around four questions: (1) how to better use the memory layers, (2) reliability
vs. learning, (3) failure-driven vs. success-driven learning, (4) how to reorganize the
*existing* components so philont becomes both more robust and progressively more intelligent.

It is deliberately grounded in what already exists. Almost nothing here is a new subsystem;
most of it is re-wiring components philont already has, plus one genuinely missing keystone
(a judge) and one organizing principle.

---

## 1. Diagnosis (from code, not comments)

philont has three self-learning sub-loops. Traced through actual call graphs, **none of them
closes in normal operation**, and several code comments that claim "true closed loop" /
"FULLY IMPLEMENTED" are not supported by the code.

- **Skill maturity ladder** (`skills.ts`, `skill_maturity.ts`, `reflector.ts`): production +
  injection are alive, but the feedback edge `recordSkillOutcome` fires only via a `use_skill`
  call — measured at **10 calls in 462 turns (~2%)** by the code's own counters. Worse, the one
  edge that does fire (`incrementUseCount`, `skills.ts:473`) credits **success merely for
  fetching a skill's body** — so "confirmed" means "retrieved twice", not "worked twice".
  `pruneDraftsToCap` runs every session close and deletes never-tried drafts (FIFO conveyor,
  `draft` pinned at the cap of 40, `validated=0`).

- **Routing-rule confidence machine** (`routing_rules.ts`): `recordRuleOutcome` now has exactly
  one live caller (`chat-handler.ts:~6030`) — the "0 callers / dead data" comment is stale — but
  it **always records success and never failure**, so it is a one-way ratchet. Promotion to
  `validated` requires the *same* keyword-matched rule to be re-injected on consecutive clean
  turns; injection is keyed on keyword overlap with the *user message* (`routing_inject.ts`), so
  the tool-execution-failure rules the system most wants to learn rarely re-match. Historical
  production: 1022 rules stored, `validated=0`.

- **Playbook loop** (`plan_tools.ts`, `reflection.ts`, `buildMemoryPrefix`): fully write-only.
  Creation + injection are alive; there is **no `recordPlaybookOutcome` anywhere**, playbooks
  are non-callable and excluded from the skill index, `pruneDraftsToCap` explicitly exempts
  them, and `nextMaturity` pins `playbook` as a terminal state. Created once, injected forever,
  never validated, never retired.

**Root cause (paradigm, not wiring):** all three try to do *online, per-artifact attribution* —
"did THIS artifact help THIS turn?" — which is the hardest possible signal to get in a chat
agent: sparse and noisy. Every "fix" that adds another attribution edge fights the same
headwind.

**Corroborating evidence:** every real production failure fixed the week of 2026-07-14
(fabricated "已跑通", auth questions read as consent, offered words nobody matched, UUID
mis-transcription, mis-attribution) was a **reliability / grounding** failure. **Zero were
"the agent lacked a skill it should have learned."** The skill-acquisition machinery is
optimizing an axis where philont does not currently fail — but see §3, this is partly
survivorship bias (a broken skill system produces no visible skill wins either).

---

## 2. Organizing principle: Verify-then-Condense

> Knowledge flows up a layered hierarchy, and only condenses to the next level once it is
> **verified** at the current level. Verification gives robustness; condensation gives learning.
> They are the same pipeline, not opposing goals.

This directly answers Q2 (reliability vs. learning): they are not a trade-off. philont's own
constitution already says it — *"learning depends on honesty: a pretended failure corrupts your
memory."* Reliability is the precondition that keeps learning from poisoning the store.
Learning is the moat; reliability is the valve that keeps the moat clean.

### The five layers (Q1)

philont has ~19 stores; grouped by knowledge concentration they form five layers:

| Layer | Stores | Role | Also |
|---|---|---|---|
| **L0 Episodic** | `raw`, `actions` (timeline) | verbatim record of what happened | **the latent eval set** |
| **L1 Semantic** | `facts` (bitemporal: `validFrom`/`validUntil`, `getActiveAt`) | what is true about user/world | current-vs-previous substrate |
| **L2 Procedural** | `skills`, `plans` | how to do a thing | condensed from **success** |
| **L3 Guards** | the ~10 `*_gate.ts`, playbooks | which class of error not to repeat | condensed from **failure** |
| **L4 Meta** | `routingRules`, `configRules` | when to apply which L2/L3 | |

The layers are today used only for **recall** (inject into the prompt). They are not used for
**answer-time reasoning** (L1's bitemporal facts are never organized into a stale-vs-current
evidence ledger), and L0 is never used as an **eval substrate**. The redesign makes the layers
a *promotion hierarchy* — L0 events → L1 facts → L2 skills (success) / L3 guards (failure) —
where each upward step is gated by verification.

---

## 3. The two learning engines and how they fuse (Q3)

philont is **failure-heavy** (10 gates, `playbook-<sig>-fail` from `plan_close(failure)`,
failure-triggered reflection) and **success-thin** (only narrow paths, e.g. service-contract
compilation from a completed plan). hermes is success-primary, and that is *why* its skills are
high quality: **a skill distilled from a verified-successful run is born validated** — a replay
of something that provably worked — which dissolves the online-attribution problem entirely.

But success and failure are not two sequential phases ("converge via failures, then learn from
the success path"). The failures pruned on the way to success are the **most valuable content**
of the resulting skill:

> **A skill = the success path (happy path) + the failures pruned along the way (baked-in
> caveats/guards).** Failure gives the skill its boundaries; success gives it its spine.

Failures split by scope:
- **Within-task** (same `task_signature` converging across attempts) → baked into that skill's
  caveats. philont already tags these (`failure_signatures.ts`, `playbook-<sig>-fail`,
  `failure_recovery_inject.ts` surfaces them to the next attempt).
- **Cross-task** (recur across different signatures — e.g. "LLM can't transcribe a UUID") →
  promoted to a **standalone L3 controller**. These belong to no single skill.
- **One-off / environmental** (a network blip) → discarded as noise.

Safety conditions (learned from this week's failure modes):
- **No premature crystallization**: crystallize only on **judge-verified real success**
  (ideally replay-reproducible), never a first/lucky/claimed success — the anti-fabrication guard.
- **Guards scoped + decaying**: caveats bind to their skill and **decay if never triggered**
  (`offered_count` disuse-decay, schema v36, already built) — else they pile into the "1022
  rules" cruft again.

---

## 4. The engines (three exist; one keystone is new)

1. **The Judge (keystone — the one genuinely missing piece).** An aux-LLM adjudicator
   (`callAuxLLM`, already wired) that (a) scores a run: `success` / `failure` /
   `could_not_verify`, and (b) compares two versions of an artifact. **Grounded against
   sycophancy exactly like `honesty_gate`**: defaults to `could_not_verify`, must cite the
   specific tool-call evidence in the trace to claim success, cross-checked against the existing
   `honesty_gate` / `numeric_grounding_gate` signals. It is a separate model from the one being
   judged. Every other engine depends on it; it is the single no-regret investment.

2. **Success engine (new, hermes-inspired).** On judge-confirmed success, crystallize a skill
   whose happy path is the winning trace and whose caveats are the within-task failures. Born
   `confirmed`, not `draft`. Replaces speculative reflection-minting (`reflector.ts:345`).

3. **Failure engine (exists — philont's strength).** Failure → L3 guard/playbook. Kept.
   Consolidated into a **controller registry keyed by failure-mode** + an **answer-time evidence
   ledger** (HMS-inspired) using `getActiveAt` for stale-vs-current arbitration, dedup, and
   relative-date grounding. This is where this week's real failures live, and it stops the
   hand-write-a-new-gate-per-bug pattern.

4. **Improvement engine (offline, GEPA-inspired — last, optional).** Periodically reflective-
   mutate a skill/controller/prompt using its failure traces, **replay against recorded L0
   situations**, keep the judge-winner. Attribution-free (compares versions on the same inputs).
   Borrow the *paradigm*, not DSPy/GEPA the Python framework.

---

## 5. Phased rollout (measure-first, shadow-before-live, kill gates)

Respecting the standing lesson: *don't build a learning subsystem on the assumption the agent
can't learn; expose the real signal first and let data decide.*

### Phase 0 — Cheap honest fixes + instrumentation (ship now, no new subsystem)
- 0.1 Decouple `use_count` (a usage stat) from the maturity ladder — kill the fake
  "confirmed = fetched twice" signal (`incrementUseCount` → maturity).
- 0.2 Universal evidence-based disuse decay via `offered_count` (v36), **extended to playbooks**
  (remove the `pruneDraftsToCap` exemption). Closes the "never retired" hole deterministically —
  no judgment of "did it help", only "was it ever adopted".
- 0.3 Finish the funnel instrumentation (`[skill-funnel]`, `[autonomy-funnel]`, `learning_stats`)
  so Phase 1's decision is data-driven.
- Net-positive even if the program stops here. No dependence on the big decision.

### Phase 1 — The Judge, in SHADOW
- 1.1 Build the adjudicator (§4.1).
- 1.2 Run it at turn-close scoring what happened; it **logs, drives nothing**.
- 1.3 **KILL GATE** (after ~1–2 weeks of real logs): does the judge produce a trustworthy,
  non-degenerate distribution (agrees with `honesty_gate` on clear cases; not ~100%
  `could_not_verify`)? A noisy judge means garbage-in for every downstream engine — if it fails
  here, **stop the program** and keep only Phase 0 + plain relevance-recall. Do not wire learning
  to a judge that cannot see.

### Phase 2 — Success engine (only if the judge is trustworthy)
- 2.1 Re-gate skill creation: crystallize on judge-confirmed success, not speculative reflection.
- 2.2 Fuse happy path + within-task caveats (§3). Skill born `confirmed`.
- 2.3 Anti-fluke / anti-fabrication guard: require verified (ideally reproducible) success.
- 2.4 **Demote the confidence ladder**: skills are born validated, so the online climb is no
  longer the promotion path. Maturity keeps only DEMOTION-on-observed-failure + disuse decay.
  Retires the broken half without deleting the store.

### Phase 3 — Failure routing + HMS answer-time layer (robustness)
- 3.1 Split failures at reflection into within-task / cross-task / noise (§3).
- 3.2 Consolidate the ~10 gates into a failure-mode controller registry + an answer-time
  evidence ledger over bitemporal facts. New failure classes register a controller instead of a
  hand-written gate.
- 3.3 Wire cross-task guards as standalone controllers (like `honesty_gate`).

### Phase 4 — Offline improvement (GEPA-lite, optional/last)
- Reflective-mutation + replay-eval over L0. Only after 2 & 3 prove the substrate works.

---

## 6. What gets demoted or deleted

- The **online per-artifact confidence machinery** (routing `nextConfidence` climb, skill
  maturity climb) is demoted to **demotion + disuse-decay only**. Promotion moves to
  born-validated creation (Phase 2). Stores are kept; the broken climb is not maintained.
- The stale "0 callers / dead data" and "true closed loop" comments are removed as they are
  addressed.

## 7. Non-goals

- Not adopting DSPy/GEPA (Python) as a dependency — borrow the paradigm in TS.
- Not deleting memory stores wholesale.
- Not building any learning on an unvalidated judge (Phase 1 kill gate).

## 8. Success metrics (honest, anti-theater)

- Skills that reach `validated`/`confirmed` **and were subsequently used and re-verified** — not
  a count of rows.
- This week's failure classes (fabrication, offered-words, mis-attribution, stale-vs-current)
  each covered by a registered controller.
- Creation rate ≤ measurement rate (no more unvalidated-artifact pileup).
- The judge's verdicts agree with the independent `honesty_gate` on clear-cut cases.

## 9. Risks

- **Judge sycophancy** → shadow + grounding (must cite evidence) + cross-check vs honesty gate.
- **Premature crystallization** → verified + reproducible success only.
- **Guard cruft** → scoped + decaying caveats.
- **Over-engineering** → phased with kill gates; Phase 0 alone is net-positive.
