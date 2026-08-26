/**
 * Which of the stored skills is this turn actually about?
 *
 * ## Why the lexical ranker cannot answer that here
 *
 * The prompt has room for six skills out of a hundred-plus, so something has to choose. Today that is a
 * jaccard overlap between tokens of the user's message and tokens of the skill text, and in this
 * deployment it returns zero on almost every turn — `relevance=on(matched 0 → global fallback)` is in
 * nearly every logged turn for weeks.
 *
 * The reason is not the tokenizer. The owner writes Chinese; the skill corpus is English after the i18n
 * pass. Token overlap between "我们需要推进lrc证明本身" and `classify-computational-evidence-vs-proof` is
 * zero BY CONSTRUCTION, and no tokenizer changes that. So every turn falls back to "top six by score" —
 * the same five mature skills plus one rotating draft, regardless of topic.
 *
 * That is also what made the eviction rule unfair: a draft got its three showings on three unrelated
 * turns and was deleted for "never chosen". 2026-08-04 removed `exact-rational-lrc-tightness-verification`,
 * `timeout-safe-combinatorial-enumeration`, `optimize-enumeration-after-timeout` and
 * `incremental-script-refactoring-on-computation-failure` that way — the four skills most obviously about
 * the week's work.
 *
 * ## The shape of the fix
 *
 * A model reading "推进lrc证明本身" and a list of English skill names has no difficulty at all. So the
 * choice goes to the aux model, and the lexical path stays exactly as it is underneath.
 *
 * The doctrine this repo has paid for twice applies directly:
 *   - the aux model is asked to CHOOSE FROM a list we printed, and its answer is exact-matched against
 *     that list — reading back our own closed enum, never free-text intent parsing;
 *   - it cannot invent a skill: a name we do not recognise is dropped, and a reply full of them selects
 *     nothing rather than something wrong;
 *   - transcription is not assumed reliable (see the UUID post-mortem) — matching is case- and
 *     whitespace-insensitive and tolerates the model quoting, bulleting or numbering its answer;
 *   - every failure path returns null and the caller keeps today's ranking byte for byte.
 *
 * PHILONT_SKILL_RECALL_LLM=0 disables it.
 */

import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';

/** What the selector is shown about each candidate: a name and one line of what it is for. */
export interface SkillCandidate {
  name: string;
  description: string;
  whenToUse?: string;
}

export type SkillSelectionOutcome =
  | { result: 'picked'; names: string[] }
  | {
      result: 'fallback';
      reason:
        | 'disabled'
        | 'query-too-short'
        | 'no-candidates'
        | 'aux-unconfigured'
        | 'model-picked-nothing'
        | 'model-named-unknown'
        | 'selector-failed';
      error?: string;
    };

export function skillRecallLlmEnabled(): boolean {
  return process.env.PHILONT_SKILL_RECALL_LLM !== '0';
}

/** A message too short to carry a topic tells the selector nothing worth an aux call. */
const MIN_QUERY_CHARS = 4;

export function buildSkillSelectionPrompt(
  query: string,
  candidates: SkillCandidate[],
  k: number,
): { system: string; user: string } {
  const line = (c: SkillCandidate) => {
    const what = (c.whenToUse?.trim() || c.description || '').replace(/\s+/g, ' ').slice(0, 160);
    return `- ${c.name}: ${what}`;
  };
  return {
    system:
      'You pick which stored skills are worth showing an agent for the task it is about to work on.\n' +
      `Output AT MOST ${k} names from the list, one per line, exactly as written. Nothing else.\n` +
      'The task may be in a different language from the skill descriptions — judge by MEANING, that is ' +
      'the whole reason you are being asked rather than a keyword matcher.\n' +
      'Pick only skills that genuinely bear on THIS task. Fewer is better than padding, and if none of ' +
      'them are relevant output exactly: NONE\n' +
      'Never invent a name that is not on the list.',
    user: `Task:\n${query.slice(0, 1200)}\n\nSkills:\n${candidates.map(line).join('\n')}`,
  };
}

/**
 * Read the reply back against the names we printed. Anything we did not offer is dropped — the model
 * gets to choose from our list, not to write to it.
 */
export function parseSelectedSkillNames(raw: string | null | undefined, offered: readonly string[]): string[] {
  const text = (raw ?? '').trim();
  if (!text || /^NONE\b/i.test(text)) return [];
  const byLower = new Map(offered.map((n) => [n.toLowerCase(), n]));
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    // tolerate "- name", "1. name", "`name`", quotes, trailing commentary after a colon or dash
    const cleaned = rawLine
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
      .replace(/[`"'「」『』]/g, '')
      .trim()
      .split(/\s+[—–-]\s+|:\s/)[0]
      .trim()
      .toLowerCase();
    if (!cleaned) continue;
    const hit = byLower.get(cleaned);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Names the aux model considers relevant, in its order; null when it could not be consulted or said
 * nothing usable. Null means "no opinion" and the caller must keep its existing ranking.
 */
export async function selectSkillsByAux(
  query: string,
  candidates: SkillCandidate[],
  k: number,
  deps: {
    ask?: (req: { system: string; user: string; maxTokens: number; requireComplete: boolean }) => Promise<string | null>;
    configured?: boolean;
    onOutcome?: (outcome: SkillSelectionOutcome) => void;
  } = {},
): Promise<string[] | null> {
  const fallback = (reason: Extract<SkillSelectionOutcome, { result: 'fallback' }>['reason'], error?: string) => {
    deps.onOutcome?.({ result: 'fallback', reason, ...(error ? { error } : {}) });
    return null;
  };
  if (!skillRecallLlmEnabled()) return fallback('disabled');
  if (!query || query.trim().length < MIN_QUERY_CHARS) return fallback('query-too-short');
  if (candidates.length === 0) return fallback('no-candidates');
  if (!(deps.configured ?? isAuxLLMConfigured())) return fallback('aux-unconfigured');
  try {
    const { system, user } = buildSkillSelectionPrompt(query, candidates, k);
    const ask = deps.ask ?? ((req) => callAuxLLM({ ...req, fallbackToMain: false }));
    const raw = await ask({ system, user, maxTokens: 200, requireComplete: true });
    const names = parseSelectedSkillNames(raw, candidates.map((c) => c.name));
    if (names.length === 0) {
      // "there is nothing relevant" and "it answered with names we do not recognise" both end up as
      // zero picks, and they call for opposite fixes: the first is about the corpus, the second about
      // the prompt or the exact-match rule. Reporting them as one reason would leave the next reader
      // exactly where this whole module started — a fallback with no cause. A reply that is neither
      // empty nor an explicit NONE, yet matched nothing we offered, is the second case.
      const answered = (raw ?? '').trim();
      if (answered && !/^NONE\b/i.test(answered)) {
        return fallback('model-named-unknown', answered.slice(0, 120));
      }
      return fallback('model-picked-nothing');
    }
    const picked = names.slice(0, k);
    deps.onOutcome?.({ result: 'picked', names: picked });
    return picked;
  } catch (e) {
    return fallback('selector-failed', e instanceof Error ? e.message : String(e));
  }
}
