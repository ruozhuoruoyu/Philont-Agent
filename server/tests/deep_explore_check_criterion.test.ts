/**
 * Acceptance criteria on reasoning nodes — "what would confirm or refute this", stated at creation.
 *
 * The failure this addresses is a tree that absorbs rounds while nothing on it can produce a signal. The
 * mechanism does NOT reject a node that has no criterion: some real subgoals are settled only by argument,
 * and rejecting them would trade an unanswerable node for a wedged session. It makes the absence COUNTABLE
 * and says the count out loud — at creation, on every round's frontier, and in the report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import { makeReasoningToolRunner, renderTreePrompt, uncheckableFrontier, renderNodeCheck } from '../src/deep_explore.js';

const noopDelegate = async () => ({ ok: false, output: '', error: 'should not be called' });

test('decompose persists the criterion, and names the children that lack one', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);

  const r = await run('reason_decompose', {
    parentNodeId: rootNode.id,
    subClaims: [
      { claim: 'the sum is below the bound', kind: 'lemma', check: 'magnitude(action="closes") on the three terms' },
      { claim: 'construct a covering system', kind: 'construction' },
    ],
  });

  assert.equal(r.ok, true);
  const kids = mem.reasoning.getNodes(session.id).filter((n) => n.parentId === rootNode.id);
  const withCheck = kids.find((n) => n.claim.startsWith('the sum'))!;
  const without = kids.find((n) => n.claim.startsWith('construct'))!;
  assert.match(withCheck.checkCriterion ?? '', /magnitude/);
  assert.equal(without.checkCriterion, null);
  // The absence is reported at creation, with the id, so it can be fixed in the same round.
  assert.match(r.output, /1\/2 have NO stated check/);
  assert.match(r.output, new RegExp(without.id));
  mem.close();
});

test('a blank or whitespace check is stored as absent, not as an empty criterion', async () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate);

  await run('reason_decompose', { parentNodeId: rootNode.id, subClaims: [{ claim: 'x', kind: 'lemma', check: '   ' }] });

  const kid = mem.reasoning.getNodes(session.id).find((n) => n.parentId === rootNode.id)!;
  assert.equal(kid.checkCriterion, null, 'whitespace must not pass as a stated criterion');
  mem.close();
});

test('the round prompt shows the criterion, and flags the nodes without one', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  mem.reasoning.addNodes(session.id, rootNode.id, [
    { claim: 'checkable one', kind: 'lemma', check: 'pariGp: isprime(n) for n in the stated range' },
    { claim: 'unanswerable one', kind: 'subgoal' },
  ]);

  const prompt = renderTreePrompt(session, mem.reasoning.getNodes(session.id));

  assert.match(prompt, /check: pariGp: isprime/);
  assert.match(prompt, /no stated check/);
  mem.close();
});

test('uncheckableFrontier counts only OPEN leaves with no criterion', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [checkable, uncheckable] = mem.reasoning.addNodes(session.id, rootNode.id, [
    { claim: 'a', kind: 'lemma', check: 'z3Verify on the encoded constraint' },
    { claim: 'b', kind: 'subgoal' },
  ]);
  assert.equal(uncheckableFrontier(mem.reasoning.getNodes(session.id)).length, 1);

  // Settling it removes it from the frontier — the count tracks what is still open, not history.
  mem.reasoning.updateNode(session.id, uncheckable.id, { status: 'dead_end' });
  assert.equal(uncheckableFrontier(mem.reasoning.getNodes(session.id)).length, 0);
  assert.ok(checkable.checkCriterion);
  mem.close();
});

test('the absence is rendered as loudly as the presence', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'G' });
  const [n] = mem.reasoning.addNodes(session.id, rootNode.id, [{ claim: 'x', kind: 'subgoal' }]);
  assert.match(renderNodeCheck(n), /⚠/);
  mem.close();
});
