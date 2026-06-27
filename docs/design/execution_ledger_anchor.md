# Execution-Ledger Anchor — answer from the ledger, not the narrative

Status: DESIGN (not yet implemented). Author: ruozhuoruoyu.
The single highest-leverage structural change: it replaces a fleet of downstream honesty CATCHERS with
one upstream GROUND TRUTH. Anchored to real `file:line`.

## 1. Problem (the root cause behind every fabrication patch)

philont rebuilds a ~25 KB `buildMemoryPrefix` (`chat-handler.ts:2644`) every turn — facts, skills,
playbooks, reasoning-session SNAPSHOT, timeline narrative. The model then **answers from that narrative**
instead of from **what actually ran this turn**. Two tracks (memory-prefix story vs the turn's tool
ledger) drift freely, which is exactly how:
- `fabricated_round_result` happens — the model recites "第N轮 / x开→y开" from the injected session
  snapshot with 0 tool calls (the P-vs-NP `tools=0, 5.7s` stall);
- `fabricated_execution_claim` / numeric fabrication happen — narrates computed numbers no tool produced;
- `fabricated_reasoning_state` happens — declares "solved" while the tree has open frontier.

Every fix so far is a **downstream catcher**: numeric_grounding_gate, honesty_gate (execution/round/
reasoning-state branches), guardDeepExploreFabrication, the force-continue mechanism. They work, but they
are catching a fire the generation contract keeps starting. The 2026 loop-engineering consensus names the
fix directly: **anchor each iteration on a ground-truth artifact** (ralph's "progress lives on disk, not
in conversation"; Anthropic's "feature list as ground truth" that prevents premature completion claims).
philont's analog of "progress on disk" is the **tool ledger + the reasoning tree** — both already exist
as data, but are NOT the authoritative thing the model answers from.

## 2. What already exists (promote, don't build from scratch)

- `renderTurnLedger(records)` (`chat-handler.ts:5634`) — "this turn's tool ledger as a compact,
  authoritative list — ✓ = real citable result / ⚠ = failed". **Today it is only folded into a corrective
  directive AFTER a gate fires** (Phase C of the fabrication work), not presented as turn-start ground
  truth. This is the artifact to promote.
- `signalBus.inTurnRecords` (`chat-handler.ts:5707`, `InTurnToolRecord`) — the per-turn execution record.
- `reasoning.summarizeSession()` (`reasoning.ts:304`) — authoritative tree state (open/proved/dead).
- The honesty branches already encode the verification rules — they become *redundant backstops* once
  generation is anchored, not the primary defense.

## 3. Design — two layers

### 3.1 The Ledger (authoritative artifact, small)

A compact, structured, ALWAYS-PRESENT block the model is told is the ground truth for any claim about
"what ran / what is proved / what is open":
- **This turn's tool ledger** — `renderTurnLedger(inTurnRecords)`: each tool call with ✓/⚠ and the
  citable result handle. Empty when no tool ran ("THIS TURN: no tools executed").
- **Active reasoning state** — `summarizeSession()` for the owner's active deep_explore: open-frontier
  count, proved count, dead count, last-round summary — labelled "TREE STATE (read-only snapshot, NOT
  this-turn progress)" so the snapshot is explicitly distinguished from this-turn work.

The distinction is the whole point: the snapshot is clearly marked "not produced this turn", so reciting
it as a fresh round result is unsupported by the ledger.

### 3.2 The Generation Contract (the part that bites)

The system prompt states, as a hard rule near the response instruction (not buried in 25 KB):
> Any claim about an EXECUTION result, a computed number, a deep_explore round/settlement, or a
> proved/solved state MUST be grounded in THE LEDGER above. If the ledger shows no such tool ran this
> turn, you have not done it this turn — say so plainly or actually call the tool now. Do not narrate
> progress from the tree snapshot as if it were produced this turn.

Combined with the existing gates as backstop, the claim→evidence binding moves to GENERATION time
(kill at the source) rather than DETECTION time (catch after).

### 3.3 (Stretch) Provenance binding

Where feasible, numeric/result claims should reference a ledger handle (tool-call id) that the harness
renders, so an unbound number can be stripped/flagged at render time — the "generate-time provenance"
root-cause fix. Start without this (contract + anchored ledger first); add if dogfood shows residual
fabrication.

## 4. Why this composes with everything else

- **Force-continue** (commit 3ed149d) is one instance of this principle (force a real run so the ledger
  is non-empty). The anchor generalizes it: the model never needs forcing if it answers from the ledger.
- **Sub-agents** (`sub_agent_capability.md`): the orchestrator trusts child ledgers, not child narration.
- **Compaction**: when compacting, PRESERVE the ledger/tree state (Anthropic: keep "unresolved bugs /
  decisions", discard redundant narrative) — the ledger is precisely what must survive compaction.

## 5. Decisions (recommended defaults — edit here)

1. **Placement.** Ledger goes at the END of the prefix, adjacent to the response instruction (recency /
   not lost-in-the-middle), NOT mixed into the 25 KB middle.
2. **Always-on vs gated.** Always-render the ledger (it is small), default ON, behind
   `PHILONT_EXECUTION_LEDGER` default ON; the generation-contract line is part of the same flag.
3. **Snapshot labelling.** Reasoning snapshot MUST carry the "not this-turn" label — this is the bit that
   stops recite-as-fresh. Non-negotiable.
4. **Pitfall to avoid (known).** A string-content user/ledger message can be mis-parsed as a turn boundary
   by `extractRecentToolResults` (`chat-handler.ts` ~362) — Phase C hit this and had to retreat to
   directive-only injection. P0 must place the ledger so it does NOT trip that parser (verify with the
   honesty/numeric-gate tests still green).

## 6. Rollout

- **P0** promote `renderTurnLedger` + a `renderReasoningSnapshot` into a single `buildExecutionLedger()`
  block; inject at prefix end with the contract line; behind `PHILONT_EXECUTION_LEDGER` (default OFF for
  first ship → byte-identical when off, golden-snapshot tested like skill-recall). Verify the
  extractRecentToolResults boundary parser is not tripped.
- **P1** flip default ON after dogfood; measure: `fabricated_round_result` / `fabricated_execution_claim`
  fire rate should DROP (the gate becomes a rare backstop, not a frequent catcher) — `[learning-stats]`
  already counts honesty fires.
- **P2** provenance binding (3.3) if residual fabrication remains.

## 7. Non-goals

Removing the honesty gates (they stay as backstop); changing memory storage; the timeline retriever.
