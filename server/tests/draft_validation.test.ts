import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Skill } from '@agent/memory';
import { DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, draftValidationEnabled, excludeFileBackedDrafts, selectDraftFixture, validateDraftFixture } from '../src/draft_validation.js';

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1', name: 'fix-lean-omega', description: 'Fix omega failures.', whenToUse: 'lean omega could not prove',
    triggerKeywords: ['lean', 'omega'], actionTemplate: 'Expose the missing arithmetic bound before omega.',
    useCount: 0, offeredCount: 0, matchedCount: 0, lastUsedAt: null, createdAt: 1,
    successCount: 0, failureCount: 0, lastFailureAt: null, lastSuccessAt: null, consecutiveFailures: 0,
    maturity: 'draft', kind: 'positive', source: 'self:test', verification: null, toolPolicy: null, revisionHistory: [],
    ...over,
  };
}

function facts() {
  const values = new Map<string, unknown>();
  return {
    values,
    getFact: (ns: string, key: string) => values.has(`${ns}/${key}`) ? { value: values.get(`${ns}/${key}`) } : null,
    storeFact: (x: { namespace: string; key: string; value: unknown }) => { values.set(`${x.namespace}/${x.key}`, x.value); return x; },
  };
}

const failure = { toolName: 'leanCheck', input: { code: 'bad' }, errorText: 'omega could not prove the goal', recordedAt: 10 };
const signatureOf = () => 'leanCheck:lean-unsolved';

