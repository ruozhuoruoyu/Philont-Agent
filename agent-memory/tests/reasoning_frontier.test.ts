import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, computeFrontier } from '../src/index.js';

// deep_explore(status) said "open 67" and the follow-up card said "65 个开放节点" for the same tree on
// the same night: two readers, two rules. An open node whose children all settled is frontier again.
test('summarizeSession counts the frontier the way deep_explore does', () => {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'prove X' });
  const [a] = mem.reasoning.addNodes(session.id, rootNode.id, [
    { claim: 'lemma A', kind: 'lemma' }, { claim: 'lemma B', kind: 'lemma' },
  ]);
  const [a1] = mem.reasoning.addNodes(session.id, a.id, [{ claim: 'A.1', kind: 'lemma' }]);
  mem.reasoning.updateNode(session.id, a1.id, { status: 'proved', result: 'by hand' });
  // root: has an open child (b) → not frontier. a: its only child is proved → frontier. b: leaf → frontier.
  const nodes = mem.reasoning.getNodes(session.id);
  assert.deepEqual(computeFrontier(nodes).map((n) => n.claim).sort(), ['lemma A', 'lemma B']);
  assert.equal(mem.reasoning.summarizeSession(session.id)?.openFrontierCount, 2, 'the follow-up card must not say 1');
  mem.close();
});
