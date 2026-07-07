/**
 * /autonomy status surface (selfhood_closure WS6 §8): builder + chat text + command matcher.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  InitiativeStore,
  BudgetTracker,
  DEFAULT_BUDGET_CAPS,
  ConstitutionProposalStore,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  DEFAULT_TRAITS,
} from '@agent/memory';
import {
  buildSelfhoodStatus,
  renderSelfhoodStatusText,
  isAutonomyStatusCommand,
} from '../src/autonomy_status.js';

test('buildSelfhoodStatus composes traits, pursuits, observations, proposals, budget', () => {
  const handle = openMemoryDb(':memory:');
  const initiatives = new InitiativeStore(handle.db);
  const budget = new BudgetTracker(handle.db, DEFAULT_BUDGET_CAPS);
  const proposals = new ConstitutionProposalStore(handle.db);

  handle.pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: 'track quantum error correction',
    intent: 'stay current',
    status: 'active',
    stakeWeight: 8,
    origin: 'user',
  });
  proposals.propose({
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    kind: 'value_annotation',
    payload: { text: 'prefer primary sources' },
    rationale: 'test',
    evidenceRefs: ['fact:x'],
  });

  const s = buildSelfhoodStatus({
    traits: () => ({ competitiveness: 0.7, curiosity: 0.6, conscientiousness: 0.5 }),
    traitsLive: true,
    facts: handle.facts,
    pursuits: handle.pursuits,
    proposals,
    initiatives,
    budget,
  });
  assert.equal(s.traits.live, true);
  assert.equal(s.traits.competitiveness, 0.7);
  assert.equal(s.pursuits.length, 1);
  assert.equal(s.pursuits[0].title, 'track quantum error correction');
  assert.equal(s.proposals.length, 1);
  assert.match(s.proposals[0].card, /prefer primary sources/);

  const text = renderSelfhoodStatusText(s);
  assert.match(text, /自主状态/);
  assert.match(text, /好胜 70%/);
  assert.match(text, /track quantum error correction/);
  assert.match(text, /待你决定的宪法修正提案/);
  handle.close();
});

test('renderSelfhoodStatusText: frozen traits + empty agenda degrade gracefully', () => {
  const handle = openMemoryDb(':memory:');
  const s = buildSelfhoodStatus({
    traits: () => DEFAULT_TRAITS,
    traitsLive: false,
    facts: handle.facts,
    pursuits: handle.pursuits,
    proposals: new ConstitutionProposalStore(handle.db),
    initiatives: new InitiativeStore(handle.db),
    budget: new BudgetTracker(handle.db, DEFAULT_BUDGET_CAPS),
  });
  const text = renderSelfhoodStatusText(s);
  assert.match(text, /冻结默认/);
  assert.match(text, /暂无/);
  handle.close();
});

test('isAutonomyStatusCommand matches exact commands only', () => {
  assert.equal(isAutonomyStatusCommand('/autonomy'), true);
  assert.equal(isAutonomyStatusCommand('  /AUTONOMY  '), true);
  assert.equal(isAutonomyStatusCommand('自主状态'), true);
  assert.equal(isAutonomyStatusCommand('/自主'), true);
  assert.equal(isAutonomyStatusCommand('tell me about autonomy'), false);
  assert.equal(isAutonomyStatusCommand('自主状态如何'), false);
});
