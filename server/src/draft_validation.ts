/** Safe validation of advisory draft skills against historical failed tool calls. */
import type { Skill, SkillStore } from '@agent/memory';
import { planTokenize as tokenize } from '@agent/memory';
import type { MechanicalFixStore } from './mechanical_fix_learning.js';
import { attemptMechanicalRepair, mechanicalRepairEnabled } from './mechanical_repair.js';
import { classifyRepairTransition, type RepairTransition } from './in_turn_reflection.js';
import { createHash } from 'node:crypto';
import type { LedgerFailure, ReplayAttemptState } from './repair_replay.js';

export const DRAFT_VALIDATION_ATTEMPTS_NAMESPACE = 'draft_validation_attempts';
const COOLDOWN_MS = 7 * 24 * 60 * 60_000;
/** Declines on distinct failure classes before a skill is judged inapplicable to the whole tool. */
const DECLINES_BEFORE_TOOL_COOLDOWN = 2;

export function draftValidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return mechanicalRepairEnabled(env)
    && !/^(?:0|off|false|no)$/i.test((env.PHILONT_DRAFT_VALIDATION ?? '').trim());
}

/** File-backed SKILL.md entries are capabilities/protocols, not unverified learned repair hypotheses. */
export function excludeFileBackedDrafts<T extends Pick<Skill, 'name'>>(
  drafts: readonly T[],
  onDiskNames: ReadonlySet<string>,
): T[] {
  return drafts.filter((draft) => !onDiskNames.has(draft.name));
}

export interface DraftFixture {
  skill: Skill;
  failure: LedgerFailure;
  signature: string;
  key: string;
  /** Stable skill+failure-class cooldown; changing the historical input must not bypass it. */
  cooldownKey: string;
  /** Applicability cooldown shared by every failure signature produced by the same tool. */
  toolCooldownKey: string;
}

/**
 * Words that carry no applicability evidence anywhere: they say a skill is about a failure, not
 * about WHICH failure. Terms that are generic only relative to one tool (`lean` against leanCheck,
 * `gp` against pariGp) are NOT listed here — they are derived from the tool name at match time, so
 * this file stays free of tool knowledge and cannot rot as tools are added.
 */
const GENERIC_TERMS = new Set([
  'fix', 'repair', 'avoid', 'use', 'when', 'error', 'failed', 'failure', 'tool', 'code',
  'could', 'prove', 'goal', 'helper',
  // English function words. Unlike tool or model names this is a CLOSED class — it does not grow as
  // philont grows — and every entry is a word that can only ever be distribution evidence. Production
  // 2026-09-09: `avoid-concurrent-lean-builds` was validated against `pariGp:gp-precheck-nested-braces`
  // because the skill says "do NOT start a second build" and the PARI error says "are NOT allowed".
  'and', 'or', 'not', 'but', 'the', 'this', 'that', 'these', 'those', 'an', 'in', 'on', 'at', 'to',
  'of', 'for', 'from', 'with', 'without', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'do',
  'does', 'did', 'it', 'its', 'if', 'then', 'than', 'else', 'while', 'before', 'after', 'during',
  'all', 'any', 'some', 'each', 'one', 'two', 'both', 'more', 'most', 'other', 'same', 'so', 'up',
  'out', 'over', 'under', 'again', 'only', 'just', 'very', 'can', 'will', 'would', 'should', 'must',
  'may', 'might', 'no', 'nor', 'into', 'about', 'between', 'because', 'you', 'your', 'we', 'they',
  'them', 'has', 'have', 'had', 'been', 'being', 'there', 'here', 'what', 'which', 'who', 'how',
]);

/**
 * A term present in at least this share of the failure corpus describes the corpus, not the skill.
 *
 * Same principle the tool-name filter already applies, read off the data instead of off one name: a word
 * that matches most of what the ledger holds cannot be evidence that THIS skill applies to THIS failure.
 * It is what killed the 2026-09-09 window, where `avoid-concurrent-lean-builds` was validated against
 * `pariGp:gp-precheck-nested-braces` on the word `not`.
 */
const CORPUS_GENERIC_SHARE = 0.5;
/** Below this many failures there is no distribution to read, so the frequency filter stays out of the way. */
const MIN_CORPUS_FOR_FREQUENCY = 8;

interface SkillTerms {
  /** Latin/digit tokens. Matched whole — see matchesHaystack. */
  tokens: string[];
  /** CJK bigrams. Han has no word boundaries, so these are matched as substrings. */
  cjk: string[];
}

