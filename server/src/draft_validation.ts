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
]);

function terms(skill: Skill): string[] {
  const text = [skill.name, skill.whenToUse, ...skill.triggerKeywords].filter(Boolean).join(' ');
  const base = [...tokenize(text)].filter((term) => term.length >= 2 && !GENERIC_TERMS.has(term));
  // planTokenize intentionally exposes CJK characters for recall. Applicability needs phrases instead:
  // individual common characters are dangerously easy to match in an unrelated failure.
  const cjkBigrams = [...text.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap(([run]) => Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));
  return [...new Set([...base, ...cjkBigrams])];
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
  for (const skill of input.drafts) {
    if (skill.maturity !== 'draft' || skill.useCount !== 0) continue;
    const needles = terms(skill);
    if (needles.length === 0) continue;
    for (const failure of input.failures) {
      if (!input.eligibleTools.has(failure.toolName) || !failure.errorText.trim()) continue;
      const signature = input.signatureOf(failure.toolName, failure.errorText);
      const haystack = `${failure.toolName} ${signature} ${failure.errorText}`.toLowerCase();
      // A term the tool is named after matches every failure that tool ever produced: distribution
      // evidence, not applicability evidence. Derived, so no tool name is written down here.
      const toolName = failure.toolName.toLowerCase();
      const applicable = needles.filter((term) => !toolName.includes(term));
      if (applicable.length === 0) continue;
      const matched = applicable.filter((term) => haystack.includes(term));
      const score = matched.length;
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
      const prior = input.attemptFor(cooldownKey) ?? input.attemptFor(key);
      if (prior?.permanent || (prior && now - prior.lastAttemptAt < COOLDOWN_MS)) continue;
      if (!best || score > best.score || (score === best.score && failure.recordedAt > best.fixture.failure.recordedAt)) {
        best = { fixture: { skill, failure, signature, key, cooldownKey }, score };
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
    for (const key of new Set([fixture.key, fixture.cooldownKey])) {
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
