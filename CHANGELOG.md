# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Compass** (`compass.md`, template `compass.example.md`) — the owner-authored source
  that orients the intrinsic drives. Others use a `soul.md` to give the *agent* a
  persona; a compass records where the *owner* wants their second mind pointed, and it
  is the missing top-of-stack input to machinery that already existed (constitution,
  trait model, pursuits). Three effects, none of them a prompt suggestion:
  drive lines carry a `[min,max]` **leash** that live trait tuning is clamped into (so
  competitiveness can adapt but never climb into buying a fabricated win); **focus
  areas are seeded as pursuit rows**, which is what *both* self-drive channels select
  from — prompt injection alone never reaches the background drivers, since they run
  without the main system prompt; and the prose is injected verbatim. Parsed by a
  deterministic, auditable grammar (no YAML dependency, never throws on a hand-written
  file). The active compass lives in the install dir, is auto-created from the template
  on first start, and is git-ignored. `PHILONT_COMPASS_PATH` overrides the location.
- **Two-model plan review, ratcheted by the mechanism** — a guide-driven plan is
  reviewed by a deterministic coverage check *and* an independent aux model, and the
  loop now carries the memory neither weak model has: REVISE receives the previous plan
  plus the deliverables no longer contested (ground can be added, never lost), the
  round that **scored best** is the one executed, a complaint raised again after a
  revision is marked `[RAISED AGAIN]`, and a checker-vs-reviewer disagreement is
  retained as CONTESTED and — on repeat — put to the author as a question. The reviewer
  is deliberately never given that memory; its independence is what makes its verdict
  worth anything. Judgement from the models, memory from the mechanism (production:
  deliverables 5→9→12, gaps 8→4→1, where redrafting alone had oscillated).
- **The learning judge** (`server/src/learning_judge.ts`, `PHILONT_LEARNING_JUDGE`,
  shadow-only) — scores each turn `success` / `failure` / `could_not_verify` so skills
  can later be crystallized from verified successes instead of online-attribution
  proxies. Deterministic rails decide the clear cases and the aux LLM is consulted only
  for the ambiguous middle; `success` **requires a successful grounding tool** (shell /
  http / a prover), never a bystander `readFile`, which is what makes it robust to
  rephrasing. Red-teamed before being wired; every finding is a regression test.
- **Controller registry** (`server/src/controller_registry.ts`) — the ~10 answer-time
  gates written one-per-bug are now enumerable as one L3-guard system with fire counters
  forwarded to metrics. A new failure mode registers a row instead of growing an
  eleventh bespoke gate. Purely additive: byte-identical behaviour.
- **`appendJournal`** — a `write:self` tool (no path parameter, append-only, fixed root)
  so an unattended turn can record its own run. Heartbeat turns may not call `writeFile`,
  which made "log to memory/YYYY-MM-DD.md" an unsatisfiable goal that failed identically
  fourteen runs in a row. Paired with an **unsatisfiable-goal detector** that reports
  from evidence — a tool blocked in 3 of the last 5 runs — rather than by classifying
  the goal text, and fires once on the crossing.
- **`AGENT_LANGUAGE`** — the owner declares zh / en / auto. Resolution is declaration >
  observed `user.locale` > channel > mirror; it is the only source available on a turn
  with no user message, which is exactly what a proactive push is.
- **Shell dialect self-correction** — a command that fails as "not found" is corrected at
  the moment it fails, by reading the *shell's own* wording. It holds no list of
  commands and no per-OS replacements deliberately: the OS already knows the answer and
  says it out loud, so one code path serves all three platforms.

### Changed

- **The LLM-compiled service contract is OFF by default** (`PHILONT_SPEC_COMPILE=1` to
  re-enable). Compiling 17k characters of prose into an enforceable contract asks the
  weak model to do, in one shot, the comprehension we already assume it cannot be
  trusted with — and then grants the result authority over every downstream guard. **A
  wrong call gets corrected by the service; a wrong contract has nothing to correct it,
  because the contract *is* the corrector.** Production: every fresh compile landed at
  the confidence floor with paths that were never base-resolved (→ 404s), and
  `rejected_by_spec_request_guard` became the largest single source of tool failures,
  with every investigated case a false block. Kept: the deterministic regex anchor and
  its host allowlist (a wrong host is the one error a service cannot report — it
  surfaces as an opaque `fetch failed`), endpoint/auth/body left to the service to
  answer, and guide coverage handed to the review loop.
- **The replayable service skill is emitted from verified calls + the regex anchor**,
  not from the compiled spec — the artefact worth keeping must not depend on the step
  most likely to fail (a scheduled heartbeat replayed it at 29/29 tools).
