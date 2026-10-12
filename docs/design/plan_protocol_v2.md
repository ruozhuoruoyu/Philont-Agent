# Plan protocol v2 — one mechanism, typed items, model-chosen entry

Status: **design, for review** · 2026-10-12

## Why rewrite

Two plan systems coexist today and neither is general:

| | legacy protocol (plan_draft / plan_update_step / plan_close + `plan_protocol_gate`) | mechanism loop (`plan_execute_loop.ts`) |
|---|---|---|
| who drives transitions | the model (calls the tools; the gate only refuses execution while no plan is `executing`) | the code (fixed state machine; the model fills states) |
| entry | task-mode classifier → `slow`, or auto-plan-on-slow placeholder | intent router `route=plan` **and a URL regex on the user message** |
| what an item is | a step with a free-text evidence string | a deliverable + a step, done when a *matching successful tool call* exists |
| guide knowledge | prompt text ("guide constraints — OBEY") | regex spec items + optional compiled SpecDoc; `preconditions` compiled and never consumed; `rules` are prompt text |
| domain assumptions | none, but nothing is verified | `http` tool, endpoint hints, register/credential/heartbeat specifics |

What a guide says, and what the mechanism can do about it, has four shapes besides "do X". The loop
cannot express three of them, so on HANDBOOK.md (an HR handbook, 82 MCP tools, no URL, no `http`) the
loop was never entered, the legacy protocol ran, and the run executed an offboarding the handbook forbids
without written authorization — the same failure as a bare ReAct loop. v1's checks are not wrong; they
are specific to the one service they were written against.

Principles (unchanged from the mycox work, restated as acceptance criteria for every line of v2):

1. **The model understands prose; the mechanism verifies truth.** No domain word (register, offboard,
   token, email) appears in mechanism code. The mechanism knows item *kinds*, tool names, tool inputs,
   tool results and time.
2. **Entry is a model judgement.** The intent router decides `plan` vs `deep_explore` vs `direct`; the
   mechanism never gates a protocol on a regex over the user message.
3. **Completion is computed, never declared.** An item is done when the world, read back through a tool,
   shows it — not when a write returned 200 and not when the model says so.
4. **One owner.** A plan turn is owned end-to-end by the loop: scheduled or not, URL guide or file guide.
   The legacy gate becomes unnecessary for plan turns and is retired for them (kept only until the loop
   owns scheduled turns, see Increments).

## The intermediate representation

The model compiles the guide + task into this JSON; the mechanism validates shape only.

```json
{
  "deliverables": [{"id": "<slug>", "description": "<what must be true when done>"}],
  "steps":        [{"id": "<slug>", "description": "<how>", "covers": ["<deliverable-id>"]}],
  "rules": [
    {"id": "<slug>", "kind": "guard",     "condition": "<guide's words>", "applies": [{"tool": "<name|glob>", "args": "<regex>"}], "covers": ["<deliverable-id>"]},
    {"id": "<slug>", "kind": "forbid",    "condition": "<guide's words>", "applies": [{"tool": "<name|glob>", "args": "<regex>"}]},
    {"id": "<slug>", "kind": "evidence",  "condition": "<what a readback must show>", "applies": [{"tool": "<read tool|glob>", "args": "<regex>"}], "covers": ["<deliverable-id>"]},
    {"id": "<slug>", "kind": "invariant", "condition": "<what must still hold at close>", "applies": [{"tool": "<read tool|glob>", "args": "<regex>"}]}
  ],
  "not_applicable": [{"unit": "<guide sentence id>", "reason": "<why it does not apply to this task>"}]
}
```

`applies` patterns name real tools: the compile prompt carries the tool list (name + one line), so a
pattern is a tool name or a `*` glob over tool names plus an optional regular expression over the call's
JSON input. Matching is deterministic and lives in `agent-memory/src/plan_rules.ts` (already written:
`toolNameMatches`, `patternMatchesCall`, `findBlockingRule`, `readbackSatisfied`, `validateRuleInput`).

Mechanism semantics per kind (nothing else is ever inferred from the text):

| kind | before a tool call | at step end | at close |
|---|---|---|---|
| step | — | covered deliverables need evidence (below) | — |
| guard | a call matching `applies` is **refused** until the guard is resolved `satisfied`; resolved `not_satisfied` keeps refusing | — | unresolved guards are reported |
| forbid | a call matching `applies` is **refused**, always | — | — |
| evidence | — | a covered deliverable is **done only if** a successful call matching `applies` happened *after the step's last write* and the aux judge, given only that readback text and the condition, answers that it shows the condition | — |
| invariant | — | — | the mechanism runs a READBACK step for it; judge must confirm; otherwise the close is `partial` and the report says what was not confirmed |

Guards are resolved by the mechanism, not by the model's say-so: a RESOLVE step runs for each guard
before EXECUTE with **read-capability tools only**; its verdict is parsed from a fixed one-line format,
and the floor is that the step made ≥ 1 successful read call — a verdict with no read is `unresolved`.

