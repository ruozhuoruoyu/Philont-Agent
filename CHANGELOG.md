# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
