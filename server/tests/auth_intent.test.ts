/**
 * Authorization-reply intent: the aux-LLM classifier that replaced the keyword one.
 *
 * The keyword classifier was live in production for every non-Anthropic deployment (i.e. the real one) and
 * graded three of the most natural things a cautious owner says at an auth prompt as CONSENT. These tests
 * pin the two properties that failure needed: our own offered words are read back exactly, and everything
 * else — including any uncertainty at all — never grants by accident.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthIntent, matchOfferedAuthWord } from '../src/auth_intent.js';

/** A stub aux model that records what it was asked, so we can assert what reached it. */
function stubAux(answer: string) {
  const seen: string[] = [];
  return {
    seen,
    call: async (req: { user: string }) => {
      seen.push(req.user);
      return answer;
    },
  };
}

test('matchOfferedAuthWord: reads back OUR closed enum exactly, in both languages', () => {
  // This layer is parsing, not inference: it recognises a word we ourselves printed on the card.
  assert.equal(matchOfferedAuthWord('同意'), 'grant');
  assert.equal(matchOfferedAuthWord('approve'), 'grant');
  assert.equal(matchOfferedAuthWord('yes'), 'grant');
  assert.equal(matchOfferedAuthWord('拒绝'), 'deny');
  assert.equal(matchOfferedAuthWord('reject'), 'deny');
  assert.equal(matchOfferedAuthWord('no'), 'deny');
  assert.equal(matchOfferedAuthWord('「同意」'), 'grant');
});

test('matchOfferedAuthWord: a SENTENCE is not one of our words — it must fall through', () => {
  // The old classifier substring-matched, so any sentence containing 可以 was a grant. Anchored matching
  // means a sentence is never mistaken for the enum; it goes to the aux model, where open language belongs.
  assert.equal(matchOfferedAuthWord('我可以再想想吗'), null);
  assert.equal(matchOfferedAuthWord('这个工具可以干什么？'), null);
  assert.equal(matchOfferedAuthWord('你确认一下这是安全的吗'), null);
  for (const ambiguous of ['继续', '好', '可以', '确认']) {
    assert.equal(matchOfferedAuthWord(ambiguous), null);
  }
});

test('classifyAuthIntent: the three production false-grants are no longer grants', async () => {
  // Measured against the old KeywordIntentClassifier: all three returned 'grant' and authorised an
  // execute/system tool. Asking for time, asking what the tool does, and asking whether it is safe are the
  // three most natural things a cautious owner says — and all three were read as consent.
  for (const q of ['我可以再想想吗', '这个工具可以干什么？', '你确认一下这是安全的吗']) {
    const aux = stubAux('unclear'); // the aux model is told explicitly that a question is not consent
    const r = await classifyAuthIntent(q, 'Tool "shell" (execute/system)', { call: aux.call });
    assert.notEqual(r, 'grant', `"${q}" must never authorise a tool`);
    assert.equal(aux.seen.length, 1, 'an open-language reply must reach the aux model, not a regex');
  }
});

test('classifyAuthIntent: open language is judged by the aux model, and its verdict is honoured', async () => {
  const grant = stubAux('grant');
  assert.equal(
    await classifyAuthIntent('嗯，你放手去做吧，我信你', 'Tool "shell"', { call: grant.call }),
    'grant',
  );
  const deny = stubAux('deny');
  assert.equal(
    await classifyAuthIntent('先别，等我看完再说', 'Tool "shell"', { call: deny.call }),
    'deny',
  );
});

test('classifyAuthIntent: our own offered word never reaches the classifier', async () => {
  // Handing our own vocabulary to a semantic classifier has already produced a bug once: the owner replied
  // with one of our own DENY words and it was read as consent. Layer 1 must short-circuit.
  const aux = stubAux('grant'); // a classifier that would say "grant" no matter what
  assert.equal(await classifyAuthIntent('拒绝', 'Tool "shell"', { call: aux.call }), 'deny');
  assert.equal(aux.seen.length, 0, 'the aux model must not even be consulted about our own enum');
});

test('classifyAuthIntent: fails CLOSED — error, timeout, or garbage never grants', async () => {
  const boom = { call: async () => { throw new Error('aux model is down'); } };
  assert.equal(await classifyAuthIntent('随便你吧', 'Tool "shell"', boom), 'unclear');

  const garbage = stubAux('I think the user probably wants you to go ahead!');
  assert.equal(
    await classifyAuthIntent('随便你吧', 'Tool "shell"', { call: garbage.call }),
    'unclear',
    'anything that is not exactly grant/deny is unclear — never assume consent from a malformed answer',
  );
  // 'unclear' leaves the pending authorization open and re-asks. Asking again is free; authorising by
  // accident is not recoverable.
});
