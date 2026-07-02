# Mechanism-driven Plan–Execute Loop (guide / complex tasks)

Status: **design, pending review** · 2026-07-02

## 1. Problem

The plan protocol was intended as a *fixed loop* for complex tasks (e.g. mycox "read
guide → register"):

```
read guide → draft plan → VERIFY plan against the guide
           → not covered → revise → back to VERIFY (until it passes)
           → covered → execute step-by-step
           → execution error → back to plan
           → all done → close
```

But the **control flow of this loop is not a mechanism — it is policy**. Today it is
implemented as:

- four *tools* the model must voluntarily call in order: `plan_draft` /
  `plan_revise` / `plan_update_step` / `plan_close`;
- one *gate* (`plan_protocol_gate`) whose only job is **"block non-exempt tools while
  slow + no executing plan"**.

The gate is a **wall** (prevents out-of-order execution); it does not **drive** the
loop. So the loop leaks: a weak model does the exempt prep (webFetch guide — allowed),
reaches the wall on the real action (register — blocked), and instead of calling
`plan_revise` to get through, it **gives up and declares completion** ("注册完成"). The
false-claim gate catches the lie and downgrades to "部分完成", but the task never
completes — because **`plan_revise` (the "verify → revise" edge) was always a voluntary
tool call, and the weak model won't make it.**

Root: **using a gate + voluntary tools to approximate a loop = policy masquerading as
mechanism → escapable.** The VERIFY→REVISE→VERIFY ring has nothing to do with the gate;
it must be a deterministic state machine the model cannot skip.

## 2. Principle

> **The control FLOW is a mechanism (a deterministic state machine). The model only
> provides the CONTENT of each state. The model cannot change states, skip VERIFY, or
> self-declare completion.**

This extends philont's existing "mechanism, not the LLM's attention" moves (the
task-mode classifier, the auto-placeholder, `runMiniAgentLoop`). Here we finish the job:
the *loop itself* becomes mechanism.

**Why this matters (charter-level):** this mechanism is what makes philont viable on
WEAK and EDGE-DEPLOYED models. A strong model may follow the protocol voluntarily; a
weak model demonstrably does not (won't call plan_revise, declares completion at the
wall). If correctness depends on the model's discipline, philont's floor is the model's
floor. If the loop is mechanism — transitions computed by code, completion gated on tool
evidence — then a small local model only needs to fill in each state's content, and the
SYSTEM guarantees the workflow. Capability can degrade; the process contract cannot.

## 3. The state machine

Server-orchestrated. Each state prompts the model for exactly that state's output,
validates it deterministically, and computes the next state. The model has **no
transition tool** — it cannot emit "done"; only the orchestrator can.

| State | Model produces | Mechanism validates | Transitions |
|---|---|---|---|
| `GUIDE_READ` | (none) | mechanism itself fetches every `guide_ref` URL (webFetch, force scraper fallback) into the fetched-store | → `DRAFT` (guide text in hand) / on hard-fetch-fail → `ABORT_REPORT` (honest "couldn't read guide") |
| `DRAFT` | deliverables[] (one per guide MUST-item / literal user action) + steps[] mapping to deliverables | JSON parse + shape (reuse planAndExecute `validateAndNormalize`); deliverables ≥ 1 | → `VERIFY` |
| `VERIFY` | (none — model is the subject, not the actor) | **compare deliverables vs the guide** (§5): every MUST-item covered? | covered → `EXECUTE`; gaps → `REVISE` (carry the gap list) |
| `REVISE` | amended deliverables/steps addressing the named gaps | same as DRAFT | → `VERIFY` (bounded: `MAX_VERIFY_ROUNDS`, default 3; exhausted → proceed with a logged partial-coverage note, never silently) |
| `EXECUTE` | per step: a `runMiniAgentLoop` that must produce tool evidence for that deliverable | the step's tool actually ran + succeeded (inspect `MiniLoopToolCallRecord`, not the model's prose) | all steps done → `CLOSE`; a step fails at root-cause ≥ K → `REVISE` (back-edge, bounded by `MAX_EXECUTE_REPLANS`, default 2); user-relevant block (auth) → surface + pause |
| `CLOSE` | (none) | every deliverable has real tool evidence → `plan_close('success')`; otherwise `plan_close('partial'/'failure')` **with the honest per-deliverable status** | → done |
| `ABORT_REPORT` | (none) | — | emit an honest "here's what I could and couldn't do" reply |

