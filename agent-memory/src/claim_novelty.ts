/**
 * Is this candidate something the agent already tried?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────────
 *
 * 2026-07-25, one evening, the owner said it three times:
 *
 *   "这两个路径你都已经趟过很多遍了"
 *   "你这个想法，早已有人试过吧，而且你在之前也试过，毫无意义"
 *   "你这些方向都有人做过了吧？"
 *
 * and each time the agent agreed — "对，GitHub 上一堆用机器学习猜 Goldbach 分布的" — but only AFTER being
 * challenged. Then: "停下吧". The reasoning tree records every node it ever hung, including the ones it
 * marked dead_end, and it consulted none of them when generating the next round of candidates. Each
 * session began with an empty memory of the sessions before it, so the same handful of approaches kept
 * being proposed as fresh ideas, and the only thing standing between a repeat and the owner's evening was
 * the owner.
 *
 * The comparison has to work on Chinese claims, which rules out word tokenisation — the same wall that
 * made skill relevance silently useless (jaccard over single characters scores 0 against an English
 * corpus). Character BIGRAMS need no segmenter, degrade gracefully to letter pairs on ASCII, and are
 * cheap enough to run against every stored claim on every round.
 *
 * The threshold is deliberately not a knob to tune: it is set where "different wording, same idea" starts,
 * and a match is reported rather than deleted. A repeat is sometimes the right move — with a new tool, a
 * new bound, a reason the last attempt failed that has since changed. What is never right is proposing it
 * *as if it were new*, which is what the owner kept having to catch.
 */

/** Claim text as stored on a reasoning node, plus the fate that makes it worth remembering. */
export interface PriorClaim {
  claim: string;
  /** 'dead_end' / 'refuted' carry the most weight — those were tried AND failed. */
  status: string;
  sessionId: string;
}

export interface PriorMatch {
  prior: PriorClaim;
  similarity: number;
}

/** Default similarity at which two claims are the same idea in different words. */
export const CLAIM_REPEAT_THRESHOLD = 0.5;

const STRIP = /[\s，。、；：？！（）()[\]{}“”"'`·,.;:?!/\\|<>~@#$%^&*_+=-]+/g;

/** Character bigrams — no segmenter, so Chinese and English behave the same way. */
export function charBigrams(text: string): Set<string> {
  const s = (text ?? '').toLowerCase().replace(STRIP, '');
  const out = new Set<string>();
  if (s.length === 0) return out;
  if (s.length === 1) { out.add(s); return out; }
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Jaccard over character bigrams: 1 = identical, 0 = nothing in common. */
export function claimSimilarity(a: string, b: string): number {
  const A = charBigrams(a), B = charBigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The closest thing the agent already hung on a tree, or null when this really is new.
 *
 * Ties break towards a claim that was tried AND failed: "you already ruled this out" is a stronger thing
 * to say to the model than "you mentioned something like this once".
 */
export function findPriorMatch(
  claim: string,
  priors: ReadonlyArray<PriorClaim>,
  threshold: number = CLAIM_REPEAT_THRESHOLD,
): PriorMatch | null {
  let best: PriorMatch | null = null;
  for (const prior of priors) {
    const similarity = claimSimilarity(claim, prior.claim);
    if (similarity < threshold) continue;
    const settled = (p: PriorClaim) => p.status === 'dead_end' || p.status === 'refuted';
    if (
      !best ||
      similarity > best.similarity + 1e-9 ||
      (Math.abs(similarity - best.similarity) <= 1e-9 && settled(prior) && !settled(best.prior))
    ) {
      best = { prior, similarity };
    }
  }
  return best;
}

/**
 * The note appended to a diverge round's result when candidates repeat earlier ones. Written to be read
 * by the model mid-turn: it names the old claim and its fate, and asks for the one thing that makes a
 * repeat legitimate — what is different this time.
 */
export function renderRepeatNote(
  repeats: ReadonlyArray<{ candidate: string; match: PriorMatch }>,
): string {
  if (repeats.length === 0) return '';
  const lines = repeats.map(({ candidate, match }) => {
    const fate =
      match.prior.status === 'dead_end'
        ? 'you marked it a DEAD END'
        : match.prior.status === 'refuted'
          ? 'it was REFUTED'
          : `it is still ${match.prior.status}`;
    return `  · "${candidate.slice(0, 70)}"\n      ≈ earlier node "${match.prior.claim.slice(0, 70)}" — ${fate}`;
  });
  return (
    `\n♻️ ${repeats.length} of the candidate(s) above repeat something already on a reasoning tree:\n` +
    lines.join('\n') +
    `\nDo NOT present these to the user as new directions — that is the specific thing the owner has had ` +
    `to catch by hand. For each one either state what is DIFFERENT this time (a tool you did not have, a ` +
    `bound that has since moved, the reason the last attempt failed and why that no longer applies), or ` +
    `drop it and say the space is exhausted.`
  );
}
