import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Skill } from '@agent/memory';
import { DRAFT_VALIDATION_ATTEMPTS_NAMESPACE, selectDraftFixture, validateDraftFixture } from '../src/draft_validation.js';

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
});
