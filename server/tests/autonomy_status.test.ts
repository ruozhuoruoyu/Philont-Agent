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
  classifyProposalReply,
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

// ── the words we print must be the words we listen for (2026-07-14) ──────────────────────────────
//
// The panel told the owner to reply "同意提案 <id前8位>". Before this, that phrase existed in exactly ONE
// place in the whole repo: the card that printed it. Nothing matched it. The decision could only land if the
// model spontaneously noticed and called decide_constitution_proposal — with a full UUID it had never been
// shown. The constitution-amendment loop, the capstone of the selfhood design, was dead from the user's end.
test('classifyProposalReply: matches the words the panel offered, in both languages', () => {
  assert.deepEqual(classifyProposalReply('同意提案 a1b2c3d4'), { decision: 'approve', idPrefix: 'a1b2c3d4' });
  assert.deepEqual(classifyProposalReply('批准提案 a1b2c3d4'), { decision: 'approve', idPrefix: 'a1b2c3d4' });
  assert.deepEqual(classifyProposalReply('拒绝提案 a1b2c3d4'), { decision: 'reject', idPrefix: 'a1b2c3d4' });
  assert.deepEqual(classifyProposalReply('approve proposal A1B2C3D4'), { decision: 'approve', idPrefix: 'a1b2c3d4' });
  assert.deepEqual(classifyProposalReply('reject proposal a1b2c3d4'), { decision: 'reject', idPrefix: 'a1b2c3d4' });
  // A bilingual owner will type the Chinese words at an English panel. Being strict there would punish them
  // for a setting they never saw.
  assert.deepEqual(classifyProposalReply('"同意提案 a1b2c3d4"'), { decision: 'approve', idPrefix: 'a1b2c3d4' });
  // Full ids are accepted as well as the printed 8-char prefix.
  assert.ok(classifyProposalReply('同意提案 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071'));
});

test('classifyProposalReply: does not hijack ordinary sentences', () => {
  // This runs BEFORE the model on every turn, so a false positive would silently amend the constitution.
  assert.equal(classifyProposalReply('我同意提案吗'), null);
  assert.equal(classifyProposalReply('同意'), null, 'no id → not a proposal decision');
  assert.equal(classifyProposalReply('approve proposal'), null);
  assert.equal(classifyProposalReply('说说那个宪法提案'), null);
  assert.equal(classifyProposalReply(''), null);
});

test('renderSelfhoodStatusText: renders English, and offers the words it will actually match', () => {
  const s = {
    traits: { live: true, competitiveness: 0.5, curiosity: 0.7, conscientiousness: 0.6 },
    initiativesToday: { done: 3 },
    budget: { llmTokensUsed: 100, toolCallsUsed: 5 },
    pursuits: [],
    observations: [],
    proposals: [{ card: 'p1 · something', id: 'a1b2c3d4' }],
  } as unknown as Parameters<typeof renderSelfhoodStatusText>[0];

  const en = renderSelfhoodStatusText(s, Date.now(), 'en');
  assert.match(en, /Autonomy status/);
  assert.match(en, /approve proposal/);
  assert.doesNotMatch(en, /同意提案/, 'an English panel must not tell the owner to reply in Chinese');
  // The words the panel offers must be words the matcher accepts — that is the whole defect.
  assert.ok(classifyProposalReply('approve proposal a1b2c3d4'));

  const zh = renderSelfhoodStatusText(s, Date.now(), 'zh');
  assert.match(zh, /自主状态/);
  assert.match(zh, /同意提案/);
  assert.ok(classifyProposalReply('同意提案 a1b2c3d4'));
});
