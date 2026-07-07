# Spec Regime — when knowledge comes from a contract, compile it; stop patching parsers

Status: DESIGN 2026-07-06; increments 1–2 IN PROGRESS (this doc lands with them).
Author: ruozhuoruoyu.
Companion to `plan_execute_loop.md` (the execution machine this feeds) and
`skill_recipes.md` (increment 3's landing zone).

## 1. Problem — the patch treadmill and its root cause

The mycox integration produced six mechanism fixes in one day, four of them in the guide-ingestion
path alone: the endpoint extractor didn't know markdown tables, then the scraper tier mangled the
guide before the extractor ever saw it, then the anchored paths lacked the base-URL prefix so our
own guard blocked the CORRECT path (`/api/auth/verify`, blocked 5×/run) and steered the model to a
404. Each fix was real and each is regression-tested — but the shape repeats: a deterministic
parser/guard stack facing an open world can only encode formats it has already seen. **Every new
shape the world takes = a new blind spot = another patch.**

That is not an accident; it is the installment cost of the charter ("weak model + mechanism-layer
guarantees" — correctness lives in code, the model only fills content). The charter is right. The
implementation conclusion is wrong: we used regexes to SIMULATE UNDERSTANDING of prose, which is
exactly what models are good at and regexes are not. The division of labor should be:

> **The model understands prose. The mechanism validates truth.**

A guide like `mycox.ai/mycox/guide.md` is not "web content to summarize" — it is a **spec**: an
external authoritative contract (endpoints, auth, preconditions, rules). When a spec exists, no
knowledge about "how the world works" may be improvised — not by the model (endpoint hallucination,
the original disease) and not by regexes (format blind spots, the current disease). It must be
**compiled once, validated deterministically, cached, and consumed everywhere**.

## 2. The two axes — spec is not a fourth route

Spec vs plan is a false opposition. During first-time mycox onboarding, spec (the contract) and
plan (the execution machine) are used TOGETHER. The real structure is two orthogonal axes:

- **Knowledge axis** — does an external authoritative contract exist (guide / API doc / protocol /
  format spec)? If yes, all world-knowledge must derive from the compiled spec. If no, knowledge
  comes from the user's words and from exploration.
- **Task axis** — is the goal open-ended, concrete-multi-step, trivial, recurring, or destructive?

### Scenario × capability matrix

| Scenario | Route / capability | Knowledge layer | Example | Today |
|---|---|---|---|---|
| Open question: research, proof, direction survey, deliberation | `deep_explore` (phase ratchet + magnitude/barrier/viability teeth) | No spec; sources are evidence, not contract | "are the Goldbach barriers one obstruction?" | ✅ built |
| First-time integration against a contract | **spec compile + plan-loop** | SpecDoc (compiled + validated + cached); registry/guards/templates/deliverable-typing all read from it | mycox registration; any documented API | 🔶 fragments exist (endpoint anchor IS a crippled spec compiler) — this is the patch-treadmill site |
| Recurring routine against a contract | **routine** (scheduled: cached spec + cookbook/skill) | Reads cached SpecDoc + verified recipe; never re-plans, never re-fetches the guide, never re-registers | mycox daily check-in | 🔶 loop gate isolates scheduled turns, but they still re-read the guide each fire |
| Multi-step build without a contract | plan-loop (tier 2: literal actions from the user message) | The user's message is the spec | "make a PPT from these three docs" | 🔶 tier 2 pending |
| Trivial single-step, Q&A, chat | `direct` (fast) | — | "what day is it", update one fact | ✅ |
| Destructive cleanup | `direct` + cleanup scope (no external writes + scoped schedule pause + credential hygiene) | — | "清除 mycox" | ✅ 23c71c5 |

One-line dispatch rule: **contract → spec (knowledge may not be improvised); open goal → explore;
concrete multi-step → plan; recurring → routine (eat the cached recipe); trivial → direct;
deletion → cleanup scope.**

### Handoffs (as important as the matrix)

- `deep_explore` conclusions that become actionable → hand to plan (exploration never executes).
- plan hits an undecidable open sub-question → viability gate stops and reports (already correct).
- **Spec compile fails or low-confidence → degrade to the regex anchor + an honest registry note**
  ("spec not compiled; running on heuristics"). This keeps the upgrade incremental, not a bet.
- SpecDoc is cached by guide content hash. **Hash changed → recompile + diff report** (this also
  covers guide updates — the `/auth/verify` endpoint vanishing from the guide was this case).

## 3. Increments

### Increment 1 — `spec_compile.ts`: aux-LLM guide→SpecDoc compiler + deterministic validation

- `SpecDoc`: `{ source{url?, contentHash}, service{name, hosts[]}, basePath, auth{scheme, header},
  endpoints[{method, path, purpose, requiredFields?}], preconditions[], rules[], confidence }`.
- `compileSpec(guideText, {call})`: aux-LLM (same `AuxLLMCaller` contract as the intent router)
  with a strict JSON instruction → parse → **deterministic validation** (shape checks; paths
  base-resolved; methods legal) → **cross-check against the regex extractor** (regex hits missing
  from the LLM output are merged in — regex is the floor, never discarded) → in-memory cache keyed
  by content hash (one compile per guide version per process; persistence arrives with increment 3
  as the service skill).
- `specToGuideApi(spec)` adapter feeds the EXISTING consumers (endpoint registry, host guard,
  auth-path guard, schedule instruction guard) — no consumer changes.
- Wiring: plan-loop GUIDE_READ compiles when an aux caller is configured;
  `PHILONT_SPEC_COMPILE=0` kills; any failure falls back to the regex anchor verbatim.

### Increment 2 — anchor self-check: find the blind spot at fetch time, not in production

`anchorSelfCheck(guideText, api)`: deterministically count documented-call evidence lines in the
guide (table rows carrying a path+method, `curl` invocations, `METHOD /path` prose) and reconcile
against the anchored endpoint count. Anchored ≪ evidence → loud log + audit event. This one check,
run at anchor time, would have caught `endpoints=3 vs 13 table rows` on day one — the discovery
loop compresses from "user runs a production cycle" to "the fetch itself warns".

(Endpoint liveness probing — unauth GET sampling, 401/404 discrimination — belongs to increment 1's
validation, restricted to GET endpoints to stay side-effect-free. Deliberately NOT in increment 2:
the self-check must stay deterministic and offline.)

### Increment 3 (next) — SpecDoc lands as a service skill

The compile output becomes a philont **service skill** (`mycox`: structured endpoint table + auth
mode + routine playbook + credential-id references), managed by the existing skill lifecycle:

1. Scheduled check-ins `use_skill(mycox)` and eat the verified recipe — the routine row of the
   matrix stops re-fetching the guide on every fire;
2. **"清除 mycox" = uninstall that skill + credentials + schedules** — cleanup finally has a real
   boundary object (today's cleanup guards are fences built around its absence);
3. No third storage system — the FS/DB skill split already taught that lesson.

### Increment 4 (later) — router stays put

The plan-loop entry condition (route=plan + guide URL) IS the spec-scenario trigger. The innards
change; the door does not. A separate `routine` distinction for scheduled turns already exists via
the loop gate.

## 4. Invariants this buys

- **Ingest fidelity first**: spec files fetch verbatim (webFetch tier 0, 953ce5d) → compile →
  guard. Never parse a lossy rendering of a contract.
- **One source of truth**: registry, guards, corrective messages, and templates all read the same
  SpecDoc — a wrong path can no longer be "corrected" INTO a 404 by our own guard.
- **Anchored paths are sendable paths** (7ab22c5's lesson, now structural).
- **Self-checking anchors**: a compile/anchor whose coverage disagrees with the document's own
  evidence announces itself instead of waiting for a production run.
