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