test('draft validation is on by default and retains an explicit kill switch', () => {
  assert.equal(draftValidationEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(draftValidationEnabled({ PHILONT_DRAFT_VALIDATION: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(draftValidationEnabled({ PHILONT_MECHANICAL_REPAIR: '0' } as NodeJS.ProcessEnv), false,
    'the parent repair kill switch must disable unattended draft repair too');
});

test('file-backed skills are not draft-validation repair hypotheses', () => {
  assert.deepEqual(
    excludeFileBackedDrafts([skill({ name: 'complex-task-protocol' }), skill({ name: 'learned-fix' })], new Set(['complex-task-protocol']))
      .map((s) => s.name),
    ['learned-fix'],
  );
});

test('draft fixture selection requires real lexical applicability and never-used draft state', () => {
  const picked = selectDraftFixture({
    drafts: [skill(), skill({ name: 'unrelated', triggerKeywords: ['http'], whenToUse: 'network' })],
    failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null, now: 100,
  });
  assert.equal(picked?.skill.name, 'fix-lean-omega');
  assert.equal(selectDraftFixture({
    drafts: [skill({ useCount: 1 })], failures: [failure], eligibleTools: new Set(['leanCheck']),
    signatureOf, attemptFor: () => null,
  }), null, 'already-used drafts are not fixtures for the frozen pool');
});

test('draft matching splits kebab names and rejects a single generic token', () => {
  const kebab = selectDraftFixture({
    drafts: [skill({ name: 'fix-lean-nat-subtraction', whenToUse: '', triggerKeywords: [] })],
    failures: [{ ...failure, errorText: 'lean nat subtraction failed' }], eligibleTools: new Set(['leanCheck']),
    signatureOf, attemptFor: () => null,
  });
  assert.equal(kebab?.skill.name, 'fix-lean-nat-subtraction');
  const generic = selectDraftFixture({
    drafts: [skill({ name: 'generic-lean-helper', whenToUse: '', triggerKeywords: [] })],
    failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null,
  });
  assert.equal(generic, null, 'one generic word is distribution evidence, not applicability evidence');
  const toolNamed = selectDraftFixture({
    drafts: [skill({ name: 'fix-lean-check', whenToUse: '', triggerKeywords: ['lean'] })],
    failures: [{ ...failure, errorText: 'lean check failed on an unrelated goal' }],
    eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null,
  });
  assert.equal(toolNamed, null, 'terms the tool is named after match every failure it ever produced');
  const oneSpecificWord = selectDraftFixture({
    drafts: [skill({ name: 'declare-z3-sort-before-use', whenToUse: '', triggerKeywords: ['sort'] })],
    failures: [{ ...failure, toolName: 'z3Verify', errorText: '(error "line 3 column 12: unknown sort Point")' }],
    eligibleTools: new Set(['z3Verify']), signatureOf, attemptFor: () => null,
  });
  assert.equal(oneSpecificWord?.skill.name, 'declare-z3-sort-before-use',
    'one term that is neither filler nor the tool name is applicability evidence');
  const cjkGeneric = selectDraftFixture({
    drafts: [skill({ name: 'generic-cjk', whenToUse: '证明文件错误', triggerKeywords: [] })],
    failures: [{ ...failure, errorText: '证据明晰，文档件数错位并有误差' }], eligibleTools: new Set(['leanCheck']),
    signatureOf, attemptFor: () => null,
  });
  assert.equal(cjkGeneric, null, 'shared common CJK characters are not applicability evidence');
});

test('verified draft execution records success; changed failure records neutral use', async () => {
  const fixture = selectDraftFixture({
    drafts: [skill()], failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf,
    attemptFor: () => null,
  })!;
  const calls: string[] = [];
  const skillStore = {
    recordSkillOutcome: (_name: string, ok: boolean) => { calls.push(ok ? 'success' : 'failure'); return null; },
    recordUsage: () => { calls.push('neutral'); return null; },
  };
  const verified = await validateDraftFixture({
    fixture, facts: facts(), skills: skillStore as never, signatureOf, isSafeToRerun: () => true,
    ask: async () => '{"code":"good"}', runTool: async () => ({ success: true }),
  });
  assert.equal(verified.transition, 'verified');
  assert.deepEqual(calls, ['success']);

  calls.length = 0;
  const changed = await validateDraftFixture({
    fixture, facts: facts(), skills: skillStore as never, signatureOf: (_t, e) => e.includes('different') ? 'leanCheck:lean-error' : signatureOf(),
    isSafeToRerun: () => true, ask: async () => '{"code":"other"}',
    runTool: async () => ({ success: false, error: 'different error' }),
  });
  assert.equal(changed.transition, 'different_failure');
  assert.deepEqual(calls, ['neutral']);
});

test('declined draft rewrite persists a cooldown without changing skill usage', async () => {
  const store = facts();
  const fixture = selectDraftFixture({ drafts: [skill()], failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null })!;
  const out = await validateDraftFixture({
    fixture, facts: store, skills: { recordSkillOutcome: () => { throw new Error('must not run'); }, recordUsage: () => { throw new Error('must not run'); } } as never,
    signatureOf, isSafeToRerun: () => true, ask: async () => 'NONE', runTool: async () => ({ success: true }), now: 123,
  });
  assert.equal(out.transition, 'not-attempted');
  assert.ok(store.getFact(DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, fixture.key));
  assert.ok(store.getFact(DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, fixture.cooldownKey));
});

test('draft cooldown is stable across historical inputs of the same failure class', () => {
  const first = selectDraftFixture({ drafts: [skill()], failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null })!;
  const secondFailure = { ...failure, input: { code: 'different bad input' }, recordedAt: 20 };
  const picked = selectDraftFixture({
    drafts: [skill()], failures: [secondFailure], eligibleTools: new Set(['leanCheck']), signatureOf,
    attemptFor: (key) => key === first.cooldownKey ? { attempts: 1, lastAttemptAt: 100, permanent: false } : null,
    now: 101,
  });
  assert.equal(picked, null, 'changing fixture input must not bypass the skill+signature cooldown');
});

test('mechanical repair kill switch prevents the unattended tool run and skill outcome', async () => {
  const fixture = selectDraftFixture({ drafts: [skill()], failures: [failure], eligibleTools: new Set(['leanCheck']), signatureOf, attemptFor: () => null })!;
  let runs = 0;
  let outcomes = 0;
  const out = await validateDraftFixture({
    fixture, facts: facts(),
    skills: { recordSkillOutcome: () => { outcomes++; return null; }, recordUsage: () => { outcomes++; return null; } } as never,
    signatureOf, isSafeToRerun: () => true, ask: async () => '{"code":"good"}',
    runTool: async () => { runs++; return { success: true }; },
    env: { PHILONT_MECHANICAL_REPAIR: '0' } as NodeJS.ProcessEnv,
  });
  assert.deepEqual({ transition: out.transition, reason: out.reason, runs, outcomes },
    { transition: 'not-attempted', reason: 'disabled', runs: 0, outcomes: 0 });
});
