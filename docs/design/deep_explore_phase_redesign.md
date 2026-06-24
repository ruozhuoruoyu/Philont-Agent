# deep_explore — phase-aware redesign (diverge/converge × domain)

Status: implemented (Phases A–E landed). `PHILONT_DEEP_EXPLORE_PHASES` default **ON** as of
2026-06 for live dogfooding (disable with `=0`); not yet validated against a real LLM.
Owner: ruozhuoruoyu
Scope: `server/src/deep_explore.ts`, `server/src/viability_gate.ts` (sibling), `agent-memory/src/reasoning.ts` + `schema.ts`

## 1. Context — the problem

deep_explore today branches on a single field `mode ∈ {formal, deliberate}`
(`agent-memory/src/reasoning.ts:27`). This conflates **two independent things**:

- **what makes a claim true** (the verifier family): deductive (z3/magnitude/pariGp)
  vs empirical (cited evidence). This is a real, session-constant property.
- **what move the round makes**: *generate / open up the space* (diverge) vs
  *discriminate / eliminate / settle* (converge).

The second axis already exists **inside formal**, smuggled into the action enum
(`deep_explore.ts:2434`): `discover` is a diverge round (conjecture freely + novelty
archive, `buildDiscoverPrompt` 1011, `runDiscoverRound` 2293, no value-guided
selection, no stuck judgment — substantive measured by *survivor growth*,
`discoverRoundWasSubstantive` 293) while `continue`→`runRound` is a converge round
(decompose / kill / settle via verifier + skeptics).

Two consequences:

1. **`deliberate` only has the converge half.** There is no generative pass for
   real-world questions — no "what options/hypotheses/framings even exist?" The
   evidence-hard-gate (`DELIBERATE_PROFILE.settlePrecheck`, 1437: requires
   `evidenceRefs > 0`) is correct for converge but **structurally blocks divergence**
   and also blocks *derived/value* conclusions (a value judgment has no external
   citation to attach).
2. **Phase is chosen by which action the caller invokes**, not by the session. The
   system cannot move diverge→converge on its own inside one `continue` flow; the
   transition is the user/LLM remembering to call `discover` vs `continue`.

This redesign **lifts phase to a first-class, cross-domain session state** and fills
the missing cell (deliberate × diverge), so a single investigation can open the space
then converge on it, with the **transition gated** (not pitched by ungated LLM text).

Non-goal: a deterministic verifier for real-world judgment — there isn't one (see
`docs/design/` discussion). Depth in the empirical domain rests on *calibration +
adversarial survival + explicit epistemic labels*, not a green check.

## 2. The model — two orthogonal axes, different lifetimes

| axis | values | lifetime | decides |
|---|---|---|---|
| **domain** (= existing `mode`) | `deductive` (formal) · `empirical` (deliberate) | session-constant | verifier / settle family |
| **phase** (new) | `diverge` · `converge` | session **state**, ratchets diverge→converge | what the round does |
| **settle basis** (new) | `empirical` · `preferential` | **per-node**, set at settle | which evidence a deliberate node needs |

Key: these are **orthogonal**. The control surface is *not* a 6-way router — it is
**one constant pick (domain) + one near-one-way ratchet (phase) + a local per-node
property (settle basis)**. That factoring is what prevents thrash (a free 6-cell FSM
would oscillate; cf. the historical 6-min thrash fixed in viability_gate).

`domain` needs **no new column** — `mode` already is it (`formal`=deductive,
`deliberate`=empirical). We only add `phase` + `settle_basis` + a saturation counter.

### The 2×2 (3 cells exist, 1 is new)

|                | diverge                                   | converge                                          |
|----------------|-------------------------------------------|---------------------------------------------------|
| **deductive**  | `discover` ✅ exists                       | `prove` (`runRound`) ✅ exists                     |
| **empirical**  | **deliberate-diverge ❌ NEW (Phase B)**    | deliberate evidence-settle ◐ exists, sharpen (D)  |

