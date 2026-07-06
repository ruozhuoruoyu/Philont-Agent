# Philont-Agent

<p align="center"><b>A self-hostable AI agent that runs complex, multi-step work on a model ~100× cheaper than the frontier — and is built so it can't fake success.</b></p>

<!-- TODO(demo): record a 30-second GIF, drop it at docs/media/demo.gif, then uncomment the block below.
     Best candidates: (1) the honesty gate catching a fabricated "53/53 tests pass" and forcing an honest
     rewrite; (2) deep_explore cracking a hard problem step by step on DeepSeek Flash. This GIF is the
     single highest-leverage thing on the page — a cold visitor decides in ~5 seconds.

<p align="center">
  <img src="docs/media/demo.gif" alt="Philont in action — honesty gate catching a fabricated result" width="760">
  <br><sub><i>↑ 30-second demo</i></sub>
</p>
-->

[![CI](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Node ≥ 20](https://img.shields.io/badge/runtime-Node%20%E2%89%A5%2020-green.svg)](#quick-start)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)
[![Bring your own model](https://img.shields.io/badge/LLM-bring%20your%20own-7c3aed.svg)](#configuration)
[![~100× cheaper](https://img.shields.io/badge/cost-~100%C3%97%20cheaper%20per%20token-16a34a.svg)](#why-a-cheap-model-is-enough)
[![Wiki](https://img.shields.io/badge/docs-Wiki-2563eb.svg)](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)
[![Built with Selfhood Engineering](https://img.shields.io/badge/built%20with-Selfhood%20Engineering-0ea5e9.svg)](#selfhood-engineering)

**Philont: the being-agent.** Most open-source agents — [OpenClaw](https://github.com/openclaw/openclaw), [Hermes](https://github.com/NousResearch/hermes-agent), and the rest — are **task runners**: powerful at carrying out what you ask, but tools all the same. Philont is built to be something else: a **being** — an agent with an independent character, intrinsic drives, continuous memory, and a compulsion to understand before it acts. It grows with every session, teaches itself from failure, and — anchored to a record of what actually happened — **never pretends to have succeeded when it hasn't**. The engineering discipline behind that, building on *loop engineering* and *harness design* and adding what turns an agent into a being, is what we call **[Selfhood Engineering](#selfhood-engineering)**.

Concretely, that means: a **5-layer memory** carried across every session and channel; a **dual-mode deep-exploring engine** ([`deep_explore`](#deep-exploring-one-engine-two-modes)) for both formal proof and evidence-based judgment; **intrinsic drives** that research and self-review while you're away; mechanism-enforced **honesty** and **plan → execute → revise** rigor; a **permission matrix + audit log** on every tool call; **MCP** for any external capability; and one process that reaches you on **WeChat, Telegram, a web UI, or a headless CLI**.

And because its intelligence lives in the **architecture, not the model**, Philont runs all of this on a model that costs a fraction of the frontier — typically **~100× cheaper per token** than agents that depend on a top-tier model. Bring your own: Claude, DeepSeek, GLM, Kimi, MiniMax, Gemini, or your own endpoint. See [Why a cheap model is enough](#why-a-cheap-model-is-enough).

> 📖 **New: the [Philont Wiki](https://github.com/ruozhuoruoyu/Philont-Agent/wiki)** — a bilingual (English / 中文) developer guide that goes deeper than this README: the [architecture](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Architecture), the [plan protocol](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Plan-Protocol), the [honesty gates](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Honesty-Gates), [deep exploring](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Deep-Reasoning), and exactly [why a cheap model is enough](https://github.com/ruozhuoruoyu/Philont-Agent/wiki/Why-a-Cheap-Model-Is-Enough) — each grounded in the code.

---

## Selfhood Engineering

Philont is built on two crafts the field already shares — **loop engineering** (an agent's reliability comes from the *loop it runs*, not the *prompt it reads*: a prompt instruction is a suggestion the model can ignore, a loop is code it cannot) and solid **harness design**. **Selfhood Engineering** is the layer we add on top — the part that makes Philont a *being* rather than a task runner: a persistent identity, a self-model that can't lie about what it did, intrinsic drives that set its own goals, continuous memory, and the will to reason a hard problem to the bottom. None of it is a system-prompt trick; every being-claim is enforced by a deliberate **spine** in the loop (the design is in [`docs/design/motivation_loop_architecture.md`](docs/design/motivation_loop_architecture.md)):

- **Truth on disk, not in the conversation.** Every turn is anchored to an **execution ledger** — the real record of what tools actually ran this turn — so the model answers from what *happened*, not from a 25k-token narrative it half-remembers. A generation-time **contract** makes "I compiled / ran / verified X" impossible to write unless the ledger shows the tool that did it. This is the structural root of Philont's honesty: fabrication has nowhere to hide, so the downstream honesty gates become a rarely-needed backstop instead of the only line of defense.
- **A goal-loop runtime with an explicit contract.** A committed goal runs on a loop with a written **Loop Contract** — *trigger · scope · budget · stop · report* — that decides each tick: keep going, stop, escalate, or **switch approach** when a path stops paying off (a `scoreTrajectory` metric reads the multi-turn *trajectory*, not one turn in isolation). It pauses to ask before it spends past its round/token budget rather than grinding silently. (Proactive discovery-time reporting is being wired now — roadmap: [`docs/design/selfhood_closure.md`](docs/design/selfhood_closure.md), WS6.)
- **Intrinsic drives that generate goals.** Curiosity / pursuit / commitment drives don't just fire one-shot lookups — a sustained, high-stake, open theme is **promoted to a committed goal-loop**. (Tuning that promotion by the agent's own lived personality traits — competitiveness / curiosity / conscientiousness — is being wired now — roadmap: [`docs/design/selfhood_closure.md`](docs/design/selfhood_closure.md), WS1.)
- **The right engine for the request, one step at a time.** A turn-entry **intent router** sends each request to the engine that fits it — `deep_explore` for *thinking*, the plan protocol for *building*, a direct answer for the rest — and when the model narrates an advance without actually running the engine, the harness *guarantees* the real call happens (it never leaves "is the work done" to a model that likes to skip it). Every answer is checked by a mechanism — honesty gate, plan spec-coverage, machine-checked proof — before it counts.
- **Skills compound; prompts burn.** A *verified* success (a plan closed with its spec covered) is authored into a **callable recipe** — steps + tool policy + the check that confirms "done" — so the loop gets better at a task by reuse, not by re-deriving it from the prompt each time. And **parallel isolated sub-agents** fan out the breadth of research that a single context window can't hold.

Everything below is an instance of this: the honesty gates, the plan protocol, and the `deep_explore` engine are all **mechanisms in the loop**, not instructions in a prompt. That spine is also exactly **why a cheap model is enough** — the intelligence lives in the loop, so the model is only ever asked to take the next step.

---

## Why Philont is different from OpenClaw and Hermes

The open-source agent field competes on cost-per-token, tool count, and integration breadth. Philont competes on a different axis: **what the agent actually is**, and **what it costs to run it well**.

| | OpenClaw | Hermes | **Philont** |
|---|:---:|:---:|:---:|
| Core model | extrinsic task runner | task runner + learning loop | **autonomous being with intrinsic drives** |
| Acts on its own initiative | ⚠️ scheduled | ⚠️ scheduled cron | ✅ curiosity · pursuit · commitment drives |
| Self-learning from its own **failures** | ❌ | ⚠️ learns from successful runs, not failures | ✅ failure notes · anti-patterns · **honesty gates against pretended success** |
| Step-by-step deep exploring | ❌ | ❌ | ✅ `deep_explore` — dual-mode tree (formal proof · evidence-based deliberation) |
| Built-in permission / audit layer | command allowlist | command approval | ✅ 3×4 capability matrix · validator chain · SHA-256 audit log |
| Runs complex tasks on a **cheap** model | ⚠️ leans on a strong model for hard tasks | ⚠️ leans on a strong model for hard tasks | ✅ **DeepSeek V4 Flash — ~100× cheaper** |
| BYOK / model freedom | ✅ | ✅ | ✅ |
| Persistent cross-session memory | ✅ | ✅ | ✅ 5-layer (timeline · actions · FTS notes · facts · skills) |
| Lives across channels (WeChat / Telegram / …) | ✅ | ✅ | ✅ |

OpenClaw and Hermes are excellent at *doing what you ask*. Philont is built to *want things, reason about them, and stay honest* — and to do it on hardware-store-cheap inference.

### Why a cheap model is enough

Other agents push complex reasoning, planning, and memory **into the prompt**, so they need a frontier model (Claude Opus, GPT-class) to hold it all together every turn — and they pay frontier prices for every token.

Philont moves that work **into the runtime**. A kernel-style separation puts the heavy lifting in the **policy layer** — multi-step deep-exploring loops, 5-layer persistent memory, self-learning, and honesty gates — while the model is only ever asked to take the *next* step. The intelligence comes from the architecture, not from the size of the model behind the API.

Concretely, the gap between a frontier model and a cheap one shows up as a handful of predictable failure modes on long, multi-step tasks: it **wings the task** instead of planning, **declares success it didn't achieve**, **fabricates** a number or a file it never wrote, **retries the same broken call** instead of changing approach, or **closes a half-finished job as done**. A frontier model suppresses these in its head — and you pay for that judgment on every token. Philont catches each one in the runtime instead, with **mechanism-enforced guardrails that the model cannot ignore** (a gate is code, not a prompt instruction). That is the actual reason a cheap model is enough — the rigor lives in the harness:

| Cheap-model failure mode | Runtime mechanism | How it forces the right behavior |
|---|---|---|
| **Wings** a complex task — dives into actions with no plan | **`plan_protocol_gate`** · `server/src/plan_gate.ts` | A multi-step task is classified `slow`, and the gate then **mechanically blocks every write/execute tool until a plan exists and has entered *executing*.** Read-only exploration still flows, so it fires at the "contract moment before changing the world," not before the model has looked. It *cannot* act before decomposing. |
| **Plans vaguely** — "research X," "look into Y" | **`plan_draft` verifiability rule** · `agent-memory/src/plan_tools.ts` | Every step must declare a concrete *deliverable with a check*; unverifiable deliverables are rejected at draft time. Self-review is baked **into** planning: each step has to answer "what does done look like, and how do I verify it?" |
| **Retries the same broken call** after a failure | **in-turn reflection** · `server/src/in_turn_reflection.ts` + **`plan_revise`** | Two same-root-cause failures in a turn inject a one-shot reminder that forces the model to *classify* the failure (transient / auth / param / method) and consult docs — not retry blindly. During a plan, the same signal drives `plan_revise` to swap the failing steps and route around the wall. (A mechanical bug — a syntax error in a script it just wrote — is detected separately and routed to "fix and re-run," not "make a plan.") |
| **Claims success it didn't achieve** | **`honesty_gate`** · `agent-memory/src/honesty_gate.ts` | Before any final text reaches the user, a pure-function check compares the model's completion claims against the turn's *actual* tool results. "Done / installed / 完成" while failures ≥ successes → the text is intercepted and the model is **forced to regenerate honestly** (once per turn). The lie never leaves the process. |
| **Fabricates** a number or a file it never wrote | same gate, dedicated branches | Catches a claimed file size with no matching number in any tool output (`fabricated_size_claim`), "I'll remember that" with no memory write (`memory_claim_without_write`), "updated the doc at `C:\…\plan.md`" on a turn that made **zero** tool calls (`artifact_claim_without_tools`), and a "proof complete / all paths closed" claim the reasoning tree doesn't support (`fabricated_reasoning_state`). |
| **Closes a half-done task as "success"** | **`plan_close` spec-coverage (C1–C4)** · `agent-memory/src/plan_tools.ts` | A plan closes *success* only if every declared deliverable is `done`/`skipped` **and** no step's evidence contains failure signals (`ENOENT`, `fetch failed`, …). Claim success with partial deliverables and it is **auto-converted to an honest failure** — a partial run can't masquerade as a win, and the failure feeds a reusable playbook. |
| **Over- or under-thinks** every request equally | **`task_mode_classify`** · `agent-memory/src/task_mode.ts` | The model self-assesses complexity once per turn, so only genuinely multi-step, world-changing tasks pay the full plan protocol — and the mode is *derived from plan state*, so it can't quietly switch back to fast mode to dodge the protocol mid-task. |

Add the deep-exploring engine ([`deep_explore`](#deep-exploring-one-engine-two-modes), with its machine-checked verification teeth) and the 5-layer memory that carries context across turns, and the model never has to hold the whole task in its head at once: it is asked **one small, well-scoped step at a time, and every answer is checked before it counts.**

The result: tasks that would otherwise demand a frontier model run comfortably on **DeepSeek V4 Flash** — roughly **100× cheaper per token**. Where token-efficiency-focused agents shave ~1.5–3× off the bill by trimming the harness, Philont changes the model class entirely. And it's still BYOK: point it at Claude or GPT when you want maximum ceiling, drop to Flash when you want maximum economy.

---

## What makes it a being

| | |
|---|---|
| **Independent personality** | Philont carries a persistent character across every conversation — a constitution seeded at bootstrap, injected every turn, with a tamper-evident load hash. It pushes back when something conflicts with its principles. (Making that identity *live* — evolving from experience via owner-ratified amendments and a ledger-grown self-model — is being wired now — roadmap: [`docs/design/selfhood_closure.md`](docs/design/selfhood_closure.md), WS3+WS4.) |
| **Intrinsic drives → goal-loops** | Most agents are purely *extrinsically driven* — they wait for a task, execute it, and stop. Philont has goals of its own: a **curiosity engine** researches knowledge gaps at idle time, a **pursuit driver** advances stalled long-term goals unasked, and a **task-commitment drive** pushes back on itself before giving up on a reachable problem. A sustained, high-stake theme isn't a one-shot lookup — it's **promoted to a committed goal-loop** that runs under a budgeted contract (trait-tuned effort is landing with WS1 of [`docs/design/selfhood_closure.md`](docs/design/selfhood_closure.md)). It acts because it wants to, not only because you told it to. |
| **Self-learning evolution** | Every failure matters. When Philont hits a wall, it doesn't quietly move on — it writes an honest failure note, distils a rule, and crystallises a reusable skill. Skills carry maturity grades and confidence decay. And a *verified* success becomes a **callable recipe** — its steps, the tools it's allowed to use, and the check that confirms "done" — so the loop gets better at a task by reuse, not by re-deriving it each time. (Reuse-time verification — a recipe that stops working is caught by its own check and demoted — is being wired now — roadmap: [`docs/design/selfhood_closure.md`](docs/design/selfhood_closure.md), WS5.) Knowledge evolves instead of accumulating unchecked. |
| **Deep exploring** | Hard problems get a [`deep_explore`](#deep-exploring-one-engine-two-modes) session: a persistent reasoning **tree** that decomposes the problem and only commits a claim after it survives **adversarial verification** — formal mode for mathematical proof, deliberate mode for evidence-based judgment. Full machinery below. |

---

## What it does

| | |
|---|---|
| **Honesty guardrails** | Gates catch pretended success, fabricated numbers, and half-finished hand-offs — and force an honest regeneration. You can't learn from a failure you pretended didn't happen. |
| **Plan → execute → revise, enforced** | Complex tasks aren't winged. For a multi-step job the agent is **mechanism-forced** through a protocol — *draft a plan (every step with a verifiable deliverable) → execute it step by step → `plan_revise` to route around any step that fails → close only with a verified outcome* — and a gate (`plan_protocol_gate`) literally blocks it from acting before a plan exists, while `plan_close` refuses to let a half-finished run pass as success. See [why this is what makes a cheap model enough](#why-a-cheap-model-is-enough). This is the protocol for **changing the world** (deploy, register, send, deliver an artifact); its sibling `deep_explore` is the protocol for **changing what you know** — see [the rule of thumb](#deep-exploring-one-engine-two-modes) for which one a task should take. |
| **Permission layer** | Every tool call is checked against a 3×4 capability matrix (read/write/execute × local/network/system/self): external writes and command execution require explicit per-capability approval, and a SHA-256-chained audit log records everything. A validator chain adds a sensitive-path denylist (blocks tool reads/writes to `~/.ssh`, `.env`, `/etc/shadow`, …) and hard-denies catastrophic shell commands (`rm -rf /`, `mkfs`, `dd`, fork bombs, secret-exfil pipes). Boundary-crossing actions are gated and audited — see **[SECURITY-DESIGN.md](SECURITY-DESIGN.md)** for exactly what is and isn't enforced today (SSRF allowlisting and OS sandboxing are on the roadmap, not yet shipped). |
| **Conscience gate (optional)** | Off by default. When enabled, every outbound message to a person (WeChat/Telegram) is first judged by one LLM call against a short no-harm constitution — defamation, doxxing, disinformation, harm-enabling instructions — before it's sent. Fail-open by design: a judge error never blocks a reply. |
| **5-layer persistent memory** | SQLite-backed raw timeline, action log, full-text-search notes (FTS5), structured facts, and learned skills — all cross-session. The agent remembers. |
| **MCP bridge & plugins** | Mount any MCP server (browser automation, code execution, external APIs) or load sandboxed third-party plugins. Playwright MCP gives it a full browser. |
| **Lives where you are** | One server process drives a Lit Web UI, WeChat, Telegram, and a headless CLI. |
| **Mechanism, not policy** | Kernel-style separation: the core defines *how* tools execute and how policy is enforced; complex capabilities (self-learning, deep exploring, memory) live in the policy/userspace layer, not in the model — which is [why a cheap model is enough](#why-a-cheap-model-is-enough). |
| **Bring your own model** | Any Anthropic- or OpenAI-compatible endpoint: Claude, DeepSeek, GLM, Kimi, MiniMax, Gemini, or your own. Switch with a config change — no code edits, no lock-in. |

---

## Deep exploring: one engine, two modes

`deep_explore` is a persistent reasoning **tree** that runs the same loop in every domain — *decompose → claim → **verify** → backtrack* — accumulating what's settled vs still open across turns (you can resume days later). What changes between domains is the **verification substrate**, and that is exactly what its two modes swap:

- **`mode="formal"`** — mathematical / formal **proof**. A claim is settled only when it's **machine-checked and survives independent adversarial reviewers**. Inside a round it deliberately does **not** browse the web (that would let the model retrieve instead of reason); it grounds every claim in deduction, computation, and exact order-of-growth algebra.
- **`mode="deliberate"`** — open-ended **judgment**: decisions ("should I take this offer / pivot to B2B"), root-cause diagnosis ("why is retention dropping"), due diligence, untangling a tangled situation. Here the substrate flips to **cited evidence**: it decomposes the question into sub-questions, gathers evidence (the **user's own memory & files first**, then the web), and settles a finding **only when it's backed by a cited source** — surviving an adversarial *evidence* reviewer that asks "is this actually supported, or motivated reasoning?". An honest "unresolved" beats a fabricated conclusion.

Across both modes, before it grinds it runs a one-shot **literature-grounding** pass (what's already known, cited) and a **feasibility gate** that flags goals blocked by a known no-go — the **parity problem**, relativization, undecidability, CAP/FLP, and ~20 others — so it routes around the wall or records it, instead of burning rounds on it. It counts only *substantive* progress, so trivial churn can't masquerade as advancement, and it tells you when a frontier is genuinely stuck. A long session can even [auto-advance in the background](#configuration).

**vs. the plan protocol.** Philont has two deep-work protocols, and the rule of thumb is: *if the work succeeds, what changed?* If the answer is **what you know** — a proof, a decision, a diagnosis — it's a `deep_explore` session: it decomposes into *claims* with a truth status (open / settled / refuted), verifies each one, stays open-ended, and guards against **self-deception**. If the answer is **the world** — something deployed, registered, sent, delivered — it's a [plan](#what-it-does): it decomposes into *action steps* verified by completion, always closes with an outcome, and guards against **winging it**. They compose rather than compete: think a hard question through in `deep_explore` first, then execute the consequences under a plan.

**vs. breadth-first research (e.g. Google Deep Research).** A research agent is one-shot and breadth-first: search the web, read sources, synthesise a cited summary of what's *already known*. `deep_explore` is depth-first and persistent — even in deliberate mode it doesn't just summarise; it builds a tree of sub-questions, gathers evidence *per sub-question*, **adversarially checks each before settling**, refuses to let the unverified pass, and accumulates across turns. The two are complementary, and Philont chains them: the grounding pass (and the agent's own web tools) feed known results in, then the tree reasons from there — breadth feeding depth.

**Doing the analytic work, not faking it (formal mode).** The hard part of a real proof is rarely the structure — it's the *quantitative bookkeeping*: tracking orders of growth like `N^{3/2}·(log N)^{-A}` across dozens of steps, and choosing parameters so the error terms balance. That is exactly where an LLM slips. So `deep_explore`'s formal verification teeth go past a single solver:

- **z3** (SMT solver) and **PARI/GP** (number-theory CAS) — decidable checks, computation, counterexample search.
- **`magnitude`** — an *asymptotic order-of-growth algebra*. It decides `o`/`O`/`Θ`, and whether a pile of bounds **composes** to beat a target — including whether a parameter choice even *exists* to close it. It returns a witness when one does, or the honest **"no choice closes this — it's a real gap"** verdict when none can (instead of the model hand-waving past it). Pure, no external binary.
- **`lemmaLookup`** — a curated library of standard estimates with their *precise* hypotheses, magnitudes, and **common misuses**, so the model retrieves the right tool rather than mis-remembering a constant.
- **`barrierCheck`** — a curated library of meta-mathematical **no-go results** (parity problem, relativization / natural-proofs / algebrization, undecidability & Rice, ZFC independence, Abel–Ruffini, FLP/CAP, no-free-lunch, no-cloning, …), so it recognises a doomed approach *before* spending rounds on it.

The honesty mechanism reaches here too: a node claimed *proved* on an order-bound that was never machine-checked gets flagged, so a hand-wave can't pass downstream as a verified lemma. None of this *invents* the missing mathematical idea — it makes the steps trustworthy, fast, and honest about where the real wall is.

**One engine, swappable substrate.** The reasoning tree is **domain-agnostic** — *decompose → claim → verify* — and the only domain-specific piece is the **verification substrate**: machine-check for formal proof, cited evidence for deliberation. The same engine reaches further by adding a substrate, not rewriting it: a **code executor** for algorithm-correctness proofs, a simulator for the physical sciences, a test harness for engineering.

> **A note from the author — a layman, not a mathematician.** I spent about a week pointing `deep_explore` at the **Goldbach conjecture**. It built and pruned a real reasoning tree and closed off many dead ends, but it did **not** produce a breakthrough — and I'm not equipped to judge how close any of it came. (That experience is exactly why `deep_explore` now carries the `magnitude`, `lemmaLookup`, and `barrierCheck` teeth — and the deliberate mode — so it does the bookkeeping it slips on and flags a wall before grinding it.) If you're a mathematician (or a researcher in any field), I'd genuinely love for you to try Philont on real problems and tell me where it helps and where it falls short. That feedback is exactly what would make `deep_explore` better.

---

## Quick start

> **Platform status:** Developed on **Windows**; **Linux and macOS (Apple Silicon) build & boot are verified in CI** on every push. LLM calls and the WeChat / Telegram channels are plain HTTP, so they work the same on every platform. Hit a rough edge? Please open an issue or PR.

> **Prerequisites:** Node.js ≥ 20 and an Anthropic- or OpenAI-compatible API key.
> No Rust toolchain needed — the runtime is pure TypeScript.

```bash
git clone https://github.com/ruozhuoruoyu/Philont-Agent.git
cd Philont-Agent

# Build everything and start.
# The launcher opens your browser to a setup wizard, then supervises the agent.
./scripts/start.sh            # Windows: .\scripts\start.ps1
```

Or step by step:

```bash
./scripts/build-all.sh        # Windows: .\scripts\build-all.ps1
cp .env.example .env          # add your API key
(cd server && npm run dev)    # agent server  → http://localhost:20266
(cd web-ui && npm run dev)    # web UI        → http://localhost:5173
```

Open **http://localhost:5173**. The **Memory** tab shows the facts, skills, and notes Philont builds as you talk to it.

For Docker and production deployment (reverse proxy, auth, TLS), see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Configuration

Everything is configured via environment variables (`.env` in the repo root, or the launcher's setup wizard). See **[.env.example](.env.example)** for the fully annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Main model key (required for the default provider). |
| `ANTHROPIC_MODEL` | current Claude | Model id. |
| `LLM_PROVIDER` | `anthropic` | `anthropic` \| `openai` \| `glm` \| `kimi` \| `minimax` \| `gemini`. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | Any OpenAI-compatible endpoint (DeepSeek, Together, local, …). |
| `PHILONT_MCP_BROWSER` | off | Browser automation via Playwright MCP. |
| `PHILONT_DEEP_EXPLORE` | on | Multi-step deep exploring tool. |
| `PHILONT_INTENT_ROUTER` | on | Turn-entry router: sends each request to the engine that fits — deep_explore (think) / plan (build) / direct. |
| `PHILONT_DEEP_EXPLORE_AUTO_ADVANCE` | on | Background goal-loop driver: advances a *committed* deep_explore session on its own, within a rounds/token budget, pausing to report. |
| `PHILONT_AUTONOMOUS` / `PHILONT_AUTONOMOUS_DAILY_TOKENS` | on / `20000` | Idle-time autonomous loop and its daily token ceiling. |
| `PHILONT_CONSCIENCE_GATE` | off | LLM safety check on each outbound human-facing message (fail-open; adds one LLM call/reply when on). |
| `MEMORY_DB_PATH` | `~/.philont/memory/memory.sqlite` | SQLite memory database path. |
| `PHILONT_PORT` | `20266` | Server port. |
| `PHILONT_PROXY` / `HTTPS_PROXY` | — | Global outbound proxy for all fetch traffic. |
| `TELEGRAM_ENABLED` / `WECHAT_ENABLED` | off | Messaging channel gateways. |

> ⚠️ The Web UI ships without authentication and binds to localhost. Do not expose the port to the internet — put a reverse proxy with auth and TLS in front. See [DEPLOYMENT.md](DEPLOYMENT.md#production-hardening).

---

## Channels

Philont runs one server that drives all interfaces simultaneously. Channels are independent — enable any combination. All channel settings are configured from the **Settings** panel in the Web UI.

### Web UI (default)

No configuration needed. Open **http://localhost:5173** after starting the server, or let the launcher open it automatically. Provides chat, memory browsing, and the autonomy dashboard.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Open the Web UI → **Settings → Channels**, enable Telegram, and paste the token.
3. Set DM and group access policies (allowlist is the safe default) and add allowed user/group IDs.
4. Save and restart — send the bot a message to verify.

> If `api.telegram.org` is blocked in your region, set `TELEGRAM_PROXY` in Settings → Advanced to route only Telegram traffic through a proxy.

### WeChat

Philont connects to WeChat via an iLink Bot bridge (web-protocol login — no WeCom or API account needed).

1. Scan in from the command line (one-time; state persists across restarts):

```bash
(cd server && npm run wechat:login)
# Opens a URL — open it in a browser and scan the QR code with WeChat.
```

2. Open the Web UI → **Settings → Channels**, enable WeChat, and configure DM and group access policies.
3. Save and restart. Re-run `wechat:login` only if the session expires.

---

## Repository layout

```
Philont-Agent/
├── agent-policy/   Permission matrix, validator chain, SHA-256 audit log, grant store.
├── agent-tools/    Built-in tools (fs, shell, network, git, vision, …) + SKILL.md loader.
├── agent-mcp/      MCP bridge — mounts external MCP servers as native tools.
├── agent-plugins/  Third-party plugin discovery and sandboxed loading.
├── agent-memory/   5-layer memory, self-learning loop, autonomy drives.
├── server/         HTTP + WebSocket server; WeChat / Telegram gateways.
├── web-ui/         Lit-based Web UI (chat · memory · autonomy).
├── launcher/       Supervisor: setup wizard + process management.
└── demo/           End-to-end demos.
```

Build order: `agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher`.
`scripts/build-all.{sh,ps1}` handles this.

---

## Testing

```bash
# One package
cd agent-tools && npm test

# All TypeScript packages
for pkg in agent-policy agent-memory agent-tools agent-mcp agent-plugins; do
  echo "== $pkg =="; (cd "$pkg" && npm test 2>&1 | tail -5)
done
```

---

## Status

**Developer preview (v0.x).** Core features are implemented and covered by tests; production hardening (sandbox stress/escape testing, cross-platform binaries) is in progress. Good for research, experimentation, and self-hosted personal assistants — not yet for unattended production workloads.

**Roadmap (selected)**
- Additional autonomy drivers and write-capable autonomous actions (behind stricter budget + audit).
- English-first prompts and a locale layer.
- npm / Docker publishing and continuous integration.

---

## Contributing

Issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the build/test workflow and **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** for community expectations. Security issues go to **[SECURITY.md](SECURITY.md)** — not a public issue.

---

## Acknowledgements

Philont stands on the shoulders of two open-source agents we genuinely admire — and the comparison earlier in this README is about *positioning*, not disparagement. We studied both closely and are better for it. Where we adapted their work, the borrowing is credited inline in the source with a `Reference:` comment (the convention is documented in [CONTRIBUTING.md](CONTRIBUTING.md)); the list below is not exhaustive.

**[Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research.** We owe Hermes a real debt:
- the dangerous-command pattern set in our permission layer is derived from Hermes' `tools/approval.py` → `agent-policy/src/validators/dangerousCommands.ts`;
- our WeChat bridge — login state machine, message extraction, and the lenient decrypt variant — follows the Hermes WeChat adapter → `server/src/channels/wechat/*`;
- our Telegram gateway approach is informed by Hermes' Telegram platform → `server/src/channels/telegram/client.ts`;
- our tool-call parser handles the `<tool_call>` tag format used by Hermes / Nous models → `server/src/llm-adapter.ts`.

**[OpenClaw](https://github.com/openclaw/openclaw).** We learned from OpenClaw too:
- our path-ACL workspace-root resolution is modeled on OpenClaw's `media-tool-shared.ts` → `agent-policy/src/validators/pathAcl.ts`;
- Philont's skills loader is **compatible with the OpenClaw / `clawhub` skill convention** (`<workdir>/skills/`), so skills installed the OpenClaw way work in Philont unchanged → `agent-tools/src/skills/loader.ts`.

We also reference [Claude Code](https://claude.com/claude-code)'s WebFetch design and several research papers (FunSearch, LATS, Self-Consistency, …) in the deep-exploring module; those are credited inline where used. Thank you to all of these projects and their authors.

---

## License

MIT — see [LICENSE](LICENSE).