Why fabrication becomes impossible: there is **no state the model can jump to that means
"done".** `CLOSE` is entered by the orchestrator only after it has checked real tool
evidence per deliverable. "注册完成 with tools=0" is not expressible — the EXECUTE state
for the `register` deliverable does not advance until a `register` tool call actually
succeeds.

## 4. Entry (mechanism routing — deterministic, not the gate)

The orchestrator is entered **before** the normal agentic turn, when the turn is a
complex/guide task:

- `intentDecision.route === 'plan'` **and** the task-mode classifier signalled a real
  multi-step task (`guide-hint` ∥ `heavy-keyword` ∥ `multi-step-connector`), i.e. the
  same signals that today create a placeholder. (One-shot exempt tasks — delete/list —
  never enter; they stay direct, per the per-task reclassification fix already shipped.)
- Gated by `PHILONT_PLAN_LOOP` (default OFF at first, dogfood → ON), falling back to
  today's placeholder+gate path when off, so rollout is reversible.

When entered, the orchestrator OWNS the turn: it runs the state machine to a terminal
state and returns the final reply. The `plan_protocol_gate` / auto-placeholder /
auto-plan-on-slow paths are **bypassed for this turn** (no double machinery). The gate
remains for the non-loop slow tasks.

## 4.5 Spec tiers — what VERIFY verifies against (pluggable)

The state machine skeleton is task-agnostic; the only guide-dependent piece is the
VERIFY **baseline (spec)**. The spec source is pluggable, in descending objectivity:

| Tier | Spec source | Objectivity | Example |
|---|---|---|---|
| 1 | **External doc/spec** (guide.md, API spec, design doc — same shape as spec-based coding) | external, strongest | mycox guide; "implement per this spec" |
| 2 | **Literal asks in the user message** (≥2 enumerable actions) | external, strong | "download A, convert to B, send it" |
| 3 | **Model-drafted acceptance criteria** (written at DRAFT, before execution; echoed to the user) | self-graded, weak — but evidence-based CLOSE still floors it | "deploy this project" |
| 4 | **No enumerable criteria** (quality/exploration: research reports, proofs) | none | → **does NOT enter this loop; routed to deep_explore / direct** |

Entry criterion is therefore **"does a checkable spec exist?"**, not "is it complex?":
- v1: tier 1 only (guide URL present) — cleanest spec, matches the mycox failure.
- v2: tier 2 (literal-ask extraction from the user message).
- tier 3 later, opt-in; tier 4 never (task typology: the 3-way intent router already
  separates execution-with-spec / exploration / direct).

Implementation: `SpecProvider` interface — `specFromGuide(text)` v1,
`specFromUserMessage(msg)` v2, `specFromModelDraft(criteria)` v3. VERIFY consumes
`SpecItem[]` regardless of source.

## 5. VERIFY (对比校验) — the load-bearing new piece

Two layers, cheap-first:

1. **Deterministic coverage (structural).** Extract candidate MUST-items from the guide
   text: markdown headings (`^#{1,3} `), imperative/`**must**`/`Part N` lines, numbered
   steps. Check each maps to a deliverable by token overlap. Cheap, no LLM, catches gross
   omissions (the "dropped the whole posting section" case).
2. **Aux-LLM judge (semantic), when configured.** `callAuxLLM` (already used by
   `classifyIntent`; `isAuxLLMConfigured` guards it) with: *"Here is the guide. Here are
   the plan's deliverables. List each guide requirement NOT covered by a deliverable
   (id + one line). Output JSON `{gaps: [...]}`."* Deterministic layer is the floor; the
   aux layer refines. If aux is unconfigured, deterministic-only (degrade, never block).

VERIFY returns `{covered: boolean, gaps: string[]}`. `gaps` is fed verbatim into the
REVISE prompt ("add deliverables for: …") so the loop converges on concrete misses.

## 6. Reuse map (build on existing kernels, don't reinvent)

| Need | Reuse |
|---|---|
| Run a bounded model+tools sub-loop per EXECUTE step | `runMiniAgentLoop` (agent-tools/utils/mini-agent-loop) |
| Decompose / JSON-plan parsing + validation + topo | planAndExecute `parsePlannerOutput` / `validateAndNormalize` / `topoSort` |
| The VERIFY judge | `callAuxLLM` / `isAuxLLMConfigured` (@agent/tools) |
| Persist deliverables/steps/close + failure playbook | plan store (`memory.plans.create/revise/close`) — the loop drives these instead of the model |
| Guide fetch + cache | webFetch + fetched-store (already wired; ENOENT fix shipped) |
| Per-deliverable tool-evidence check | `MiniAgentLoopResult.toolCalls` (`MiniLoopToolCallRecord`) — evidence is the tool record, not prose |