- **Retrieval no longer counts as efficacy.** `use_skill` fetching a skill's body ran
  through the outcome recorder, so "confirmed" meant *retrieved twice*, not *worked
  twice*. `recordUsage` now bumps usage stats only; efficacy is credited solely by the
  reflector's attribution of what happened *after* the retrieval. Superseded playbooks
  are retired instead of injected forever (supersession is a real signal; a count cap is
  not, and would recreate the FIFO pathology that deletes still-relevant lessons).
- **`plan_update_step` no longer demands a `plan_id` the model cannot know** — an LLM
  cannot reliably transcribe a 36-char UUID, and a mistyped one now resolves instead of
  deadlocking.
- Every card, error, and conclusion follows the owner's language, not the channel's;
  `deep_explore` sub-agents receive their true self-context instead of a main-prompt
  patch.

### Fixed

- **Authorization replies were graded by keyword matching.** The LLM classifier was
  selected only for `LLM_PROVIDER=anthropic`, so in production every authorization
  decision — the gate in front of every execute/system tool — ran a substring match that
  read *"Can I think about it a bit longer?"*, *"What does this tool even do?"* and
  *"Can you confirm this is safe?"* as **consent**. A keyword list cannot represent
  interrogation, negation or hedging, so it failed in the direction of acting. Replaced
  by a two-layer path: exact matching of the words *we offered on the card* (reading
  back our own closed enum, in both languages), then a fail-closed LLM intent judge.
- **Three independent mechanisms were cancelling the self-learning loop** (14 consecutive
  scheduled runs, judge `success=0`): a fabrication gate fired on the ordinal `第N轮`
  when no reasoning session existed (and its sibling rewrite guard had been replacing
  whole replies); the prefix trimmer shaved *"Lessons I have learned"* first — reflection's
  only channel into the prompt — on thirteen consecutive turns, while an unbounded fact
  series was what had actually grown; and a 24-hour **global** failure window sat in the
  per-turn strong-failure set, so once any failure recurred no turn could ever close
  clean.
- **The push off-switch we promised did not exist** — nobody could make the agent stop
  messaging them — and the constitution-amendment approval path was dead from the user's
  end. `deep_explore`'s own control words (放弃 / 全清 / 自动推进 / 停) were words nothing
  listened for.
- **`fabricated_execution_claim` now latches for the session** — an apology was a free
  exit from the gate.
- **Aux/vision endpoints**: `AUX_LLM_BASE_URL` tolerates all three ways it gets filled
  (bare host / versioned base / full endpoint) — the old code appended only
  `/chat/completions`, turning a bare host into a silent 404 that looked like a bad key;
  vision reuses the same resolver. Each aux call's timeout is now sized to its own output
  budget, and a dead endpoint is circuit-broken instead of waiting out the full timeout.
- **CI actually runs the server test suite** — it never had (module-level timers kept the
  process alive, so the suite had been excluded).
- FTS5 search terms are quoted, so an ordinary note search no longer fails as a
  `SqliteError`; a cleanup command aborts a schedule's in-flight run before deleting what
  it uses, and anchors a fresh viability episode so a clear is not judged on yesterday's
  failures.

## [0.2.0] — 2026-07-13

### Added
- **Loop-engineering spine** (`docs/design/motivation_loop_architecture.md`) — the
  reliability discipline made structural:
  - **Execution-ledger anchor + generation contract** — turns answer from the real
    record of tools that ran, not a remembered narrative; "I ran/compiled/verified X"
    is impossible to write unless the ledger shows it (`PHILONT_TURN_LEDGER_CONTRACT`).
  - **Goal-loop runtime** — a committed goal runs under a Loop Contract
    (trigger/scope/budget/stop/report); a trajectory-scoring metric drives
    continue / stop / escalate / switch-engine; a background driver auto-advances a
    committed `deep_explore` session within a budget (`PHILONT_DEEP_EXPLORE_AUTO_ADVANCE`).
  - **Intent router** — a turn-entry aux-LLM router sends each request to the engine
    that fits (deep_explore / plan / direct), and the harness *guarantees* the engine
    actually runs when the model narrates an advance without calling it
    (`PHILONT_INTENT_ROUTER`).
  - **Drives → goal-loops** — a sustained, high-stake, open theme is promoted to a
    committed goal-loop, tuned by personality traits.
  - **Verified skill recipes** — a spec-covered plan success is authored into a
    callable recipe (steps + tool policy + verification) (`PHILONT_RECIPE_AUTHORING`).
  - **Parallel sub-agent research** — `deep_explore` grounding fans out into isolated
    parallel sub-agents over distinct angles (`PHILONT_SUBAGENT_RESEARCH`).
