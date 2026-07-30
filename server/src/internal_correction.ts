/**
 * The one sentence every intra-turn gate directive ends with.
 *
 * There were 23 hand-typed copies of it across six files, and the copies were all subtly too weak in the
 * same way: they said "do not surface this reminder to the user". The model complied with that literally
 * — it did not quote the reminder — and then opened its rewritten reply by AGREEING with it.
 *
 * Production 2026-07-28 15:35:45, delivered to WeChat exactly as written:
 *
 *   "You're right. 让我重写——本轮回合我确实没有运行任何计算工具…"
 *
 * The owner is looking at a reply that agrees with something he never said. Every gate directive is
 * pushed as a `role: 'user'` message, because that is the only slot a mid-turn instruction fits in — so
 * from inside the model there IS a user who just said it, and thanking them is the natural next move.
 * This is the same shape as the 17-character off-topic reply he asked about last week: an internal
 * mechanism leaking into the conversation as a non-sequitur.
 *
 * Not surfacing the reminder was never the requirement. The requirement is that the reply read as though
 * the correction never happened, which is a stronger and more specific instruction — and it belongs in
 * one place, so the next gate cannot be written with a weaker version of it.
 */
export const INTERNAL_CORRECTION_FOOTER =
  'This is an internal mid-turn correction, not a message from the user. Rewrite your reply so it reads ' +
  'as a first draft written correctly: do NOT acknowledge, agree with, apologise for, thank anyone for, ' +
  'or refer to this correction in any way — no "you\'re right", no "let me rewrite", no "抱歉", no ' +
  '"更正". The user never saw it and has no idea what you would be agreeing with.';

/** Same instruction, prefixed with a newline for builders that append it to a paragraph. */
export const INTERNAL_CORRECTION_FOOTER_NL = `\n${INTERNAL_CORRECTION_FOOTER}`;


/**
 * A gate directive is pushed as a `role: 'user'` message — the only slot a mid-turn instruction fits
 * into — and extractRecentToolResults defines the turn boundary as "the most recent user message with
 * STRING content". So the moment ANY gate fires, every later gate in the same turn reads an EMPTY tool
 * ledger.
 *
 * The log shows it plainly (2026-07-30 12:21):
 *
 *   12:21:05  [honesty] passed (8 ok / 2 fail / 10 total)
 *   12:21:05  [output-format] fired            ← pushes a string-content user message
 *   12:21:13  [honesty] passed (0 ok / 0 fail / 0 total)     ← the ledger is now empty
 *   12:21:15  [numeric_grounding] fired: adjudicated computation claim naming [shell]
 *             with 0 successful compute/exec tools
 *
 * That turn ran `tools=10 ok=8 (exec=3)`. The model's rewrite pushed back — "#8 shell DID succeed" — and
 * it was right. A false positive on the fabrication layer, manufactured by an earlier gate.
 *
 * renderTurnLedger's own comment already names this hazard: "a standalone string-content user message
 * would be misread as the turn boundary by extractRecentToolResults() and blind the honesty/numeric
 * gates". The ledger contract was routed into messages[0] to avoid it. The directives never were.
 *
 * So directives carry a zero-width sentinel — our own string, exact-matched on our own slot, invisible
 * in the prompt — and the boundary scan skips them. Marking is deliberately opt-IN: over-marking would
 * pull a PREVIOUS turn's tools into this turn's ledger, which turns a false positive into a false
 * negative on the honesty layer, and that is the worse direction.
 */
export const INTERNAL_DIRECTIVE_MARK = '\u200b\u2060';

/** Tag a mid-turn gate directive so the ledger scan does not mistake it for the user speaking. */
export function markInternalDirective(text: string): string {
  return INTERNAL_DIRECTIVE_MARK + text;
}

/** Is this string one of our own mid-turn directives rather than something the user said? */
export function isInternalDirective(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(INTERNAL_DIRECTIVE_MARK);
}