Net new code ≈ one orchestrator module (`plan_execute_loop.ts`) + the VERIFY module +
the entry hook. `planAndExecute` becomes (optionally) a thin wrapper over the same
orchestrator, or is left as-is for model-invoked use.

## 7. Interfaces (sketch)

```ts
type LoopState = 'GUIDE_READ'|'DRAFT'|'VERIFY'|'REVISE'|'EXECUTE'|'CLOSE'|'ABORT_REPORT';

interface PlanLoopDeps {
  llm: MiniLoopLLMClient;                 // same client the turn uses
  toolRunner(name, input): Promise<MiniLoopToolRunResult>;
  toolDefs: ToolDefinition[];
  plans: PlanStore;
  verify(guideText, deliverables): Promise<{covered: boolean; gaps: string[]}>;
  fetchGuide(url): Promise<string | null>;
  logger; onProgress; recall?;           // mirror PlanAndExecuteDeps
  maxVerifyRounds?: number;  maxExecuteReplans?: number;
}

interface PlanLoopResult {
  outcome: 'completed'|'partial'|'aborted';
  deliverableStatus: Record<string,'done'|'partial'|'failed'|'not-attempted'>;
  reply: string;                          // the honest ## For User text
}

async function runPlanExecuteLoop(task: string, guideRefs: string[], deps): Promise<PlanLoopResult>
```

Pure, testable transition function `nextState(state, ctx)` split out (like
`slowSessionAtTaskBoundary` / `computeViability`), so the state machine's logic is unit
tested without a live model.

## 8. Bounds & escape hatches (no new doom-loops)

- `MAX_VERIFY_ROUNDS` (3): VERIFY↔REVISE can't spin forever; on exhaustion → proceed to
  EXECUTE with the uncovered items logged and reported (honest partial, never silent).
- `MAX_EXECUTE_REPLANS` (2): EXECUTE→REVISE back-edge bounded.
- Whole-loop wall-clock deadline (reuse the turn deadline) → `ABORT_REPORT`.
- Auth / user-decision block inside EXECUTE → surface to the user and pause (don't burn
  rounds), same as today's auth flow.
- User "算了/停" → abort to `ABORT_REPORT` honestly (charter: never block the user).

## 9. Why this dissolves several current bugs at once

- **Escape / half-completion** → the loop is mechanism; VERIFY/REVISE can't be skipped.
- **Zero-tool "注册完成/发帖成功" fabrication** → no model-controlled "done"; CLOSE needs
  real per-deliverable tool evidence.
- **Placeholder-conversion friction (`plan_update_step` on placeholder)** → the model
  never touches `plan_update_step`/`plan_revise` directly; the orchestrator drives the
  store. The whole "convert the placeholder" UX disappears.
- **guide MUST-items dropped** → VERIFY is the gate on coverage, structurally.

## 10. Open decisions (need your call)

1. **VERIFY authority**: deterministic-only first (ship faster, coarser), or
   deterministic + aux-LLM from day one (needs the aux model configured on the box)?
2. **EXECUTE granularity**: one `runMiniAgentLoop` per deliverable (isolated, cleaner
   evidence) vs one loop for the whole EXECUTE phase (fewer LLM calls, muddier evidence).
   Recommend per-deliverable.
3. **Scope of entry**: only guide-URL tasks (safest first cut), or all classifier-slow
   multi-step tasks? Recommend guide-URL-only for v1, widen after dogfood.
4. **Coexistence**: keep the placeholder+gate path for slow-but-non-loop tasks
   (recommended), or migrate everything? Recommend keep both, `PHILONT_PLAN_LOOP` selects.
5. **Naming / reuse**: fold `planAndExecute` into this orchestrator, or keep it separate
   (model-invoked) and add the loop as a distinct mechanism entry? Recommend keep
   separate for v1 (less blast radius).

## 11. Rollout

- Behind `PHILONT_PLAN_LOOP` (default OFF). Pure transition unit-tested; then dogfood on
  the mycox guide task with the flag on; then default ON once the register task
  completes end-to-end (real machine, since there's no LLM mock harness locally).
