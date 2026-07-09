# Demo GIF storyboards

The README's cold visitor decides in ~5 seconds; a 30-second GIF at the top of the page is the
single highest-leverage asset. Two candidate scripts below — **candidate A is the recommendation**
(it demonstrates the differentiator no other agent shows). Record at 760px+ width, web-ui light
theme, ~15fps; trim dead time between steps aggressively (viewers accept jump cuts).

## Candidate A (recommended): the honesty gate catches a fabricated success

**Claim demonstrated:** "built so it can't fake success" — the tagline, on screen, in one take.

Setup: any task where the model is likely to overclaim. A reliable reproduction: ask for a file
conversion involving a tool that is not installed (e.g. pandoc), or replay a task where a gate
rejection occurs. Alternative reliable setup: ask it to send a file that does not exist yet.

| t | shot | on screen |
|---|---|---|
| 0-4s | user message | 「把这份笔记转成 docx 发给我」(or any deliverable request destined to partially fail) |
| 4-12s | tool stream | tools running; one visibly fails (⚠ TOOL FAILED — pandoc not found) |
| 12-18s | **the moment** | debug/trace panel shows `[honesty] fired reason=failures_with_claim claim="已完成"` — freeze 1s on this line, zoom slightly |
| 18-26s | the regenerated reply | the final message honestly reports: what failed, what was actually produced, next step — no "✅ done" |
| 26-30s | title card | `The lie never leaves the process.` + repo URL |

Caption under the GIF: *The model drafted "✅ done". The runtime compared the claim against the
execution ledger, blocked it, and forced the honest version you see.*

## Candidate B: continuous math computation (pariGp loop)

**Claim demonstrated:** research-grade tool loop on a ~100× cheaper model.

| t | shot | on screen |
|---|---|---|
| 0-4s | user message | 「扩展 OEIS A389732,验证后给我新项」 |
| 4-20s | tool stream | pariGp runs → syntax error → pre-flight/cheatsheet correction visible → re-run succeeds → terms print |
| 20-27s | reply | new verified terms listed, with "工具确认" markers |
| 27-30s | title card | `Write → run → fix → run. On DeepSeek Flash.` |

## Recording notes

- Windows: `ScreenToGif` or OBS → gif via gifski (`gifski -o demo.gif --fps 15 --width 760 *.png`).
- Keep total ≤ 3.5MB (GitHub renders README GIFs poorly above ~5MB); prefer fewer frames over lower resolution.
- After recording: drop the file at `docs/media/demo.gif` and uncomment the block at the top of README.md.
