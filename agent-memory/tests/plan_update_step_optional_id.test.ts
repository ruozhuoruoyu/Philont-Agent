/**
 * plan_id is optional on plan_update_step — a model cannot transcribe a 36-char UUID, and requiring one only
 * produced invented ids (prod: seven fabricated ids in a single run, not one of them correct).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, createPlanTools } from '../src/index.js';

function setup(sessionId = 'sess-opt') {
  const memory = openMemoryDb(':memory:');
  const tools = createPlanTools({
    plans: memory.plans,
    skills: memory.skills,
    getCurrentSessionId: () => sessionId,
  });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    draft: byName.get('plan_draft')!,
    update: byName.get('plan_update_step')!,
    close: byName.get('plan_close')!,
  };
}

const PLAN = {
  goal: 'onboard',
  deliverables: [{ id: 'd1', description: 'register the agent' }],
  steps: [{ id: 'publish-post', description: 'publish the first post', covers: ['d1'] }],
};

test('plan_id is not a required parameter', () => {
  const { update } = setup();
  const required = (update.schema as { required: string[] }).required;
  assert.ok(!required.includes('plan_id'), 'requiring it is what forced the model to invent one');
  assert.ok(required.includes('step_id') && required.includes('status'));
});

test('omitting plan_id works when the session has a single open plan', async () => {
  const { draft, update } = setup();
  await draft.execute(PLAN as never);
  const r = await update.execute({ step_id: 'publish-post', status: 'doing' });
  assert.equal(r.success, true, `should resolve with no id at all: ${r.error}`);
});

test('an invented plan_id still resolves when the step fits (prod shapes, verbatim)', async () => {
  const { draft, update } = setup();
  await draft.execute(PLAN as never);
  for (const bogus of ['plan-mycox-onboarding', 'placeholder', 'p-981691', 'plan_mycox_checkin_routine']) {
    const r = await update.execute({ plan_id: bogus, step_id: 'publish-post', status: 'doing' });
    assert.equal(r.success, true, `"${bogus}" should resolve: ${r.error}`);
  }
});

test('a wrong id AND a step that does not exist is refused, not silently applied elsewhere', async () => {
  const { draft, update } = setup();
  await draft.execute(PLAN as never);
  const r = await update.execute({ plan_id: 'p-981691', step_id: 'no-such-step', status: 'done' });
  assert.equal(r.success, false, 'a guess must not update a plan the step does not belong to');
});

test('omitting plan_id with an unknown step gives the USEFUL error — the real step ids', async () => {
  const { draft, update } = setup();
  await draft.execute(PLAN as never);
  const r = await update.execute({ step_id: 'totally-different', status: 'done' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /publish-post/, 'must name the real steps, not complain about plan_id');
});

test('omitting plan_id with no open plan asks for one explicitly', async () => {
  const { update } = setup();
  const r = await update.execute({ step_id: 'publish-post', status: 'doing' });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /omitted/i);
});

// ── plan_close: the same treatment, 2026-07-22 ────────────────────────────────────────────────
// Prod: a plan the mechanism had itself resolved by session for NINE consecutive update_step calls
// then could not be closed — plan_close failed with a bare "plan_id is required". Two tools, one
// session, opposite strictness about the same untranscribable 36-char id.

test('plan_close: plan_id is not required either', () => {
  const { close } = setup();
  const required = (close.schema as { required: string[] }).required;
  assert.ok(!required.includes('plan_id'));
  assert.ok(required.includes('outcome') && required.includes('summary'));
});

test('plan_close: omitted with a single open plan → closes it', async () => {
  const { draft, close } = setup();
  await draft.execute(PLAN as never);
  const r = await close.execute({
    outcome: 'failure',
    summary: 'Stopped: the feed was unchanged and there was nothing to act on.',
    deliverable_status: { d1: 'not-attempted' },
  } as never);
  assert.equal(r.success, true, r.error);
});

test('plan_close: a mistyped id still resolves to the session plan', async () => {
  const { draft, close } = setup();
  await draft.execute(PLAN as never);
  const r = await close.execute({
    plan_id: 'plan-mycox-checkin',
    outcome: 'failure',
    summary: 'Stopped early; nothing to act on.',
    deliverable_status: { d1: 'not-attempted' },
  } as never);
  assert.equal(r.success, true, r.error);
});

test('plan_close: omitted with no open plan → says so, instead of "plan_id is required"', async () => {
  const { close } = setup();
  const r = await close.execute({ outcome: 'failure', summary: 'x', deliverable_status: {} } as never);
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /no open plan/i);
  assert.doesNotMatch(r.error ?? '', /^plan_id is required$/);
});
