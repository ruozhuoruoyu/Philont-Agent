/** Safe validation of advisory draft skills against historical failed tool calls. */
import type { Skill, SkillStore } from '@agent/memory';
import type { MechanicalFixStore } from './mechanical_fix_learning.js';
import { attemptMechanicalRepair } from './mechanical_repair.js';
import { classifyRepairTransition, type RepairTransition } from './in_turn_reflection.js';
import { createHash } from 'node:crypto';
import type { LedgerFailure, ReplayAttemptState } from './repair_replay.js';

export const DRAFT_VALIDATION_ATTEMPTS_NAMESPACE = 'draft_validation_attempts';
const COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export function draftValidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.PHILONT_DRAFT_VALIDATION ?? '').trim());
}

export interface DraftFixture {
  skill: Skill;
  failure: LedgerFailure;
  signature: string;
  key: string;
}

function terms(skill: Skill): string[] {
  return [skill.name, skill.whenToUse, ...skill.triggerKeywords]
    .flatMap((s) => (s ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u))
    .filter((s) => s.length >= 3);
}

export function draftFixtureKey(skill: Skill, failure: LedgerFailure, signature: string): string {
  return createHash('sha256')
    .update(skill.name).update('\0').update(skill.actionTemplate).update('\0')
    .update(signature).update('\0').update(JSON.stringify(failure.input))
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
      const score = needles.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
      if (score === 0) continue;
      const key = draftFixtureKey(skill, failure, signature);
      const prior = input.attemptFor(key);
      if (prior?.permanent || (prior && now - prior.lastAttemptAt < COOLDOWN_MS)) continue;
      if (!best || score > best.score || (score === best.score && failure.recordedAt > best.fixture.failure.recordedAt)) {
        best = { fixture: { skill, failure, signature, key }, score };
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
    const prior = input.facts.getFact(DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, fixture.key)?.value as Partial<ReplayAttemptState> | undefined;
    input.facts.storeFact({ namespace: DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, key: fixture.key, value: {
      attempts: Math.max(0, Number(prior?.attempts) || 0) + 1,
      lastAttemptAt: now,
      lastReason: reason,
      permanent,
    } satisfies ReplayAttemptState });
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
      env: { ...input.env, PHILONT_MECHANICAL_REPAIR: '1' },
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
