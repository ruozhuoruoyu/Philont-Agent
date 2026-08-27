/**
 * Deterministic handling of the deep_explore session-control words WE PRINT (2026-07-14).
 *
 * The follow-up and auto-advance notices hand the owner a closed enum:
 *
 *   「要推进哪个回"继续";要清理某个说"放弃 <它>",或"全清"。」
 *   「⏸ 自动推进已暂停 … 回复"自动推进"再加一批,或"停"。」
 *
 * 放弃 / 全清 / 自动推进 / 停 had NO listener anywhere in the repo — the phrases existed only in the cards
 * that printed them. The verbs they name all exist (setSessionStatus('abandoned'), setAutoAdvance) and are
 * reachable from code; nothing connected them to the words. Same shape as the constitution card and the push
 * off-switch: a valve that was built, and never plumbed.
 *
 * Layer 1 only. These are OUR words, so they are matched exactly — reading back a closed enum is parsing,
 * not intent inference. Open-language versions of the same wish ("那个探索别搞了") are deliberately NOT
 * matched here; they are intent and belong to the model, which has deep_explore(action=abandon). What this
 * guarantees is that the exact words we PRINTED always work, without depending on the model noticing.
 *
 * 继续 is intentionally NOT handled here: it already has a real, tested path (force-continue synthesises a
 * deep_explore(action=continue) call). Adding a second owner of it would be a regression risk for no gain.
 */

export type ExploreControl =
  | { kind: 'abandon'; target: string | null }  // target = null → the current-focus session
  | { kind: 'abandon_all' }
  | { kind: 'auto_advance' }
  | { kind: 'stop_auto' };

/** Match the words the follow-up / auto-advance cards offered, in both languages. */
export function classifyExploreControlReply(userMessage: string): ExploreControl | null {
  const raw = (userMessage ?? '').trim();
  if (!raw) return null;
  const m = raw.toLowerCase().replace(/[。！？，,!?.\s"'「」]+/g, '');

  if (/^(全清|全部清理|全部放弃|全都放弃|clearall|abandonall|dropall)$/.test(m)) {
    return { kind: 'abandon_all' };
  }
  // 自动 is in this list because deep_explore's status line PRINTS it: "auto: off — say 自动 and I
  // run it myself". It was offered and not accepted — the same defect this module was written to
  // remove, one word further down. Whatever a card offers has to appear here.
  if (/^(自动|自动推进|后台推进|继续自动推进|auto|autoadvance|keepgoing)$/.test(m)) {
    return { kind: 'auto_advance' };
  }
  if (/^(停|停止|停下|暂停|别推了|stop|pause)$/.test(m)) {
    return { kind: 'stop_auto' };
  }
  // 「放弃」on its own targets the session we just asked about; 「放弃 <它>」names one.
  const abandon = /^(?:放弃|归档|关掉|abandon|drop|archive)\s*(.*)$/i.exec(raw.trim());
  if (abandon) {
    const target = abandon[1].trim().replace(/^[「"']|[」"']$/g, '');
    return { kind: 'abandon', target: target.length > 0 ? target : null };
  }
  return null;
}

/**
 * Pick the session an 「abandon <name>」 refers to. The owner types a fragment of the goal as it was shown to
 * them (the cards truncate to 50 chars), never an id — so match on the goal text, case-insensitively, and
 * require it to be UNAMBIGUOUS.
 *
 * Ambiguity returns null rather than guessing: silently archiving the WRONG line of reasoning is much worse
 * than asking which one. Same rule as the constitution prefix.
 */
export function resolveExploreTarget<T extends { id: string; goal: string }>(
  sessions: readonly T[],
  target: string | null,
  currentFocus: T | null,
): { session: T } | { ambiguous: T[] } | null {
  if (!target) return currentFocus ? { session: currentFocus } : null;
  const needle = target.toLowerCase();
  const hits = sessions.filter((s) => s.goal.toLowerCase().includes(needle));
  if (hits.length === 1) return { session: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return null;
}