function terms(skill: Skill): SkillTerms {
  const text = [skill.name, skill.whenToUse, ...skill.triggerKeywords].filter(Boolean).join(' ');
  const base = [...tokenize(text)].filter((term) => term.length >= 2 && !GENERIC_TERMS.has(term));
  // planTokenize intentionally exposes CJK characters for recall. Applicability needs phrases instead:
  // individual common characters are dangerously easy to match in an unrelated failure.
  const cjkBigrams = [...text.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap(([run]) => Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));
  const han = /[\p{Script=Han}]/u;
  return {
    tokens: [...new Set(base)].filter((t) => !han.test(t)),
    cjk: [...new Set(cjkBigrams)],
  };
}

export function draftFixtureKey(skill: Skill, failure: LedgerFailure, signature: string): string {
  return createHash('sha256')
    .update(skill.name).update('\0').update(skill.actionTemplate).update('\0')
    .update(signature).update('\0').update(JSON.stringify(failure.input))
    .digest('hex');
}

export function draftCooldownKey(skill: Skill, signature: string): string {
  return createHash('sha256')
    .update('cooldown\0').update(skill.name).update('\0').update(skill.actionTemplate).update('\0')
    .update(signature)
    .digest('hex');
}

export function draftToolCooldownKey(skill: Skill, toolName: string): string {
  return createHash('sha256')
    .update('tool-cooldown\0').update(skill.name).update('\0').update(skill.actionTemplate).update('\0')
    .update(toolName)
    .digest('hex');
}

/** Deterministic prefilter only. The repair model still must return NONE when the prose rule does not apply. */
export function selectDraftFixture(input: {
  drafts: readonly Skill[];
  failures: readonly LedgerFailure[];
  eligibleTools: ReadonlySet<string>;
  signatureOf: (tool: string, error: string) => string;
  attemptFor: (key: string) => ReplayAttemptState | null;
  now?: number;
}): DraftFixture | null {
  const now = input.now ?? Date.now();
  let best: { fixture: DraftFixture; score: number } | null = null;
  // One pass over the corpus: the haystack a term is matched against, and the distribution a term is
  // judged generic by, are the same text and are read once.
  const corpus = input.failures
    .filter((failure) => input.eligibleTools.has(failure.toolName) && failure.errorText.trim())
    .map((failure) => {
      const signature = input.signatureOf(failure.toolName, failure.errorText);
      const raw = `${failure.toolName} ${signature} ${failure.errorText}`.toLowerCase();
      return { failure, signature, raw, tokens: tokenize(raw) };
    });
  const corpusDf = new Map<string, number>();
  for (const entry of corpus) for (const token of entry.tokens) {
    corpusDf.set(token, (corpusDf.get(token) ?? 0) + 1);
  }
  const corpusGeneric = (term: string): boolean =>
    corpus.length >= MIN_CORPUS_FOR_FREQUENCY
    && (corpusDf.get(term) ?? 0) >= corpus.length * CORPUS_GENERIC_SHARE;
  for (const skill of input.drafts) {
    if (skill.maturity !== 'draft' || skill.useCount !== 0) continue;
    const needles = terms(skill);
    if (needles.tokens.length + needles.cjk.length === 0) continue;
    for (const { failure, signature, raw, tokens } of corpus) {
      // A term the tool is named after matches every failure that tool ever produced: distribution
      // evidence, not applicability evidence. Derived, so no tool name is written down here.
      const toolName = failure.toolName.toLowerCase();
      // A latin term must match a WHOLE token of the failure text. Containment made `check` match
      // `gp-precheck` and `and` match `command`, which is how a Lean build-ordering skill came to be
      // validated against a PARI brace error. Han has no word boundaries, so CJK bigrams stay
      // substring matches — they already carry the two-character guard instead.
      const applicable = needles.tokens.filter((term) => !toolName.includes(term) && !corpusGeneric(term));
      const applicableCjk = needles.cjk.filter((term) => !toolName.includes(term));
      if (applicable.length + applicableCjk.length === 0) continue;
      const score = applicable.filter((term) => tokens.has(term)).length
        + applicableCjk.filter((term) => raw.includes(term)).length;
      const skillText = `${skill.whenToUse} ${skill.actionTemplate} ${skill.description}`.toLowerCase();
      const explicitlyNamesSignature = skillText.includes(signature.toLowerCase());
      // One match on a term that survived both filters is applicability evidence, and one is enough.
      //
      // This prefilter picks ONE fixture per idle tick and the repair model is still the judge — it
      // must answer NONE when the prose rule does not apply. So a false positive costs a single aux
      // call that says no, while a false negative costs the whole mechanism: `declare-z3-sort` vs
      // `unknown sort Point` matches on exactly one word. Counting to two only worked while the tool
      // name was quietly supplying the second point; with that gone, specificity is enforced by the
      // two filters above, not by the count. Ranking still prefers the best-matching fixture.
      if (!explicitlyNamesSignature && score < 1) continue;
      const key = draftFixtureKey(skill, failure, signature);
      const cooldownKey = draftCooldownKey(skill, signature);
      const toolCooldownKey = draftToolCooldownKey(skill, failure.toolName);
      // The tool-wide block takes TWO declines, not one. One NONE is the repair model answering about
      // one failure class; a whole tool has eight or more of them, and shutting all of them for a week
      // on a single answer throws away the only evidence this path produces. The signature-level
      // cooldown already prevents an immediate retry of the same class, so the second strike lands on
      // a different class — which is what makes it evidence about the tool rather than the class.
      const toolPrior = input.attemptFor(toolCooldownKey);
      const toolBlocked = !!toolPrior && (
        toolPrior.permanent ||
        ((toolPrior.attempts ?? 0) >= DECLINES_BEFORE_TOOL_COOLDOWN && now - toolPrior.lastAttemptAt < COOLDOWN_MS)
      );
      if (toolBlocked) continue;
      const prior = input.attemptFor(cooldownKey) ?? input.attemptFor(key);
      if (prior?.permanent || (prior && now - prior.lastAttemptAt < COOLDOWN_MS)) continue;
      if (!best || score > best.score || (score === best.score && failure.recordedAt > best.fixture.failure.recordedAt)) {
        best = { fixture: { skill, failure, signature, key, cooldownKey, toolCooldownKey }, score };
      }
    }
  }
  return best?.fixture ?? null;
}

