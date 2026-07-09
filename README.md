# Philont-Agent

<p align="center"><b>A self-hostable AI agent that runs complex, multi-step work on a model ~100× cheaper than the frontier — and is built so it can't fake success.</b></p>

[![CI](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)
[![Wiki](https://img.shields.io/badge/docs-Wiki-2563eb.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)

**Philont: the being-agent.** Most open-source agents are **task runners** — powerful at carrying out what you ask, but tools all the same. Philont is built to be a **being**: an independent character with intrinsic drives that research while you're away, continuous memory across every session and channel, and — anchored to an execution ledger of what actually happened — a runtime that makes it structurally unable to **pretend success**. Because its intelligence lives in the **loop, not the model**, it runs on a model ~100× cheaper than the frontier (DeepSeek Flash class); bring your own: Claude, DeepSeek, GLM, Kimi, MiniMax, Gemini, or any compatible endpoint. It reaches you on **WeChat, Telegram, a Web UI, or a headless CLI**.

> 📖 **Deep dive: the [Philont Wiki](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)** (English / 中文) — [Architecture](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Architecture) · [Selfhood Engineering](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Selfhood-Engineering) · [Honesty Gates](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Honesty-Gates) · [Plan Protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol) · [Deep Reasoning](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Deep-Reasoning) · [Why a Cheap Model Is Enough](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Why-a-Cheap-Model-Is-Enough)

---

## Quick start

> **Platform status:** Developed on **Windows**; **Linux and macOS (Apple Silicon) build & boot are verified in CI** on every push.
> **Prerequisites:** Node.js ≥ 20 and an Anthropic- or OpenAI-compatible API key. No Rust toolchain — the runtime is pure TypeScript.

```bash
git clone https://github.com/ruozhuoruoyu/Philont-Agent.git
cd Philont-Agent

# Build everything and start. The launcher opens your browser
# to a setup wizard, then supervises the agent.
./scripts/start.sh            # Windows: .\scripts\start.ps1
```

Or step by step:

```bash
./scripts/build-all.sh        # Windows: .\scripts\build-all.ps1
cp .env.example .env          # add your API key
(cd server && npm run dev)    # agent server  → http://localhost:20266
(cd web-ui && npm run dev)    # web UI        → http://localhost:5173
```

Open **http://localhost:5173**. The **Memory** tab shows what Philont learns as you talk; the **Autonomy** tab shows its own agenda, personality traits, and pending constitution proposals. For Docker and production deployment see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Why Philont

One idea, applied everywhere: **an agent's reliability comes from the loop it runs, not the prompt it reads.** A prompt instruction is a suggestion the model can ignore; a loop is code it cannot. Three consequences:

- **It can't fake success.** Every turn is anchored to an **execution ledger** — the real record of what tools ran — and a family of honesty gates compares every claim ("done", "sent", "proved", "remembered") against it, forcing an honest regeneration when they diverge. → [Honesty Gates](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Honesty-Gates)
- **A cheap model is enough.** The gap between a frontier model and a cheap one on long tasks is a small, predictable set of failure modes (winging it, premature "done", fabricated numbers, blind retries) — and each one is caught by a runtime mechanism instead of paid for in frontier tokens. → [Why a Cheap Model Is Enough](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Why-a-Cheap-Model-Is-Enough)
- **It's a being, not a task runner.** Intrinsic drives (curiosity / pursuit / commitment) generate its own goals at idle time; its personality traits are **derived from its own track record**, not constants; it keeps an evidence-backed self-model of how it actually behaves; and its constitution evolves only through amendment proposals **you ratify** — red lines can never be amended. All of it visible: send `/autonomy` in chat or open the dashboard. → [Selfhood Engineering](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Selfhood-Engineering) · [design doc](docs/design/selfhood_closure.md)

| | OpenClaw | Hermes | **Philont** |
|---|:---:|:---:|:---:|
| Core model | extrinsic task runner | task runner + learning loop | **autonomous being with intrinsic drives** |
| Acts on its own initiative | ⚠️ scheduled | ⚠️ scheduled cron | ✅ curiosity · pursuit · commitment drives |
| Self-learning from its own **failures** | ❌ | ⚠️ learns from successful runs, not failures | ✅ failure notes · anti-patterns · **honesty gates against pretended success** |
| Step-by-step deep exploring | ❌ | ❌ | ✅ `deep_explore` — dual-mode tree (formal proof · evidence-based deliberation) |
| Built-in permission / audit layer | command allowlist | command approval | ✅ 3×4 capability matrix · validator chain · SHA-256 audit log |
| Runs complex tasks on a **cheap** model | ⚠️ leans on a strong model | ⚠️ leans on a strong model | ✅ **DeepSeek V4 Flash — ~100× cheaper** |
| Persistent cross-session memory | ✅ | ✅ | ✅ 5-layer (timeline · actions · FTS notes · facts · skills) |
| Lives across channels (WeChat / Telegram / …) | ✅ | ✅ | ✅ |

OpenClaw and Hermes are excellent at *doing what you ask* — and we [gratefully build on both](#acknowledgements). Philont is built to *want things, reason about them, and stay honest* — on hardware-store-cheap inference.

---

## What it does

| | |
|---|---|
| **Honesty guardrails** | Gates catch pretended success, fabricated numbers, false "sent it to you" claims, and half-finished hand-offs — and force an honest regeneration. You can't learn from a failure you pretended didn't happen. |
| **Plan → execute → revise, enforced** | For a multi-step, world-changing job (deploy, register, send, deliver) the agent is mechanism-forced through *plan → step-by-step execution → revise around failures → close only with a verified outcome*. The gate blocks **world-changing** write/execute tools until a plan is executing — reads, `deep_explore`, and local computation (PARI/GP, z3, Lean — a calculator changes nothing) always flow. → [Plan Protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol) |
| **Deep exploring** | Hard questions get a `deep_explore` session: a persistent reasoning **tree** (*decompose → claim → verify → backtrack*) you can resume days later. `formal` mode settles a claim only when it's **machine-checked** (z3 · PARI/GP · an asymptotic-order algebra · curated lemma & no-go libraries); `deliberate` mode settles only on **cited evidence** that survives an adversarial reviewer. A turn-entry router sends reasoning-shaped requests here — high-confidence ones are **guaranteed** into the engine, mid-confidence ones ask you first. → [Deep Reasoning](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Deep-Reasoning) |
| **Service specs, compiled & enforced** | A service's prose guide is compiled once into a machine-validated **SpecDoc** (endpoints, auth, preconditions, rules). Guards check every call against it — wrong host, invented endpoint, or missing required field is rejected before it leaves the process — and a verified run crystallises into a reusable **service skill**. The model understands prose; the mechanism validates truth. |
| **Permission & audit layer** | Every tool call passes a 3×4 capability matrix (read/write/execute × local/network/system/self) with a SHA-256-chained audit log. Approving one local write/execute unlocks the **research workflow set** (write → run → download loop) for 30 minutes — one "ok" per task, not twelve — while destructive deletes and external/untrusted execution stay per-call. A validator chain blocks sensitive paths (`~/.ssh`, `.env`, …) and catastrophic commands (`rm -rf /`, fork bombs, secret-exfil pipes). See **[SECURITY-DESIGN.md](SECURITY-DESIGN.md)** for exactly what is and isn't enforced today. |
| **5-layer persistent memory** | SQLite-backed raw timeline, action log, FTS notes, structured facts, and learned skills — cross-session, cross-channel. Skills carry maturity grades, decay, and **reuse-time verification**: a recipe that stops working is caught by its own check and demoted. |
| **Autonomy you can see** | While you're away, drives research knowledge gaps and advance stalled goals under strict budgets; important findings (new sourced facts only) reach you at discovery time via push. `/autonomy` in chat — or the Web UI dashboard — shows the agenda, live traits, self-observations, and anything awaiting your approval. |
| **MCP, plugins & BYOM** | Mount any MCP server (Playwright gives it a full browser), load sandboxed plugins, and point it at any Anthropic- or OpenAI-compatible model with a config change. |

---

## A note on deep exploring — from the author

Philont has two deep-work protocols, and the rule of thumb is: *if the work succeeds, what changed?* **What you know** (a proof, a decision, a diagnosis) → `deep_explore`. **The world** (something deployed, sent, delivered) → a plan. They compose: think it through first, then execute the consequences.

> **A note from the author — a layman, not a mathematician.** I spent about a week pointing `deep_explore` at the **Goldbach conjecture**. It built and pruned a real reasoning tree and closed off many dead ends, but it did **not** produce a breakthrough — and I'm not equipped to judge how close any of it came. (That experience is exactly why `deep_explore` now carries the `magnitude`, `lemmaLookup`, and `barrierCheck` verification teeth — so it does the quantitative bookkeeping an LLM slips on, and flags a known no-go before grinding it.) If you're a mathematician — or a researcher in any field — I'd genuinely love for you to try Philont on real problems and tell me where it helps and where it falls short.

---

## Configuration

Everything is configured via environment variables (`.env`, or the launcher's setup wizard). **[.env.example](.env.example)** is the fully annotated list; selected:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Main model key (required for the default provider). |
| `LLM_PROVIDER` | `anthropic` | `anthropic` \| `openai` \| `glm` \| `kimi` \| `minimax` \| `gemini`. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | Any OpenAI-compatible endpoint (DeepSeek, Together, local, …). |
| `PHILONT_MCP_BROWSER` | off | Browser automation via Playwright MCP. |
| `PHILONT_INTENT_ROUTER` | on | Turn-entry router (think / build / direct). Reasoning tasks: conf ≥ `PHILONT_DEEP_EXPLORE_FORCE_CONF` (0.9) enters `deep_explore` guaranteed; ≥ `…_ASK_CONF` (0.7) asks you first; below runs flat. |
| `PHILONT_DEEP_EXPLORE_AUTO_ADVANCE` | on (per-session opt-in) | Background driver that advances a *committed* reasoning session within a rounds/token budget, pausing to report. |
| `PHILONT_AUTONOMOUS` / `PHILONT_AUTONOMOUS_DAILY_TOKENS` | on / `0` (unlimited) | Idle-time autonomous loop and its optional daily token ceiling. |
| `PHILONT_TRAITS_LIVE` / `PHILONT_SELF_OBSERVATIONS` / `PHILONT_CONSTITUTION_PROPOSALS` / `PHILONT_RECIPE_REUSE_VERIFY` | on | The selfhood layer (live traits · self-model · owner-ratified identity amendments · recipe reuse checks). |
| `PHILONT_CONSCIENCE_GATE` | off | LLM safety check on each outbound human-facing message (fail-open). |
| `MEMORY_DB_PATH` | `~/.philont/memory/memory.sqlite` | SQLite memory database path. |
| `PHILONT_PROXY` / `HTTPS_PROXY` | — | Global outbound proxy for all fetch traffic. |
| `TELEGRAM_ENABLED` / `WECHAT_ENABLED` | off | Messaging channel gateways. |

> ⚠️ The Web UI ships without authentication and binds to localhost. Do not expose the port to the internet — put a reverse proxy with auth and TLS in front. See [DEPLOYMENT.md](DEPLOYMENT.md#production-hardening).

---

## Channels

One server drives all interfaces simultaneously; enable any combination from **Settings** in the Web UI.

- **Web UI** (default): open http://localhost:5173 — chat, memory browser, autonomy dashboard.
- **Telegram**: create a bot with [@BotFather](https://t.me/BotFather), paste the token in Settings → Channels, set access policies. Blocked region? Set `TELEGRAM_PROXY` to route only Telegram traffic.
- **WeChat**: `(cd server && npm run wechat:login)` and scan the QR once (iLink bridge — no WeCom or API account needed), then enable in Settings → Channels.

Details and troubleshooting: [wiki → Channels](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Channels).

---

## Repository layout

```
Philont-Agent/
├── agent-policy/   Permission matrix, validator chain, SHA-256 audit log, grant store.
├── agent-tools/    Built-in tools (fs, shell, network, compute, vision, …) + SKILL.md loader.
├── agent-mcp/      MCP bridge — mounts external MCP servers as native tools.
├── agent-plugins/  Third-party plugin discovery and sandboxed loading.
├── agent-memory/   5-layer memory, self-learning loop, autonomy drives, selfhood layer.
├── server/         HTTP + WebSocket server; gates & loops; WeChat / Telegram gateways.
├── web-ui/         Lit-based Web UI (chat · memory · autonomy).
├── launcher/       Supervisor: setup wizard + process management.
└── demo/           End-to-end demos.
```

Build order: `agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher` (`scripts/build-all.{sh,ps1}` handles it).

## Testing

```bash
# Library packages
for pkg in agent-policy agent-memory agent-tools agent-mcp agent-plugins; do
  echo "== $pkg =="; (cd "$pkg" && npm test 2>&1 | tail -5)
done

# Server suite (needs --test-force-exit: module-level timers keep bare node --test alive)
(cd server && npx tsx --test --test-force-exit tests/*.test.ts)
```

## Status

**Developer preview (v0.x).** Core features are implemented and covered by tests; production hardening (sandbox stress/escape testing, cross-platform binaries) is in progress. Good for research, experimentation, and self-hosted personal assistants — not yet for unattended production workloads.

**Roadmap (selected):** write-capable autonomous actions behind stricter budget + audit · locale layer polish · npm / Docker publishing.

## Contributing

Issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the build/test workflow and **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** for community expectations. Security issues go to **[SECURITY.md](SECURITY.md)** — not a public issue.

## Acknowledgements

Philont stands on the shoulders of two open-source agents we genuinely admire — the comparison above is about *positioning*, not disparagement. Where we adapted their work, the borrowing is credited inline in the source with a `Reference:` comment (convention in [CONTRIBUTING.md](CONTRIBUTING.md)); the list below is not exhaustive.

**[Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research.** We owe Hermes a real debt:
- the dangerous-command pattern set in our permission layer is derived from Hermes' `tools/approval.py` → `agent-policy/src/validators/dangerousCommands.ts`;
- our WeChat bridge — login state machine, message extraction, and the lenient decrypt variant — follows the Hermes WeChat adapter → `server/src/channels/wechat/*`;
- our Telegram gateway approach is informed by Hermes' Telegram platform → `server/src/channels/telegram/client.ts`;
- our tool-call parser handles the `<tool_call>` tag format used by Hermes / Nous models → `server/src/llm-adapter.ts`.

**[OpenClaw](https://github.com/openclaw/openclaw).** We learned from OpenClaw too:
- our path-ACL workspace-root resolution is modeled on OpenClaw's `media-tool-shared.ts` → `agent-policy/src/validators/pathAcl.ts`;
- Philont's skills loader is **compatible with the OpenClaw / `clawhub` skill convention** (`<workdir>/skills/`), so skills installed the OpenClaw way work in Philont unchanged → `agent-tools/src/skills/loader.ts`.

We also reference [Claude Code](https://claude.com/claude-code)'s WebFetch design and several research papers (FunSearch, LATS, Self-Consistency, …) in the deep-exploring module; those are credited inline where used. Thank you to all of these projects and their authors.

## License

MIT — see [LICENSE](LICENSE).
