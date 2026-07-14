# Chinese prompt inventory (Bucket C)

Audited 2026-07-14. This is the **prompt/tool-payload** text still written in Chinese — strings that go
**to the model**, not to the user. It is the remaining input to the "flip the system prompts to English"
decision, which has **not been made yet**. Nothing here is a bug; it is a scope estimate.

Two other categories are deliberately **excluded**, and must not be swept up by a mechanical translation:

- **Matchers (must KEEP Chinese)** — regexes and cue lists that match Chinese text *produced by the model or
  typed by the user*: `phase_gate.ts`, `task_mode_classifier.ts`, `intent_router.ts` (the pattern consts),
  `short_answer_binding.ts:29-32`, `failure_recovery_inject.ts:145-157`, `viability_gate.ts:134-163`.
  Translating these silently breaks the feature they implement.
- **User-facing text (Bucket A)** — separately tracked; must become bilingual, not English.

## Inventory

| File | Chinese lines | What the text is | Notes |
|---|---:|---|---|
| `chat-handler.ts` | 147 | tool descriptions, tool_result payloads, gate/drive injections, plan-protocol error blocks | Largest by far. The plan-gate block (~8842-8885) and the learning-mode / retro-recall injections are the bulk. |
| `headless.ts` | 46 | CLI `HELP` text, arg errors, `DEFAULT_PREAMBLE` | **Operator-facing, not model-facing.** `DEFAULT_PREAMBLE` IS model-facing. Split before acting. |
| `viability_gate.ts` | 28 | directive text injected into the prompt | Mixed: the directives are English but *instruct the model to offer the Chinese word 继续* — an offered-word source. Coupled to Bucket A. |
| `deep_explore.ts` | 19 | tool descriptions + tool_result text | `2963` relays 「回复"继续"」 to the user through the model — coupled to Bucket A. |
| `failure_recovery_inject.ts` | 15 | prompt section "上轮任务失败,本轮调整策略" | Self-contained. |
| `user_pattern_inject.ts` | 14 | prompt section "我观察到的模式" | **Coupled**: the model relays its offered words (学/自动化/不要/跳过) verbatim to the user, and `detectPatternConfirmation` matches them. Card + matcher must move together. |
| `short_answer_binding.ts` | 13 | prompt injection + ask-guard tool_result | Lines 29-32 are a MATCHER — keep. |
| `tools/reply_with_media.ts` | 10 | tool description + params + outputs | Self-contained. |
| `sanitize_tool_input.ts` | 9 | `reason` strings surfaced to the model as tool errors | Self-contained. |
| `reflection_runner.ts` | 8 | reflection prompt | **`372` does `.includes('[已纳入 reflection')` on STORED rows** — translating requires a data migration. |
| `routing_inject.ts` | 5 | "历史经验路由(参考)" prompt section | Self-contained. |

## Order, if this is ever done

1. **Self-contained, zero coupling** (~37 lines): `routing_inject`, `sanitize_tool_input`,
   `reply_with_media`, `failure_recovery_inject`. Safe mechanical translation.
2. **Coupled to offered words** — must be translated *together with* their Bucket-A card and their matcher,
   or the user is handed a word nobody listens for: `user_pattern_inject`, `viability_gate`, `deep_explore`.
3. **`reflection_runner`** — needs a migration for the persisted `[已纳入 reflection` marker.
4. **`chat-handler`** — the bulk. Worth splitting per-section rather than one commit.
5. **`headless`** — decide first whether operator-facing CLI help follows AGENT_LANGUAGE at all.

## The thing to be careful about

The recurring defect all week has been *a word we printed that nobody listened for*. Any translation that
moves an offered word without moving its matcher **manufactures exactly that bug**. The matcher must be
found first, and the two must change in the same commit.
