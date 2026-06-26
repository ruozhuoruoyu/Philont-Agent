# Sub-Agent Capability — parallel isolated-context orchestration

Status: DESIGN (not yet implemented). Author: ruozhuoruoyu.
Companion to `deep_explore_phase_redesign.md` / `skill_recall_consolidation.md` / `execution_ledger_anchor.md`.
Anchored to real `file:line`.

## 1. Why (loop-engineering motivation)

Current long-horizon work (deep_explore rounds, broad research, multi-dimension analysis) runs in ONE
context window that grows until it degrades (lost-in-the-middle) or hits compaction. The 2026
loop-engineering / context-engineering consensus is: **split work across parallel agents with separate
context windows; an orchestrator collects and aggregates** (Anthropic "managed agents" / "effective
context engineering"; the "orchestration loops" stage of the ReAct→ralph→orchestration lineage). Each
sub-agent keeps a focused context for its subtask; the lead synthesizes. This is the single biggest
unimplemented capability gap between philont and the current frontier harness design.

## 2. What philont already has (build ON these, do NOT reinvent)

- **mini-agent-loop** (`agent-tools/src/utils/mini-agent-loop.ts`) — the reusable sub-turn KERNEL: own
  messages stack, own iter budget, own abort signal; from the parent's view it is exactly 1 tool_result.
  Deliberately omits HonestyGate / signalBus / pendingAuth / askUserQuestion (non-interactive).
- **planAndExecute** (`agent-tools/src/control/planAndExecute.ts`) — plans sub-tasks then runs each in a
  mini-loop SEQUENTIALLY (one after another), aggregating. The recall callback (P3, commit db22ae5) is
  already threaded into its sub-task prompt.
- **deep_explore** — its own per-round mini-loop with verification teeth; single-threaded over the tree.

The missing piece is **parallel** spawning + an **aggregation/orchestration** layer with **isolated
context** per child. planAndExecute is sequential; nothing fans out.

## 3. Design

### 3.1 Core primitive: `runParallelSubAgents`

A small orchestrator in agent-tools (sibling of planAndExecute) over the existing mini-agent-loop:

```
runParallelSubAgents(tasks: SubTask[], opts): Promise<SubAgentResult[]>
```
- Each `SubTask` = { id, description, systemPrompt?, toolWhitelist?, maxIters }.
- Runs up to `opts.concurrency` (default min(4, tasks.length)) mini-agent-loops **concurrently**, each
  with a FRESH messages stack (isolated context — a child never sees siblings' transcripts, only its own
  task + optional shared read-only brief).
- A shared `BudgetTracker` (mirror planAndExecute's PlanBudgetTracker) so parallel children cannot blow
  the turn/token budget — the loop-engineering "BUDGET" contract part. Children that would exceed the
  ceiling are skipped, not silently truncated (log what was dropped).
- Returns each child's `{ id, status, finalText, tokensSpent }`; a thrown/aborted child → status='failed'
  (never rejects the whole batch — mirror parallel()/.filter(Boolean) discipline).

### 3.2 Orchestrator (aggregation)

A second stage that takes the N child results + the original goal and produces a synthesis — either a
final deterministic merge (dedup/concat) or one more LLM call ("here are N findings, synthesize"). Keep
the synthesis context SMALL: it sees child SUMMARIES, not their full transcripts (the whole point —
detailed context stays isolated in the children, per Anthropic's separation-of-concerns).

### 3.3 Three call sites (where it earns its keep)

1. **Broad research / deliberate deep_explore grounding** — fan out the start-of-session literature
   survey (`deep_explore.ts:337` grounding pass) into K parallel angle-searches instead of one serial
   mini-loop; aggregate cited cards. Directly cuts the double-survey waste noted in the P-vs-NP run.
2. **deep_explore converge — parallel candidate evaluation** — when a converge round has several open
   rival candidates, evaluate/verify them in parallel children (each a focused context), then the round
   merges verdicts. Today it is strictly serial over the frontier.
3. **Autonomous layer** — let a high-utility initiative fan out into parallel read-only research children
   instead of one serial lookup (`autonomous/loop.ts` dispatches sequentially today). Complements the
   execution-ledger and proactive-report work.

### 3.4 Boundaries / safety (mirror mini-agent-loop's intentional omissions)

- Sub-agents are **non-interactive** (no askUserQuestion / pendingAuth). A child needing a gated
  capability fails that child; the orchestrator reports it — it never blocks the parent turn on auth.
- Sub-agents inherit a **read-only-by-default** whitelist; write/exec capability is opt-in per spawn and
  flows through the same policy gate (no bypass — cf. the shell-bypass fabrication lesson).
- **No nested fan-out** (a sub-agent cannot itself spawn parallel sub-agents) — one level, like the
  Workflow tool's nesting cap, to bound blow-up.
- **Verification still applies**: children doing compute use the same z3/pariGp/magnitude teeth; the
  orchestrator does NOT trust a child's narrated result over its tool ledger (ties to
  `execution_ledger_anchor.md`).

## 4. Decisions (recommended defaults — edit here)

1. **Concurrency cap.** Default `min(4, tasks)`; env `PHILONT_SUBAGENT_CONCURRENCY`. Matches the local
   CPU-bound caution; raise only when children are I/O-bound (web research).
2. **Isolation level.** Default FULL isolation (fresh stack, no sibling context) + a small shared
   read-only brief. Reject "shared growing transcript" (defeats the purpose).
3. **First call site to ship.** Recommend (1) parallel grounding/research — highest value, lowest risk
   (read-only), and it directly fixes an observed waste. (2) and (3) follow.
4. **Aggregation.** Deterministic dedup-merge when children return structured items; one LLM synthesis
   call only when free-text findings must be reconciled.

## 5. Rollout (phased, flag-gated, default off until P1 proven)

- **P0** `runParallelSubAgents` + orchestrator in agent-tools, over mini-agent-loop; unit tests with a
  mock MiniLoopLLMClient (fan-out N, budget cap, failed-child isolation, aggregation). No call-site
  wiring yet → zero behavior change.
- **P1** wire call site (1) parallel research/grounding behind `PHILONT_SUBAGENT_RESEARCH` (default off →
  dogfood → on).
- **P2** deep_explore converge parallel candidate evaluation.
- **P3** autonomous initiative fan-out.

## 6. Non-goals

Remote/distributed execution; cross-process agents; nested orchestration; replacing planAndExecute
(parallel orchestrator is complementary — planAndExecute stays for dependency-ordered sequential work).
