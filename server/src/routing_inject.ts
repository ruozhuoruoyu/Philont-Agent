/**
 * Routing rule injection into the system prompt
 *
 * At the start of each task (when a user message arrives):
 *   1. Extract keywords from the user message
 *   2. Call routingRules.match(null, keywords) to get the top-K matching rules
 *   3. Render them as a markdown section and inject into messages[0] system slot
 *   4. Injection phrasing varies with confidence (provisional gets "unverified" caveat;
 *      validated is injected directly, etc.)
 *
 * Retired rules are not injected (filtered out inside match). No matches → nothing injected
 * (zero token cost).
 *
 * Average +150 tokens/turn (top-3 × ~50 tokens); extreme case +240.
 */

import type { RoutingRule, RoutingRuleStore } from '@agent/memory';
import { extractKeywords, confidenceCaveat } from '@agent/memory';

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.1; // aligned with store.match default; <= single keyword hit qualifies for injection

export interface RoutingInjectionOptions {
  topK?: number;
  minScore?: number;
}

export interface RoutingInjectionResult {
  /** Text to inject into the system section (empty string = no match; do not inject) */
  text: string;
  /** Number of rules actually matched (for metrics) */
  matched: number;
  /** List of matched rule ids (for metrics / audit) */
  ruleIds: number[];
}

/**
 * Given a user message, return the injection text.
 *
 * @param userMessage Current-turn user natural language message (plain string, not a tool_result)
 * @param routingRules RoutingRuleStore instance
 * @param options Optional topK / minScore
 */
export function buildRoutingInjection(
  userMessage: string,
  routingRules: RoutingRuleStore,
  options: RoutingInjectionOptions = {},
): RoutingInjectionResult {
  const empty: RoutingInjectionResult = { text: '', matched: 0, ruleIds: [] };
  if (!userMessage || typeof userMessage !== 'string') return empty;

  const keywords = extractKeywords(userMessage);
  if (keywords.length === 0) return empty;

  const topK = options.topK ?? DEFAULT_TOP_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  const matches = routingRules.match(null, keywords, {
    limit: topK,
    minScore,
  });

  if (matches.length === 0) return empty;

  return {
    text: renderRulesSection(matches),
    matched: matches.length,
    ruleIds: matches.map((r) => r.id),
  };
}

/**
 * Render the rule list as a markdown section.
 *
 * Single-rule format:
 *   - [confidence_caveat] task_signature: trigger_condition → prefer_skill (avoid: avoid_skills)
 *     · carveout
 *
 * Section heading: `## Historical Routing Hints (reference)`, consistent with K7 injection style.
 */
function renderRulesSection(rules: RoutingRule[]): string {
  const lines = ['', '## Routing hints distilled from past tasks (advisory)'];
  for (const r of rules) {
    const caveat = confidenceCaveat(r.confidence);
    const preferPart = r.preferSkill ? ` → use \`${r.preferSkill}\`` : '';
    const avoidPart =
      r.avoidSkills.length > 0
        ? ` (avoid \`${r.avoidSkills.join('`,`')}\`)`
        : '';
    lines.push(
      `  - ${caveat} **${r.taskSignature}**: ${r.triggerCondition}${preferPart}${avoidPart}`,
    );
    if (r.carveout) {
      lines.push(`    · Does not apply when: ${r.carveout}`);
    }
  }
  lines.push(
    '  (These are your own decisions distilled from earlier tasks. If they clearly do not fit this input, ignore them and judge the situation in front of you.)',
  );
  return lines.join('\n');
}
