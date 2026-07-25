/**
 * How the skill index is WORDED in the turn prompt.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────────────────
 *
 * Seven days, 689 turns, a pool of 94 skills, every turn carrying an offer of six: `use_skill` was called
 * ZERO times. Not once. The funnel's other rungs all work now — relevance selection picks them, an
 * exploration slot rotates an untested draft in, the cap evicts only what has been shown three times, the
 * reflector has stopped minting because untested drafts are backed up. Every gate opens except the one
 * where the model decides to reach for a skill, and that gate is made of nothing but this text.
 *
 * What that text used to say:
 *
 *     Available skills (use use_skill(name) to get details):
 *       - send-wechat-files-and-verify-size: <description>
 *         When to use: <120 chars of prose>
 *
 * Three things are wrong with it, and all three are about FORM rather than selection:
 *
 * 1. It advertises the MECHANISM, not the VALUE. "use_skill(name) to get details" reads like a
 *    documentation lookup — a tool call that costs a round-trip and returns *details*. A model deciding
 *    what to do next has no reason to spend a call on details when it could just start working. The offer
 *    never says the thing that would matter: this is a recipe that ALREADY WORKED, and improvising a
 *    second version of a solved problem is how the same mistake comes back.
 *
 * 2. It hides the evidence it already has. The store knows useCount, successCount, failureCount and
 *    offeredCount for every row; the prompt showed a bare name. So a recipe that succeeded six times out
 *    of six looked exactly like a guess minted last night, and a reader with no way to tell them apart
 *    reasonably ignores both. Provenance is the whole reason to trust a recipe.
 *
 * 3. It gave the exploration slot no reason to be chosen. One slot of the six is reserved for a draft
 *    nobody has ever tried — the mechanism that makes the maturity ladder turn at all. Presented
 *    identically to five proven entries, it is strictly the worst-looking option on the list, so it loses
 *    every time and stays untested forever. Naming it as untested inverts that: trying it is the only way
 *    it can earn or lose its place, and that is a reason to pick it, not a reason to skip it.
 *
 * The counts are the honest part and they cut both ways: a skill that failed more than it worked says so
 * here, and the model is right to skip it.
 */

/** The fields of a stored skill that the offer renders. Structural, so callers pass rows directly. */
export interface OfferableSkill {
  name: string;
  description: string;
  whenToUse?: string | null;
  maturity: string;
  useCount: number;
  successCount: number;
  failureCount: number;
  offeredCount?: number;
  /** e.g. 'clawhub:foo@1.0.0' — rendered as a short [clawhub] provenance tag. */
  source?: string | null;
}

export const SKILL_WHEN_TO_USE_TRUNC = 120;

/**
 * The short evidence tag after a skill's name. This is the line's whole credibility budget, so it states
 * the record rather than a grade: "worked 6/6" and "failed 3 of 5" are both facts the reader can act on,
 * where "stable" and "draft" are labels whose meaning the reader has to take on faith.
 */
export function skillEvidenceTag(s: OfferableSkill): string {
  const outcomes = s.successCount + s.failureCount;
  if (outcomes > 0) {
    return s.failureCount === 0
      ? `✓ worked ${s.successCount}/${outcomes}`
      : `${s.successCount}/${outcomes} worked`;
  }
  if (s.useCount > 0) return `used ${s.useCount}×, outcome unrecorded`;
  return '⚑ never tried';
}

/** True when the offer contains an entry nobody has ever run — the exploration slot doing its job. */
export function hasUntried(skills: ReadonlyArray<OfferableSkill>): boolean {
  return skills.some((s) => s.successCount + s.failureCount === 0 && s.useCount === 0);
}

/**
 * Render the skill index block. Returns the lines to append to the system prefix (no trailing blank).
 *
 * Deliberately compact: this block is paid for out of a hard context budget on every single turn, so the
 * reframing above must not cost more than a couple of lines over the version it replaces.
 */
export function renderSkillOffer(skills: ReadonlyArray<OfferableSkill>): string[] {
  if (skills.length === 0) return [];
  const lines: string[] = [];

  lines.push(
    'Recipes I already worked out on earlier tasks. If one fits what you are about to do, call ' +
      '`use_skill(name)` to load its steps BEFORE improvising your own version — re-deriving a solved ' +
      'problem is how the same mistake comes back. The counts are the evidence; a poor record is a ' +
      'reason to skip one.',
  );

  for (const s of skills) {
    const provenance = s.source ? ` [${s.source.split(':')[0]}]` : '';
    lines.push(`  - ${s.name}${provenance} — ${skillEvidenceTag(s)}`);
    lines.push(`      ${s.description}`);
    const when = (s.whenToUse ?? '').trim();
    if (when) {
      const display =
        when.length > SKILL_WHEN_TO_USE_TRUNC ? when.slice(0, SKILL_WHEN_TO_USE_TRUNC) + '…' : when;
      lines.push(`      Use when: ${display}`);
    }
  }

  if (hasUntried(skills)) {
    lines.push(
      '  (An entry marked ⚑ has never been run. If it fits, prefer it over improvising: trying it is the ' +
        'only way it can earn or lose its place, and either outcome is recorded.)',
    );
  }

  return lines;
}
