/**
 * WS5 (selfhood_closure): recipe reuse verification — a callable recipe that fails within its own
 * tool-policy scope on reuse is demoted to advisory (playbook) and leaves an obs.recipe-decay
 * self-observation. Unrelated failures outside the recipe's scope must NOT kill it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  recordLinkedSkillOutcomes,
  listSelfObservations,
  type Action,
} from '../src/index.js';

function action(over: Partial<Action>): Action {
  return {
    id: 1,
    sessionId: 's',
    trigger: null,
    toolName: 'webFetch',
    params: {},
    result: 'ok',
    success: true,
    timestamp: Date.now(),
    linkedSkill: 'deploy-flow',
    ...over,
  };
}

function seedRecipe(handle: ReturnType<typeof openMemoryDb>, maturity = 'confirmed') {
  return handle.skills.createSkill({
    name: 'deploy-flow',
    description: 'deploys the app',
    triggerKeywords: ['deploy'],
    actionTemplate: '1. build 2. push',
    maturity: maturity as never,
    verification: { kind: 'assert', check: '2 deliverables covered' },
    toolPolicy: ['shell', 'webFetch'],
  });
}

test('WS5: in-scope failure demotes the recipe to playbook + writes obs.recipe-decay', () => {
  const handle = openMemoryDb(':memory:');
  seedRecipe(handle);
  const acts = [
    action({ id: 1, toolName: 'shell', success: true }),
    action({ id: 2, toolName: 'webFetch', success: false, result: 'fetch failed' }),
  ];
  const r = recordLinkedSkillOutcomes(acts, handle.skills, { facts: handle.facts });
  assert.equal(r.failures, 1);
  assert.equal(r.recipesDemoted, 1);
  assert.equal(handle.skills.getByName('deploy-flow')!.maturity, 'playbook');
  const obs = listSelfObservations(handle.facts);
  assert.equal(obs.length, 1);
  assert.match(obs[0].content, /deploy-flow/);
  handle.close();
});

test('WS5: out-of-scope failure does not kill the recipe; scoped success promotes normally', () => {
  const handle = openMemoryDb(':memory:');
  seedRecipe(handle);
  const acts = [
    action({ id: 1, toolName: 'shell', success: true }),
    // Failure on a tool OUTSIDE the recipe's toolPolicy — not the recipe's fault
    action({ id: 2, toolName: 'search_notes', success: false, result: 'no results' }),
  ];
  const r = recordLinkedSkillOutcomes(acts, handle.skills, { facts: handle.facts });
  assert.equal(r.recipesDemoted, 0);
  assert.notEqual(handle.skills.getByName('deploy-flow')!.maturity, 'playbook');
  assert.equal(listSelfObservations(handle.facts).length, 0);
  handle.close();
});

test('WS5: non-recipe skills keep the legacy all-actions strategy', () => {
  const handle = openMemoryDb(':memory:');
  handle.skills.createSkill({
    name: 'plain-skill',
    description: 'no verification',
    triggerKeywords: ['x'],
    actionTemplate: 'steps',
  });
  const acts = [
    action({ id: 1, linkedSkill: 'plain-skill', toolName: 'anything', success: false, result: 'err' }),
  ];
  const r = recordLinkedSkillOutcomes(acts, handle.skills, { facts: handle.facts });
  assert.equal(r.failures, 1);
  assert.equal(r.recipesDemoted, 0);
  handle.close();
});

test('WS5: kill switch PHILONT_RECIPE_REUSE_VERIFY=0 reverts to legacy demotion', () => {
  const handle = openMemoryDb(':memory:');
  seedRecipe(handle);
  process.env.PHILONT_RECIPE_REUSE_VERIFY = '0';
  try {
    const acts = [action({ id: 1, toolName: 'shell', success: false, result: 'boom' })];
    const r = recordLinkedSkillOutcomes(acts, handle.skills, { facts: handle.facts });
    assert.equal(r.recipesDemoted, 0);
    assert.notEqual(handle.skills.getByName('deploy-flow')!.maturity, 'playbook');
  } finally {
    delete process.env.PHILONT_RECIPE_REUSE_VERIFY;
  }
  handle.close();
});