## 3. Data model changes

Migration mechanism: `agent-memory/src/schema.ts`, `addColumnIfMissing` (417), bump
`SCHEMA_VERSION` (currently v31, line 19), add `migrateV31toV32` etc., register in
`initSchema` (~1243). All `ADD COLUMN IF NOT EXISTS` → idempotent, back-compat safe.

```
-- v31 → v32
ALTER TABLE reasoning_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'converge';
ALTER TABLE reasoning_sessions ADD COLUMN diverge_idle_rounds INTEGER NOT NULL DEFAULT 0;
-- v32 → v33
ALTER TABLE reasoning_nodes ADD COLUMN settle_basis TEXT;   -- nullable: 'empirical' | 'preferential' | NULL(=empirical default)
```

Default `phase='converge'` **preserves today's behavior** for every existing session
and for `start` (which currently runs a prove/evidence round). Diverge is entered only
via auto-detect (Phase E), an explicit `phase` param, or the `discover` action.

Type/interface edits (`agent-memory/src/reasoning.ts`):
- add `ReasoningPhase = 'diverge' | 'converge'` (near line 27).
- `ReasoningSession`: add `phase: ReasoningPhase`, `divergeIdleRounds: number` (31-49).
- `ReasoningNode`: add `settleBasis: 'empirical' | 'preferential' | null` (51-71).
- row converters (106-143), `createSession` (accept optional `phase`), and new store
  methods: `setPhase(id, phase)`, `recordDivergeProgress(id, madeProgress): number`
  (mirror of `recordRoundProgress` 2258-style), and extend `updateNode` patch with
  `settleBasis?`.

## 4. Phase machinery

Refactor `ReasoningProfile` (`deep_explore.ts:1376`) so each domain supplies **both**
round builders instead of one `buildRoundPrompt`:

```
interface ReasoningProfile {
  ...
  buildConvergePrompt(session, nodes, lessons)   // = today's buildRoundPrompt
  buildDivergePrompt(session, nodes, lessons)     // NEW for deliberate; formal reuses buildDiscoverPrompt
  divergeNodeKinds: ReasoningNodeKind[]           // formal: ['conjecture']; deliberate: ['construction','conjecture']
  settleBasisOf?(node, recordedBasis): 'empirical'|'preferential'  // deliberate only
}
```

- **FORMAL_PROFILE** (1398): `buildDivergePrompt = buildDiscoverPrompt`. Already done,
  just rewired so `discover` == "formal session in diverge phase".
- **DELIBERATE_PROFILE** (1418): new `buildDeliberateDivergePrompt` (Phase B) — *generate
  diverse candidate options / rival hypotheses / framings for the question; hang them as
  `construction`/`conjecture` nodes; DO NOT settle; counter-evidence search is a late
  safety net, not upfront pruning.* Reuses the novelty/diversity archive that already
  exists (`rankFrontier` 765, technique buckets / MAP-Elites, `NOVELTY_W`).

Round dispatch in `runRound` keys off `session.phase`:
- `phase==='diverge'` → diverge prompt; **skip** value-guided selection & stuck judgment;
  substantive = **net-new viable candidates** via generalized
  `divergeRoundWasSubstantive` (lift `discoverRoundWasSubstantive` 293 out of
  formal-only); update `diverge_idle_rounds` via `recordDivergeProgress`.
- `phase==='converge'` → today's path unchanged (`buildConvergePrompt`, value-guided
  ranking, skeptics, `judgeConvergence` 1100, `recordRoundProgress`).

`runDiscoverRound` (2293) collapses into "runRound with phase=diverge"; keep `discover`
action as a thin alias that sets `phase=diverge` then advances (back-compat).

## 5. The transition gate — the one hard control point

A **pure function** in the viability_gate style (testable, dependency-free), new file
`server/src/phase_gate.ts`:

```
export interface PhaseInput {
  phase: 'diverge' | 'converge';
  viableCandidates: number;     // open construction/conjecture nodes not refuted
  divergeIdleRounds: number;    // rounds since last net-new viable candidate (saturation)
  needsDecision: boolean;       // goal requires picking ONE (decision/diagnosis) vs open ideation
  convergeAllDead: boolean;     // converge eliminated every candidate → reopen generation
}
export type PhaseDecision = { phase: 'diverge'|'converge'; reason: string };
export function decidePhaseTransition(i: PhaseInput): PhaseDecision;
```

Rules (asymmetric — **default stays diverge; converge must EARN its turn**, mirroring
`MIN_EPISODE_ATTEMPTS` "don't declare a wall you haven't walked into"):

- in `diverge`: switch to `converge` **iff** `viableCandidates ≥ MIN_CANDIDATES (≈3)`
  **AND** (`divergeIdleRounds ≥ SATURATED (≈2)` **OR** `needsDecision`). Otherwise stay
  diverge. Pure ideation with no decision pressure → never auto-converges.
- in `converge`: switch back to `diverge` **only** on the high bar `convergeAllDead`
  (every candidate eliminated → the space was too small, regenerate). No other backward
  edge → no thrash.

Constants (no per-deployment knobs, like viability_gate): `MIN_CANDIDATES`,
`SATURATED_IDLE`. Whole feature behind `PHILONT_DEEP_EXPLORE_PHASES` (default ON since 2026-06;
set `=0` ⇒ exact legacy behavior).

Wire: at the **end** of `runRound`, after progress accounting, call
`decidePhaseTransition`; if it flips, `reasoning.setPhase(...)`, emit a one-line
milestone ("space populated — switching to evaluation"), and let the **next** round use
the new phase. `needsDecision` comes from goal classification (§7) + whether the user's
latest message asked to decide (reuse `decideTurnAnchors`, viability_gate:339-area).

## 6. Settle basis — empirical vs preferential (deliberate converge)

`reason_record` (1840) currently runs `DELIBERATE_PROFILE.settlePrecheck` requiring
`evidenceRefs > 0` for **all** deliberate nodes. Refine to a **per-node** rule:

