# Answer-Time Evidence Ledger (HMS) — Phase 3b Proposal

Status: PROPOSED (2026-07-15). Design for review, not implemented.
Author: ruozhuoruoyu
Depends on: Phase 3a controller registry (landed); §3.2 / §2 (L1 layer) of `self_learning_redesign.md`.

---

## 1. Problem

The redesign's §2 diagnosis: philont's memory layers are used **only for recall** — facts are dumped
into the prompt and the model is left to reason about time and truth on its own. `buildMemoryPrefix`
(`server/src/chat-handler.ts:3573`, fact rendering at `:3941` `renderFactsSection`) emits each fact as a
bare line:

```
## Known user information
  user.role = "CTO at Acme"
  user.timezone = "Asia/Singapore"
## Current project
  project.deadline = "2026-03-01"
  ...
```

sorted by `lastAccessedAt desc`, capped at top-N. What is **thrown away** at injection time:

- **When** each fact became true / was last confirmed (`validFrom` / `occurredAt` / `createdAt` are all
  dropped).
- **Whether** a fact is the *current* one or a *stale* prior version. The store keeps the full history
  (superseded rows are never deleted — `store.ts:6`), but `listFacts` filters to `superseded_by IS NULL`
  so the model never sees "this replaced an earlier value" — it just sees the winner with no signal that
  a value ever changed.
- **Source / confidence** — `confidence` and the provenance of the fact are not surfaced.

This is exactly where this week's **stale-vs-current** failure class lives: the model answers "your
deadline is X" from a fact that was superseded two sessions ago, or conflates a value that was true *then*
with one true *now*, because the prompt gave it no temporal frame. The store already has the bitemporal
substrate (`getActiveAt`, `validFrom/validUntil`, `supersedes/supersededBy` chains); the ledger's job is
to **assemble that substrate into an explicit, time-and-source-stamped evidence block BEFORE the model
answers**, instead of asking the model to reconstruct it from flat KV lines.

This is the HMS ("here's what I currently believe, and here's what changed") idea, grounded in real APIs.

---

## 2. What already exists (the substrate — do not rebuild)

From `agent-memory/src/store.ts` (read, not assumed):

| API | Signature | What it gives the ledger |
|---|---|---|
| `getFact` | `(namespace, key) → Fact \| null` | the **current** active version (`superseded_by IS NULL`), refreshes `lastAccessedAt` |
| `getActiveAt` | `(namespace, key, at) → Fact \| null` | the version whose **validity window** `[validFrom, validUntil]` contains `at`; ties broken by newest `created_at`. This is the stale-vs-current arbiter. |
| `listFacts` | `(namespace) → Fact[]` | all active facts in a namespace (the current injection source) |
| `storeFact` | supersede semantics | on write, `new.supersedes = old.id` and `old.superseded_by = new.id` — the chain is already maintained |

`Fact` (from `types.ts`, confirmed via `rowToFact`): `{ id, namespace, key, value, confidence,
supersededBy, supersedes, createdAt, occurredAt, validFrom, validUntil, lastAccessedAt, decayTauDays,
forgottenAt, factKind: 'event' | 'state' }`.

**One small gap.** There is no method to walk a supersession chain (`getActiveAt` only returns the single
validity-time winner). The ledger needs the *previous* version to say "changed from → to". Two honest
options, both read-only and additive:

- Add `MemoryStore.getSupersededChain(namespace, key, { limit }): Fact[]` — follow `supersedes` backwards
  from the current head (`superseded_by IS NULL`) via repeated `SELECT * WHERE id = ?`, newest first,
  bounded by `limit` (default 3). Pure read, no schema change (the columns exist).
- Or a narrower `getPrevious(fact): Fact | null` = `fact.supersedes ? getById(fact.supersedes) : null`.

Prefer the chain method — the ledger wants at most the last 1–2 prior values, and the same call powers the
"history" rendering.

> Note: `getActiveAt` is **validity-time only** (the store comment at `:210` says a full bitemporal
> "as-known-at-T" would need a separate method). That is sufficient here: the ledger arbitrates *what is
> true now vs. what was true then*, which is validity-time, not knowledge-time.

---

## 3. The ledger data structure

The ledger is assembled per-turn, in memory, from the facts relevant to the turn. It is **not** a new
store — it is a derived view.

