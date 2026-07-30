/**
 * OutputFormatGate — detects when LLM final text is very long but does not use the `## 给用户` section format.
 *
 * Trigger scenario: LLM makes many tool calls then outputs 5000+ character text without sections
 * (no `## 给用户` heading); wechat output_filter fallback can only push the full text → user sees verbose, unfocused output.
 *
 * Analogous to EmptyConclusionGate (handles "did a lot but said nothing"), OutputFormatGate handles
 * "did a lot, said a lot, but no sections".
 *
 * Callers (chat-handler) that receive shouldRegenerate=true should:
 *   - Log to audit (`output_format_gate_fired`)
 *   - Inject a reminder message asking the LLM to rewrite using `## 给用户` + `## 工作日志` two-section format
 *   - Call LLM again once, cap=1 per turn
 *
 * Design invariants:
 *   - Pure synchronous function, no IO
 *   - Conservative threshold: finalText > 500 chars + no /## 给用户/ → trigger
 *   - Short replies (< 500 chars) pass through — simple queries don't need two-section format
 *   - Parallel to HonestyGate / EmptyConclusionGate (all three diagnose different problems)
 *
 * The length exemption assumes short reply ⇒ simple query. Production 2026-07-27 15:30:48 showed the
 * assumption is not safe on its own: a turn ran a 6-minute deep_explore round (`refuted 1; +1 dead
 * ends; 10 still open`) and then replied, in full, `你在看什么？你们那边的活动怎么样了…` — 17 characters of
 * small talk, no section, round result discarded, gate silent because 17 < 500. So the exemption is now
 * conditional: when the turn produced REPORTABLE WORK (a completed reasoning round), the `## 给用户`
 * section is required at any length. Length is a proxy for "was this a simple query"; a finished round
 * answers that question directly, so it wins.
 *
 * env switch: PHILONT_OUTPUT_FORMAT_GATE=0 disables the entire gate.
 */

export interface OutputFormatResult {
  shouldRegenerate: boolean;
  reason?: 'long_text_no_user_section' | 'reportable_work_no_user_section';
  detail?: {
    finalTextLength: number;
    hasUserSection: boolean;
    reportableWork?: boolean;
  };
}

export interface OutputFormatInput {
  /** LLM final text for this turn (raw text before trimming) */
  finalText: string;
  /** Threshold: exceeding this length + no ## 给用户 section → trigger. Default 500 */
  minLengthToTrigger?: number;
  /**
   * This turn completed work the user is owed a report on (currently: a deep_explore round returned a
   * round summary). When true the length exemption does not apply — the reply must carry `## 给用户`.
   */
  reportableWork?: boolean;
}

/**
 * The two headings, defined ONCE for the whole system.
 *
 * They were not. This gate matched `/##\s*给用户/` and nothing else, while every producer prompt —
 * the system prompt, the priming assistant turn, max_iter_summary, viability_gate's rewrite
 * instruction, CONTRACT 3/3 — asks for `## For User`, and the WeChat delivery filter accepts BOTH.
 * So the gate fired on replies that were CORRECT: the model wrote exactly the heading it was told to
 * write, the channel found the section and delivered it, and the gate meanwhile declared the section
 * missing and burned a full regeneration. 129 fires in seven days, every one of them a reply that
 * already complied.
 *
 * This is the producer/exact-match-consumer split the repo keeps re-shipping (channel ids, tool names,
 * and now section headings). The i18n pass flipped the prompts to English and moved the delivery filter
 * to bilingual; the gate was the one consumer nobody re-read. The fix is not "add the English heading
 * here" — it is that there is now one definition and both consumers import it.
 */
export const USER_SECTION_HEADING = /^##\s*(?:给用户|For User)\s*$/i;
export const WORK_LOG_HEADING = /^##\s*(?:工作日志|Work Log)\s*$/i;

/**
 * Does the text carry a user section the delivery filter will actually be able to extract?
 *
 * Line-anchored on purpose, and identical to what extractUserSection() uses: this gate's whole job is
 * to predict whether the channel will find a section, so a looser test here would pass replies the
 * channel then falls back on — which is the failure the gate exists to prevent, arriving silently.
 */
export function hasUserSection(text: string): boolean {
  return text.split('\n').some((line) => USER_SECTION_HEADING.test(line));
}

export function evaluateOutputFormat(input: OutputFormatInput): OutputFormatResult {
  const trimmed = input.finalText.trim();
  const minLen = input.minLengthToTrigger ?? 500;
  const sectionPresent = hasUserSection(trimmed);
  const reportableWork = input.reportableWork === true;
  const detail = {
    finalTextLength: trimmed.length,
    hasUserSection: sectionPresent,
    reportableWork,
  };

  // Long text + no user section → trigger
  if (trimmed.length > minLen && !sectionPresent) {
    return {
      shouldRegenerate: true,
      reason: 'long_text_no_user_section',
      detail,
    };
  }

  // Reportable work this turn + no user section → trigger at ANY length. A finished reasoning
  // round that the reply never mentions is work thrown away, whether the reply is 17 chars or 1700.
  if (reportableWork && !sectionPresent) {
    return {
      shouldRegenerate: true,
      reason: 'reportable_work_no_user_section',
      detail,
    };
  }

  return { shouldRegenerate: false, detail };
}
