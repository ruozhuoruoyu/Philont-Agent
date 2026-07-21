# Philont-Agent

<p align="center"><b>A self-hosted AI agent that acts on its own initiative, remembers and learns from its own failures, and is structurally unable to fake success — on a model ~100× cheaper than the frontier.</b></p>

[![CI](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)
[![Wiki](https://img.shields.io/badge/docs-Wiki-2563eb.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)

**Philont: Selfhood Engineering.** Most open-source agents are **task runners** — powerful at carrying out what you ask, but tools all the same. Philont is built to be a **being** instead: intrinsic drives that research while you're away — pointed by a **compass you write** — memory and judgment that grow across every session and channel, and autonomy that stays **bounded**: every action passes an auditable permission layer, its drives self-tune only inside the leash you set, and its core values sit behind red lines it cannot rewrite itself. Anchored to an execution ledger of what actually happened, it's structurally unable to **pretend success**. Because its intelligence lives in the **loop, not the model**, it runs on a model ~100× cheaper than the frontier (DeepSeek Flash class); bring your own: Claude, DeepSeek, GLM, Kimi, MiniMax, Gemini, or any compatible endpoint. Self-hosted on your own machine, it reaches you on **WeChat, Telegram, a Web UI, or a headless CLI**.

> 📖 **Deep dive: the [Philont Wiki](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)** (English / 中文) — [Architecture](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Architecture) · [Selfhood Engineering](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Selfhood-Engineering) · [Compass](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Compass) · [Honesty Gates](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Honesty-Gates) · [Plan Protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol) · [Deep Reasoning](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Deep-Reasoning) · [Why a Cheap Model Is Enough](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Why-a-Cheap-Model-Is-Enough)

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

Then **open `compass.md`** in the repo root (created for you on first start from [`compass.example.md`](compass.example.md)) and make it yours — it is where you tell your second mind where to point. See [Compass](#compass--you-say-where-it-points) below.

---

## Why Philont

One idea, applied everywhere: **an agent's reliability comes from the loop it runs, not the prompt it reads.** A prompt instruction is a suggestion the model can ignore; a loop is code it cannot. Six consequences:

- **It can't fake success.** Every turn is anchored to an **execution ledger** — the real record of what tools ran — and a family of honesty gates compares every claim ("done", "sent", "proved", "remembered") against it, forcing an honest regeneration when they diverge. → [Honesty Gates](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Honesty-Gates)
- **A cheap model is enough.** The gap between a frontier model and a cheap one on long tasks is a small, predictable set of failure modes (winging it, premature "done", fabricated numbers, blind retries) — and each one is caught by a runtime mechanism instead of paid for in frontier tokens. → [Why a Cheap Model Is Enough](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Why-a-Cheap-Model-Is-Enough)
- **It's a being, not a task runner — and you say where it points.** Intrinsic drives (curiosity / pursuit / commitment) generate its own goals at idle time, aimed by a **compass file you write**; it keeps an evidence-backed self-model of how it actually behaves; and its constitution evolves only through amendment proposals **you ratify** — red lines can never be amended. All of it visible: send `/autonomy` in chat or open the dashboard. → [Compass](#compass--you-say-where-it-points) · [Selfhood Engineering](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Selfhood-Engineering) · [design doc](docs/design/selfhood_closure.md)
- **Two cheap models beat one — because the mechanism holds the memory.** A multi-step build that ships with a written guide is drafted by the main model and reviewed by a **second, independent model** plus a deterministic coverage check. Neither weak model remembers anything across rounds, so the *loop* does: the revision sees its own previous plan and what the reviewers already accepted (ground can be added, never lost), the round that scored best is the one executed, a complaint raised twice is escalated, and a disagreement between the two reviewers is put back to the author as a question. Judgement from the models, memory from the mechanism — which is what makes two passes worth more than two attempts (production: deliverables 5→9→12, gaps 8→4→1, where redrafting alone had oscillated). → [Plan Protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol)
- **It learns only from what it can verify.** Knowledge is promoted a layer at a time and only after it is checked at the layer below — *verify-then-condense*. A **learning judge** scores each turn and may call it a success only when a real **grounding tool** (shell / http / a prover) actually did the thing; a fabricated claim with a bystander `readFile` next to it cannot mint a skill. Recipes are re-verified every time they're reused, and one that breaks is **diagnosed from its own failed runs in the execution ledger and rewritten**, with the prior version kept so the fix must re-earn trust. A missed lesson is cheap; a fabricated success poisons the memory — so the loop is deliberately biased toward learning nothing. (Honest status: the judge runs in **shadow** — it scores and logs; letting it mint skills is gated on its verdicts proving trustworthy in real logs first.) → [Autonomy & Self-Learning](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Autonomy-and-Self-Learning) · [design doc](docs/design/self_learning_redesign.md)
- **It remembers — episodically and procedurally.** A 5-layer memory (timeline, actions, FTS notes, facts, skills) persists across every session and channel; a service integration that provably worked is kept as its **verified calls** and replayed, rather than re-read and mis-remembered on every run. → [Memory System](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Memory-System)

| | OpenClaw | Hermes | **Philont** |
|---|:---:|:---:|:---:|
| Core model | extrinsic task runner | task runner + learning loop | **autonomous being with intrinsic drives** |
| Acts on its own initiative | ⚠️ scheduled | ⚠️ scheduled cron | ✅ curiosity · pursuit · commitment drives |
| **You declare where it points** | ❌ | ⚠️ `SOUL.md` — a persona for the agent | ✅ `compass.md` — *your* direction: a **leash** its drives cannot self-tune past, and focus areas that seed what it pursues at night |
| Self-learning from its own **failures** | ❌ | ⚠️ learns from successful runs, not failures | ✅ failure-driven skill demotion · anti-patterns learned from tool failures |
| **Repairs its own skills after they fail** | ❌ | ⚠️ | ✅ diagnose from failed runs → rewrite → re-verify (old version kept) |
| A second model reviews the plan | ❌ | ❌ | ✅ author + independent reviewer + deterministic check, **ratcheted by the loop** |
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
| **Plan → execute → revise, enforced** | For a multi-step, world-changing job (deploy, register, send, deliver) the agent is mechanism-forced through *plan → step-by-step execution → revise around failures → close only with a verified outcome*. The gate blocks **world-changing** write/execute tools until a plan is executing — reads, `deep_explore`, and local computation (PARI/GP, z3, Lean — a calculator changes nothing) always flow. When the task comes with a written guide, a **deterministic state machine** owns the whole turn instead: the model fills in each state's content and cannot skip verification or declare itself done. → [Plan Protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol) |
| **Deep exploring** | Hard questions get a `deep_explore` session: a persistent reasoning **tree** (*decompose → claim → verify → backtrack*) you can resume days later. `formal` mode settles a claim only when it's **machine-checked** (z3 · PARI/GP · an asymptotic-order algebra · curated lemma & no-go libraries); `deliberate` mode settles only on **cited evidence** that survives an adversarial reviewer. A turn-entry router sends reasoning-shaped requests here — high-confidence ones are **guaranteed** into the engine, mid-confidence ones ask you first. → [Deep Reasoning](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Deep-Reasoning) |
| **Two weak models, one plan** | The plan for a guide-driven job is *drafted* by one model and *reviewed* by a second, independent one alongside a deterministic coverage check — and the loop supplies the memory neither of them has: revisions build on the accepted plan instead of restarting, the best-scoring round is the one executed, a repeated complaint is escalated, and reviewer-vs-checker disagreement becomes a question for the author. The reviewer is deliberately never shown its own past verdicts — its independence is the whole reason its opinion is worth anything. (It is the `AUX_LLM_*` model; leave that unset and verification degrades to the deterministic check alone.) |
| **Guards a service can't provide itself** | The runtime enforces only what the service cannot correct on its own: a **host allowlist** derived by deterministic parsing (a wrong host surfaces as an opaque `fetch failed`, which an agent will misread for days), and an optional guard against writing an identifier the agent never actually read. Wrong endpoint, wrong auth, wrong body are left to the service to answer — `404`/`401`/`400` are free and exact. Asking a weak model to *compile* the guide into an authoritative contract is available (`PHILONT_SPEC_COMPILE=1`) but **off by default**: a wrong call gets corrected, a wrong contract does not, because the contract *is* the corrector. |
| **Permission & audit layer** | Every tool call passes a 3×4 capability matrix (read/write/execute × local/network/system/self) with a SHA-256-chained audit log. Approving one local write/execute unlocks the **research workflow set** (write → run → download loop) for 30 minutes — one "ok" per task, not twelve — while destructive deletes and external/untrusted execution stay per-call. A validator chain blocks sensitive paths (`~/.ssh`, `.env`, …) and catastrophic commands (`rm -rf /`, fork bombs, secret-exfil pipes). See **[SECURITY-DESIGN.md](SECURITY-DESIGN.md)** for exactly what is and isn't enforced today. |
| **5-layer persistent memory** | SQLite-backed raw timeline, action log, FTS notes, structured facts, and learned skills — cross-session, cross-channel. Skills carry maturity grades, decay, and **reuse-time verification**: a recipe that stops working is caught by its own check, demoted, then diagnosed and rewritten — the prior version kept in a revision history. |
| **Autonomy you can see — and aim** | While you're away, drives research knowledge gaps and advance stalled goals under strict budgets, anchored to the focus areas in your **compass** rather than to whatever is nearest in its history; important findings (new sourced facts only) reach you at discovery time via push. `/autonomy` in chat — or the Web UI dashboard — shows the agenda, live traits, self-observations, and anything awaiting your approval. |
| **MCP, plugins & BYOM** | Mount any MCP server (Playwright gives it a full browser), load sandboxed plugins, add vision on a dedicated multimodal endpoint if your main model isn't multimodal, and point it at any Anthropic- or OpenAI-compatible model with a config change. |

---

## Compass — you say where it points

An agent with drives of its own needs a direction that is **yours**, not one it drifted into. `compass.md` — a plain file in the repo root, created for you on first start and never touched by `git pull` — is where you write it. Others use a `soul.md` to give the *agent* a persona; a compass is the opposite direction of authorship: it is the **owner's declaration of where their second mind should point**.

```markdown
---
curiosity: 0.60 [0.40, 0.80]
competitiveness: 0.50 [0.30, 0.65]      # capped: the drive to win must never buy a fabricated result
conscientiousness: 0.70 [0.55, 0.90]

focus: 8 active philont itself           # active = pursue and advance it
focus: 7 survey the field I work in      # survey = track and summarize only, never try to "solve"
---

# Who you are to me
You are my second mind — not a tool, not a pretend-genius…
```

Three things happen with it, and none of them is a prompt suggestion:

- **The bracket is a leash, not a hint.** Philont's traits self-tune from how its own work actually goes ([live traits](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Selfhood-Engineering)); the compass **clamps** that tuning inside your range. Competitiveness can climb — but never past the cap into a fabricated win. You set the leash; the agent adapts inside it.
- **Focus areas seed what it pursues.** They become real pursuit rows, which is what both self-drive channels actually read: the in-turn drives during your work, and the overnight autonomous loop. A `survey` focus is tracked and summarized, never attacked. Edit a focus out and its pursuit is archived; the file stays the source of truth.
- **Your prose reaches the model verbatim.** Values, working style, and red lines are injected as *your voice* — the top-of-stack input to the constitution and trait machinery Philont already runs on.

No compass = neutral defaults: unbounded auto-tuning and no declared focus. Full grammar and behaviour: [`compass.example.md`](compass.example.md) · [wiki → Compass](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Compass).

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
| `AUX_LLM_BASE_URL` / `AUX_LLM_API_KEY` / `AUX_LLM_MODEL` | — | The **second opinion**: the model that reviews plans, classifies intent, and judges learning. A small/cheap one is fine — *different* matters more than *bigger*. Unset, other aux jobs fall back to the main model, but the plan **reviewer does not exist** and VERIFY degrades to the deterministic check alone. |
| `PHILONT_COMPASS_PATH` | `<repo>/compass.md` | Where your [compass](#compass--you-say-where-it-points) lives (auto-created from `compass.example.md` on first start). |
| `AGENT_LANGUAGE` | `auto` | `zh` \| `en` \| `auto`. A declaration outranks inference — and it is the only source on a turn with no user message (a proactive push). |
| `PHILONT_SPEC_COMPILE` | **off** | Let the model compile a service guide into an authoritative contract. Off by default — see [Guards a service can't provide itself](#what-it-does). |
| `PHILONT_LEARNING_JUDGE` | on (shadow) | The learning judge scores each turn's success; today it logs and drives nothing. |
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

**Roadmap (selected):** self-learning Phase 2 — crystallizing skills from judge-verified successes — gated on the shadow judge proving trustworthy in real logs first · compass Phase 2 (an observed durable interest proposes a focus area, you ratify it) · write-capable autonomous actions behind stricter budget + audit · npm / Docker publishing.

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