The aux judge is used the way the honesty gate uses it: it is shown the readback text and the condition
and asked what the text *shows*; it is never asked whether the task succeeded.

## Phases

```
LOCATE → COMPILE → REVIEW (ratchet) → RESOLVE → EXECUTE (per step, guarded) → CLOSE (invariants, report)
```

**LOCATE.** Sources of the guide, in order: URLs in the task (fetched by the mechanism, as today); then,
if the task refers to a document ("the provided SOP", "the handbook", an attachment, a path), a bounded
read-only mini-loop ("find and read the documents this task says to follow; read them in full") whose
successful read outputs ≥ 1 500 chars become the guide corpus. The model names what it reads; the
mechanism keeps the texts. No URL regex decides entry; the router already did.

**COMPILE.** One model call → the IR above. Mechanism validation: ids kebab, `covers ⊆ deliverables`,
patterns name tools from the tool list (unknown tool → rejected with the list), regexes compile.

**REVIEW.** The mechanism splits the guide into sentence units with stable ids (deterministic
segmentation: headings, numbered items, sentences containing MUST/must/never/only if/unless/before/after
and their Chinese equivalents). The model's `not_applicable` list plus item `covers`/`condition` texts
must account for every mandatory unit (token-overlap coverage as today, `checkCoverage`). Unaccounted
mandatory units are gaps; the aux reviewer adds semantic gaps; the ratchet from v1 (keep best round,
"raised again" / "contested" memory held by the mechanism) is reused as is. Items can only be added
across rounds, never silently dropped.

**RESOLVE.** For each guard: RESOLVE mini-step with read tools only → `satisfied` / `not_satisfied` /
`unresolved`. A `not_satisfied` guard blocks its calls for the rest of the run; the compile prompt
requires the guide's alternative path (escalate, ask, record) to be its own deliverable gated the other
way, so the alternative is executed as a normal step.

**EXECUTE.** v1's per-step mini-loop with a rewritten guard chain, in order: `forbid` → `guard` →
tool-contract guards (the spec regime's endpoint/auth/body/id-provenance guards, which apply only when
the guide compiled into a SpecDoc with hosts — they become one plugin family, not the core). Done-marking
per deliverable: if an `evidence` rule covers it, the readback rule above (with one forced READBACK
mini-step if the model did not read back); else v1's existing evidence kinds (schedule / external action /
read) as the fallback for deliverables the model attached no readback to — logged as `unverified` in the
report, not as `done`.

**CLOSE.** Invariants are read back by the mechanism; outcome = `completed` only when all deliverables
are done *and verified* and no invariant failed; the report has three lists — verified, unverified, not
done — and the unresolved guards. The live plan record (planTracker) carries the typed items so the
legacy store and dashboards see them.

## What is kept, moved, removed

Kept: GUIDE_READ by URL, spec extraction + compiled SpecDoc, the REVIEW ratchet and mechanical adoption,
the mini-loop executor, the budget/abort handling, live plan record, cookbook/service-skill emission.

Moved to a plugin: endpoint guard, auth-path guard, spec request/body guards, id-provenance, schedule
instruction guard, register template, credential/heartbeat teaching. They run when a SpecDoc with hosts
exists; a guide with no API surface never sees them.

Removed from the core: the URL regex at entry; `ACTION_REQ_RE` / `ENDPOINT_HINTS` as the definition of
"done" (they remain only as the fallback evidence kind, reported as unverified).

Retired: `plan_protocol_gate` for user-driven plan turns (the loop's guard chain replaces it). The legacy
tools stay registered until Increment 4 so scheduled turns keep working.

## Generality discipline

- No benchmark- or service-specific text in code or prompts; the compile prompt only names kinds and the
  tool list.
- Evaluation: HANDBOOK.md five domains leave-one-domain-out (read failures on four, confirm on the fifth);
  AgentAbstain and τ²-airline as regression (guards must not refuse what should be done); the mycox
  replay tests (plan_execute_loop.test.ts, plan-and-execute-integration) must stay green.
- A mechanism change is accepted only with a test that fails without it and a log line that names it.

## Increments

1. **IR + guards + readback in the loop** (this PR): LoopRule in DraftPlan, compile prompt with tool list,
   `forbid`/`guard` in the guard chain, RESOLVE steps, evidence readback + judge, invariants at close,
   typed items into planTracker. Entry: `route=plan` without the URL condition; LOCATE phase. Spec-regime
   guards wrapped as the http plugin. Deadline from `TURN_HARD_DEADLINE_MS`.
2. **REVIEW over sentence units** with `not_applicable` accounting.
3. **Report + memory**: verified/unverified/not-done report; type-level lessons ("guards of kind X were
   missed in domain Y") into cases/conventions, never instance text.
4. **Scheduled turns** owned by the loop (resume an executing plan); retire the legacy gate and tools.

Tests per increment are listed in the PR. Data: `PlanStep.kind/rule` (v53, additive; no column change).