```ts
// server/src/evidence_ledger.ts (proposed)

/** One fact resolved into an explicit temporal/provenance entry. */
export interface LedgerEntry {
  namespace: string;
  key: string;
  /** The value that is current AS OF the answer time (from getActiveAt(ns,key,now) ?? getFact). */
  currentValue: unknown;
  /** Bitemporal frame, all epoch-ms, any may be null. */
  validFrom: number | null;
  validUntil: number | null;   // non-null → the fact has a known expiry; past → STALE
  occurredAt: number | null;   // when the underlying event happened (event facts)
  createdAt: number;           // when philont learned/extracted it
  confidence: number;          // store's own confidence (source-quality proxy)
  factKind: 'event' | 'state';
  /**
   * Stale-vs-current status, computed against answer time `now`:
   *   'current'     — validUntil null or >= now, and it is the active head
   *   'expired'     — validUntil != null and validUntil < now (was true, no longer)
   *   'superseded'  — a newer version exists (this entry is the newer one; `previous` holds the old)
   *   'unknown'     — no validity window to judge (bare state fact); surfaced as-is with its dates
   */
  status: 'current' | 'expired' | 'superseded' | 'unknown';
  /** The immediately prior version, if this key was ever overwritten (from getSupersededChain). */
  previous?: { value: unknown; validFrom: number | null; createdAt: number };
}

export interface EvidenceLedger {
  assembledAt: number;              // = now, the answer time the whole ledger is resolved against
  entries: LedgerEntry[];           // relevant facts, ordered current-first then by recency
  /** Keys the model asked about (from the recall query) that resolved to a STALE/expired/superseded
   *  value — these are the explicit "was X, is now Y (or unknown)" arbitrations. */
  changed: LedgerEntry[];
}
```

### Assembly algorithm (per turn, before the model answers)

Input: `recallQuery` (already computed in `buildMemoryPrefix`), `now = Date.now()`, the candidate fact
set (the same top-N `listFacts` selection buildMemoryPrefix already makes, so the ledger never widens the
context — it *re-frames the same facts*).

For each candidate `(namespace, key)`:

1. `active = getActiveAt(namespace, key, now)` — the version valid *right now*. Fall back to
   `getFact(namespace, key)` when there is no validity window (`factKind: 'state'` with null
   `validFrom/validUntil`).
2. Compute `status`:
   - `active.validUntil != null && active.validUntil < now` → **expired** (true in the past, not now).
   - `getActiveAt(...) != getFact(...)` (the validity-time winner differs from the current head) → the
     head is a *future-dated* or *replaced* value → **superseded**; pull `previous` from
     `getSupersededChain(ns, key, {limit:1})`.
   - the head has `supersedes != null` → it overwrote an earlier value → **superseded**, `previous` = the
     overwritten row (this is the common "user updated their deadline" case).
   - else → **current** (or **unknown** if no window at all).
3. Emit a `LedgerEntry`. If `status != 'current'` and the key is in the recall query, also push it to
   `changed`.

Ordering: `changed` first (the arbitrations the model most needs), then `current` by `lastAccessedAt`,
matching today's ranking so nothing regresses.

---

## 4. Where it injects

Inside `buildMemoryPrefix` (`chat-handler.ts:3573`), **replacing `renderFactsSection`'s flat lines** for
the `user.*` and `project.*` namespaces with a rendered ledger. The rendering makes time and change
explicit:

```
## What I know (as of 2026-07-15 14:20 SGT)
  user.role = "CTO at Acme"            [state · confirmed 2026-01-04 · current]
  project.deadline = "2026-06-01"      [state · set 2026-05-30 · CURRENT]
    ↳ was "2026-03-01" (set 2026-01-10) — changed 2026-05-30

## Changed / stale — do not answer from the old value
  project.milestone_q1 = (expired)     [was "ship beta", valid until 2026-03-31 — now past]
```

Design rules for the renderer, tuned against the failure mode:

- **Relative + absolute dates.** Render both "2026-05-30" and "6 weeks ago" — the relative form is what
  stops "your deadline is in 3 months" when it is now 3 weeks. `assembledAt` is the single anchor so all
  relatives are consistent within the turn.
- **`changed` block is separate and labeled imperatively** ("do not answer from the old value"), because
  a stale value buried in a flat list is exactly what got read last time.
- **Bounded like today.** Same top-N cap (`PROJECT_FACTS_TOP_N = 20`); the ledger re-frames the *same*
  selected facts, adding ~1 line per changed fact, so prompt growth is small and proportional to how much
  actually changed.