- Open-source documentation: rewritten `README.md` (now led by the loop-engineering
  thesis), deployment guide (`DEPLOYMENT.md`), `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue/PR templates, and CI workflow.

### Fixed
- **Honesty** — broadened the recite/fabrication detectors to build/compile/test claims
  and to English phrasing; honest retraction of a prior fabrication no longer re-trips
  the gate; the deep_explore diverge round caps web lookups so it generates candidates
  instead of browsing; cross-round web-fetch/search dedup stops re-fetching the same source.
- **DeepSeek thinking mode** — a harness-synthetic / auth-resume tool_use turn without a
  thinking block no longer 400s ("content[].thinking must be passed back").
- **Windows console** — `start.ps1` disables QuickEdit so a click in the terminal no
  longer pauses output and freezes the whole agent; the file log is written before the
  console so it stays the durable source of truth.

#### Production hardening (from live WeChat/scheduled-agent logs)

- **`deep_explore` now reaches a conclusion.** A deliberate session had no reachable
  terminal state (`judgeConvergence` is proof-shaped), so research goals asked the owner
  to reply "continue" forever while the open frontier grew unbounded (observed: 14 rounds,
  open 3→20). It now delivers a synthesized answer on the same conditions as the old
  auto-answer but keeps the session active, so `continue`/`status` cannot hop to a
  different session (`PHILONT_DEEP_EXPLORE_SOFT_ANSWER`). Reworded repeats of an
  already-run search are deduped (exact-match missed them).
- **The reasoning engine is now actually reachable.** The force-start check lived only in
  the "first LLM response was pure text" branch — but a model that ignores the nudge and
  flat-searches necessarily *opens with a tool call*, so the check was structurally
  unreachable for exactly the behaviour it exists to catch. It is now evaluated wherever a
  turn emits its final text, including the iteration-cap path a flat-searching turn
  reliably lands on.
- **Routing asks instead of guessing.** Router confidence alone no longer force-starts a
  session — everything above the ask threshold asks the owner (entering the engine already
  costs an authorization prompt, so the question is free). An explicit depth request still
  goes straight in. The reply to that question is matched against the words the question
  itself offered, not handed to a generic authorization classifier that read our own
  "decline" word as consent. Debugging an artifact we wrote is routed as work, not research.
- **Honesty gates measure the turn, not their own amnesia.** The zero-tool branch keyed on
  a per-iteration window that resets whenever a gate injects a reminder, so a turn that had
  just sent a file successfully was accused of making zero tool calls; it now trusts the
  turn-durable ledger. A bare "sent it" with no successful send is caught.
- **Deadlocks removed.** A mistyped plan id (an LLM cannot reliably transcribe a 36-char
  UUID) now recovers instead of tripping the circuit breaker; a `plan_draft` against an
  auto-created placeholder promotes it in place; a stale closed plan points at `plan_draft`
  rather than at operations that can only error.
- **Context compaction no longer burns tokens for nothing.** The compactor's in-turn cap
  and the tool-result evictor's budget were misaligned, leaving a dead zone in which
  compaction fired every iteration while the only mechanism that could shrink an oversized
  tail never ran (observed: ~12 LLM summarize calls freeing 0.2%). Eviction now acts at the
  same point, and a compaction that frees too little stops retrying.
- **Self-learned routing rules can finally be validated.** Turn-close attribution counted a
  drained idle-period signal as failure evidence, which is on nearly every turn — so "the
  turn closed clean" was almost unreachable and no rule could ever collect the consecutive
  successes promotion requires (1022 rules stored, 0 validated).

## [0.1.0] — Developer preview

Initial public developer preview.

### Added
- **Mechanism/policy architecture** — a kernel design (`agent-core`, Rust,
  currently dormant) plus userspace TypeScript packages for concrete tools.
- **`agent-policy`** — 3×4 capability×domain permission matrix, validator chain
  (path ACLs, SSRF, dangerous commands, secret-leak detection), SHA-256 audit
  log, and per-session grants.
- **`agent-tools`** — built-in filesystem/runtime/network/git/vision tools,
  capability profiles, and a `SKILL.md` loader.
- **`agent-memory`** — 5-layer persistent memory (raw timeline, actions, notes
  with FTS5 search, structured facts, learned skills), cross-session fact
  extraction, skill reflection, context compaction, and an idle-time autonomous
  loop.
- **`agent-mcp`** — bridge to mount external MCP servers (stdio/SSE) as tools.
- **`agent-plugins`** — sandboxed third-party plugin discovery and loading.
- **`server`** — HTTP + WebSocket chat server with WeChat/Telegram channel
  gateways and a memory REST API.
- **`web-ui`** — Lit-based Web UI with chat, memory, and autonomy dashboards.
- **`launcher`** — supervisor with a setup wizard and process management.
- Multi-provider model support (Anthropic-, OpenAI-compatible: Claude, DeepSeek,
  GLM, Kimi, MiniMax, Gemini).

[Unreleased]: https://github.com/ruozhuoruoyu/Philont-Agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ruozhuoruoyu/Philont-Agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ruozhuoruoyu/Philont-Agent/releases/tag/v0.1.0