export async function validateDraftFixture(input: {
  fixture: DraftFixture;
  facts: MechanicalFixStore;
  skills: SkillStore;
  signatureOf: (tool: string, error: string) => string;
  isSafeToRerun: (tool: string, args: Record<string, unknown>) => boolean | Promise<boolean>;
  runTool: (tool: string, args: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>;
  ask: (req: { system: string; user: string; maxTokens: number; requireComplete: boolean }) => Promise<string | null>;
  now?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ transition: RepairTransition | 'not-attempted'; reason?: string }> {
  const { fixture } = input;
  const now = input.now ?? Date.now();
  const classify = (result: { success: boolean; output?: string; error?: string }) => classifyRepairTransition({
    beforeSignature: fixture.signature,
    afterSuccess: result.success,
    afterSignature: result.success ? undefined : input.signatureOf(fixture.failure.toolName, result.error ?? result.output ?? ''),
  });
  const recordAttempt = (reason: string | undefined, permanent = false): void => {
    const keys = [fixture.key, fixture.cooldownKey];
    // NONE/model-declined says the rule does not apply to this tool family. Persist that negative
    // applicability evidence above the signature layer so gp-other cannot immediately retry the same
    // prose against gp-timeout. Execution/infrastructure failures remain fixture/signature scoped.
    if (reason === 'model-declined') keys.push(fixture.toolCooldownKey);
    for (const key of new Set(keys)) {
      const prior = input.facts.getFact(DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, key)?.value as Partial<ReplayAttemptState> | undefined;
      input.facts.storeFact({ namespace: DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, key, value: {
        attempts: Math.max(0, Number(prior?.attempts) || 0) + 1,
        lastAttemptAt: now,
        lastReason: reason,
        permanent,
      } satisfies ReplayAttemptState });
    }
  };
  try {
    const result = await attemptMechanicalRepair({
      signature: `draft:${fixture.skill.name}:${fixture.signature}`,
      toolName: fixture.failure.toolName,
      toolInput: fixture.failure.input,
      errorText: fixture.failure.errorText,
      rules: [fixture.skill.description, fixture.skill.actionTemplate].filter(Boolean),
      facts: input.facts,
      isSafeToRerun: (args) => input.isSafeToRerun(fixture.failure.toolName, args),
      run: (args) => input.runTool(fixture.failure.toolName, args),
      ask: input.ask,
      configured: true,
      env: input.env,
      classifyResult: classify,
    });
    if (!result.attempted || !result.result) {
      recordAttempt(result.reason, result.reason === 'unsafe-to-rerun');
      return { transition: 'not-attempted', reason: result.reason };
    }
    const transition = classify(result.result);
    if (transition === 'verified') input.skills.recordSkillOutcome(fixture.skill.name, true, now);
    else if (transition === 'no_effect') input.skills.recordSkillOutcome(fixture.skill.name, false, now);
    else input.skills.recordUsage(fixture.skill.name, now); // tested, but neither supported nor refuted
    return { transition };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    recordAttempt(reason);
    return { transition: 'not-attempted', reason };
  }
}
