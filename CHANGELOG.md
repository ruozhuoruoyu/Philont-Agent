# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/<your-org>/philont/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<your-org>/philont/releases/tag/v0.1.0