- add optional `basis: 'empirical' | 'preferential'` to the `reason_record` tool schema
  (default `empirical` ⇒ today's gate). Persist to `node.settle_basis`.
- `empirical` node → unchanged: needs ≥1 cited source/observation.
- `preferential` node → needs grounding in the **user's own** stated values/constraints,
  not the open web: gate passes iff evidence references the user's data
  (searchNotes/getFact/readFile — the deliberate tool set already prioritizes these,
  1276) **or** an explicitly recorded user preference. Skeptic prompt
  (`buildDeliberateSkepticPrompt` 1289) variant: "is this consistent with the user's
  stated values?" rather than "is this externally cited?".

This unblocks value-laden decisions (e.g. "should I take this job") whose truth-maker is
the user's utility, which `evidence>0` against the open web wrongly rejects.

## 7. Auto-detect domain + initial phase at `start`

Today `start` (2460) has **no inference**: `mode = params.mode==='deliberate' ? ... :
'formal'`. Add a cheap classifier `classifyGoal(goal): { domain, initialPhase }`:
- `domain`: deductive if the goal is a theorem/conjecture/proof target (math notation,
  "prove/conjecture/show that"); else empirical. (Reuse `matchBarriers`/`findOrderClaim`
  signal as a hint; otherwise one low-effort LLM classification, gracefully defaulting to
  the explicit param.)
- `initialPhase`: `diverge` for open generative goals ("what are / brainstorm / explore
  the space of / options for"); `converge` for a stated target ("is X true / should I /
  root cause of"). Explicit `mode`/`phase` params always override.

## 8. Backward compatibility & rollout

- Master flag `PHILONT_DEEP_EXPLORE_PHASES` (default ON since 2026-06; disable with `=0`/off/
  false/no). Off ⇒ `phase` ignored, all
  paths identical to today. On ⇒ phase-aware dispatch + gate.
- Existing sessions load with `phase='converge'`, `settle_basis=NULL` ⇒ behave exactly as
  now. `discover` action still works (now sets phase=diverge).
- No change to viability_gate semantics; it continues to gate *continuation pitch*. Phase
  gate is orthogonal (one decides "keep going at all?", the other "generate vs evaluate").

## 9. Implementation phasing (shippable increments)

- **A — foundation (pure data-layer, behavior-preserving):** single migration v32 (adds
  `phase` + `diverge_idle_rounds` to `reasoning_sessions`, `settle_basis` to
  `reasoning_nodes`), interface/row-converter fields, and the store API B–E will call
  (`setPhase`, `recordDivergeProgress`, `updateNode` accepts `settleBasis`). **No dispatch
  change, no profile rename, no env flag** — those move to B where they are first
  exercised. `createSession` unchanged (new columns take DB defaults: `phase='converge'`,
  idle=0, basis=NULL), so every code path is byte-identical to today. This mirrors how
  `value`/`visits` (v26) and `auto_advance` (v30) landed as data-layer columns before their
  consumers. *Tests: migration idempotency (old DB → v32, defaults correct); round-trip of
  new fields through the store.*
- **A.1 — dispatch scaffolding (deferred from A):** profile `buildConvergePrompt`/
  `buildDivergePrompt` split (formal diverge = existing discover), `runRound` reads
  `session.phase`, master env flag `PHILONT_DEEP_EXPLORE_PHASES` (default off). Folded into
  the front of Phase B.
- **B — deliberate diverge (highest value):** `buildDeliberateDivergePrompt`,
  generalized `divergeRoundWasSubstantive`, novelty archive applies in empirical domain.
  *Tests: a "what are my options for X" goal populates ≥3 diverse candidate nodes without
  settling.*
- **C — transition gate:** `phase_gate.ts` + wiring at end of `runRound`. *Tests
  (concentrate here — the asymmetric control point): converge earns its turn only after
  population+saturation/decision; no diverge↔converge thrash; pure-ideation never
  auto-converges; convergeAllDead reopens.*
- **D — converge discrimination + settle basis:** discriminating-probe preference when
  rival siblings exist (augment value scorer 1756 to score split-power); per-node
  `settle_basis` empirical/preferential gate. *Tests: settlePrecheck routes by basis;
  preferential node settles on user-data grounding.*
- **E — auto-detect:** `classifyGoal` at start. *Tests: goal-shape → (domain, phase).*

## 10. Risks / open questions

- `needsDecision` detection error is the worst case (premature converge kills the space).
  Asymmetric default (stay diverge) + require population *and* saturation mitigates;
  watch in dogfood.
- Empirical domain has no truth verifier → diverge can flood plausible-but-junk
  candidates. Late counter-evidence safety net + the `viableCandidates` filter (refuted
  candidates don't count) bound it, but quality ceiling = base model. Label epistemic
  status in the report (`renderDeliberateReport` 1324): cited / derived / preferential /
  contested.
- Keep the action enum stable for back-compat; `discover` stays as a diverge alias rather
  than being removed.

## 11. Verification

- Unit: `phase_gate.test.ts` (transition truth table), extend `deep_explore.test.ts`
  (phase dispatch, diverge substantive accounting), `viability_gate.test.ts` unaffected.
- Schema: migration idempotency test (open old DB → v33 → columns present, defaults
  correct) alongside `agent-memory/tests/reasoning.test.ts`.
- E2E (flag on): (1) formal `discover`→`prove` still works; (2) deliberate "options for X"
  → diverge populates → gate flips → converge settles with evidence; (3) value-laden
  decision settles a preferential node on user data. Build gate: `tsc --noEmit` (CI-only;
  vite build does not typecheck — see project memory).
