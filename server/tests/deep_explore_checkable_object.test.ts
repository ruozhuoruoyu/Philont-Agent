/**
 * Checkable-object tooth at the settle site (2026-07-22 Jacobian session).
 *
 * A DELIBERATE session settled "the Jacobian determinant is identically -2, three points collide" on
 * citations while pariGp / z3Verify / shell sat unused for the whole round. The object was decidable in
 * seconds. These tests pin the mechanism that now stands there — and, just as importantly, that it refuses
 * only ONCE, so a false positive costs one iteration and can never wedge a session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import { makeReasoningToolRunner, DELIBERATE_PROFILE } from '../src/deep_explore.js';

const noopDelegate = async () => ({ ok: false, output: '', error: 'should not be called' });

/** The claim as production actually recorded it. */
const JACOBIAN = 'The counterexample map has constant Jacobian determinant -2, so the hypothesis holds';
const CITED = ['https://example.org/paper'];

function freshDeliberateSession() {
  const mem = openMemoryDb(':memory:');
  const { session, rootNode } = mem.reasoning.createSession({ goal: 'Is the conjecture false?', mode: 'deliberate' });
  return { mem, session, rootNode };
}

test('deliberate: a settle carrying an unchecked object is refused, and the node stays open', async () => {
  const { mem, session, rootNode } = freshDeliberateSession();
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, undefined, undefined, DELIBERATE_PROFILE);

  const r = await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: JACOBIAN, evidence: CITED });

  assert.equal(r.ok, true);
  assert.match(r.output, /not settled/);
  assert.match(r.output, /pariGp/, 'the refusal must name the tool that decides it');
  assert.equal(mem.reasoning.getNode(session.id, rootNode.id)?.status, 'open', 'node must stay open');
  // The evidence the model gathered is kept — the settle is deferred, not discarded.
  assert.ok((mem.reasoning.getNode(session.id, rootNode.id)?.evidenceRefs ?? []).length > 0);
  mem.close();
});

test('the refusal happens at most once per node — a second attempt settles, with a caveat', async () => {
  const { mem, session, rootNode } = freshDeliberateSession();
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, undefined, undefined, DELIBERATE_PROFILE);

  await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: JACOBIAN, evidence: CITED });
  const second = await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: JACOBIAN, evidence: CITED });

  assert.match(second.output, /Recorded/);
  const node = mem.reasoning.getNode(session.id, rootNode.id);
  assert.equal(node?.status, 'proved', 'it must never deadlock — a persistent settle goes through');
  assert.match(node?.result ?? '', /unverified object/, 'but it cannot pass as a checked result');
  mem.close();
});

test('a session that HAS run a verifier is not nagged', async () => {
  const { mem, session, rootNode } = freshDeliberateSession();
  const delegate = async (name: string) => ({ ok: name === 'pariGp', output: '-2', error: undefined });
  const run = makeReasoningToolRunner(mem.reasoning, session.id, delegate, undefined, undefined, DELIBERATE_PROFILE);

  await run('pariGp', { code: 'matdet(...)' });
  const r = await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: JACOBIAN, evidence: CITED });

  assert.match(r.output, /Recorded/);
  assert.equal(mem.reasoning.getNode(session.id, rootNode.id)?.status, 'proved');
  assert.doesNotMatch(mem.reasoning.getNode(session.id, rootNode.id)?.result ?? '', /unverified object/);
  mem.close();
});

test('ordinary cited prose settles on the first attempt — no false refusal', async () => {
  const { mem, session, rootNode } = freshDeliberateSession();
  const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, undefined, undefined, DELIBERATE_PROFILE);

  const r = await run('reason_record', {
    nodeId: rootNode.id,
    status: 'proved',
    result: 'The 2-variable case remains open; only dimension >= 3 was disproved, per the cited survey',
    evidence: CITED,
  });

  assert.match(r.output, /Recorded/);
  assert.equal(mem.reasoning.getNode(session.id, rootNode.id)?.status, 'proved');
  mem.close();
});

test('kill switch: PHILONT_DEEP_EXPLORE_VERIFY_OBJECTS=0 restores the old behaviour', async () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_VERIFY_OBJECTS;
  process.env.PHILONT_DEEP_EXPLORE_VERIFY_OBJECTS = '0';
  try {
    const { mem, session, rootNode } = freshDeliberateSession();
    const run = makeReasoningToolRunner(mem.reasoning, session.id, noopDelegate, undefined, undefined, DELIBERATE_PROFILE);
    const r = await run('reason_record', { nodeId: rootNode.id, status: 'proved', result: JACOBIAN, evidence: CITED });
    assert.match(r.output, /Recorded/);
    assert.doesNotMatch(mem.reasoning.getNode(session.id, rootNode.id)?.result ?? '', /unverified object/);
    mem.close();
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_VERIFY_OBJECTS;
    else process.env.PHILONT_DEEP_EXPLORE_VERIFY_OBJECTS = prev;
  }
});