- **Gated behind a flag** (`PHILONT_EVIDENCE_LEDGER`, default off) so it ships shadow-first exactly like
  the judge (§5 of the redesign): the ledger can be *assembled and logged* for N days before it replaces
  the flat rendering, and the flat renderer stays as the fallback.

Injection point is the natural one: `buildMemoryPrefix` runs once per user turn (`:5013`), which is
precisely "a turn that needs cross-session memory reasoning". The ledger does **not** run on internal-gate
regen iterations (it is built with the prefix, not per-iteration), so it costs one assembly per turn.

---

## 5. Registering it as a controller (ties to 3a)

The ledger is a **cross-task L3 guard** for the stale-vs-current failure class, so it belongs in the
Phase 3a registry as its own controller — the redesign's §8 metric "stale-vs-current covered by a
registered controller" is satisfied concretely:

```ts
{ id: 'stale_memory', failureMode: 'answered from a superseded/expired fact instead of the current one',
  module: 'server/src/evidence_ledger.ts', entry: 'assembleEvidenceLedger',
  layer: 'answer-time', shape: 'decide', countable: true, envSwitch: 'PHILONT_EVIDENCE_LEDGER' }
```

Its "fire" event = a turn where the ledger's `changed[]` was non-empty (it had to arbitrate a
stale-vs-current conflict). `recordControllerFire('stale_memory')` at that point makes the value of the
ledger measurable in the same `controller.fire.*` counters as every other guard.

---

## 6. How it is scored (against the judge / an eval)

The ledger is a *reasoning aid*, not a pass/fail catch, so it cannot be scored by "did it block a bad
reply". It is scored two ways, both grounded in existing machinery:

### 6a. Offline eval over L0 (the latent eval set — redesign §2, L0 = `raw`/`actions` timeline)

Build a **stale-fact eval set** by mining the supersession chains that already exist in the store: every
`(namespace, key)` with `supersedes != null` is a real value change with a real timestamp. For each such
change at time `t_change`:

- Construct the situation "a turn at time `t_ask`" for `t_ask` both **before** and **after** `t_change`.
- The ground truth is deterministic: `getActiveAt(ns, key, t_ask)` — the store *knows* which value was
  current at each `t_ask`. No LLM judgment needed for the label.
- Metric: with the ledger vs. with the flat rendering, does the model's answer match the value that was
  actually current at `t_ask`? This is a clean, **attribution-free A/B** (same inputs, two prompts) — the
  GEPA-style replay the redesign already endorses (§4.4).

This is the strongest signal: the labels are free and exact because the bitemporal store is the oracle.

### 6b. Online, cross-checked against the judge (Phase 1)

Once the Phase-1 judge is trustworthy (its own kill gate), have it score turns where the ledger's
`changed[]` was non-empty: did the final reply **use the current value and correctly acknowledge the
change**, or did it answer from the stale one? The judge must cite the specific fact + timestamp from the
ledger as evidence (same anti-sycophancy grounding as `honesty_gate` — the ledger conveniently *is* the
citable evidence). Cross-check: on the eval-set situations (6a) where the label is known, the judge's
verdict must agree with the deterministic `getActiveAt` label — this doubles as a **judge calibration
probe** for the stale-vs-current class.

### 6c. Guardrail metric (anti-theater, redesign §8)

Track `controller.fire.stale_memory` (arbitrations made) against judge-confirmed stale-answer incidents.
The ledger is winning only if firing **rises** while stale-answer incidents **fall** — assembling ledgers
that never change an answer is theater, and the counter makes that visible.

---

## 7. Non-goals / risks

- **Not** a new store or schema change — one additive read-only method (`getSupersededChain`) and one
  derived view. The bitemporal columns already exist.
- **Not** widening context — re-frames the same top-N facts buildMemoryPrefix already selects.
- **Risk: over-flagging change.** A fact rewritten with an identical value would show as "superseded"
  noise; the renderer should suppress `changed` entries where `previous.value` deep-equals `currentValue`.
- **Risk: relative-date drift** — anchor every relative date to the single `assembledAt`, never
  `Date.now()` re-read per line.
- **Ship shadow-first** behind `PHILONT_EVIDENCE_LEDGER`, assemble-and-log before replacing the flat
  renderer, kill-gate on the 6a eval before going live — same discipline as the judge.
