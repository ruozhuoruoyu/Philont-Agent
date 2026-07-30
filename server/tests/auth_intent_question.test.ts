/**
 * 2026-07-30: a question about a pending authorization came back `deny`, and deny is terminal — the tool
 * is dropped, the model is told the user rejected the operation, and it answers "操作已被您取消。" The
 * owner's question was never answered. From their side the agent just ignored them.
 *
 * The module's instructions guarded one direction only ("a QUESTION is not consent"). Nothing said a
 * question is not a REFUSAL. Both mistakes are expensive and only `unclear` is free — it abandons the
 * suspended tool and lets the message be answered as an ordinary turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthIntent, matchOfferedAuthWord } from '../src/auth_intent.js';

const ctx = 'Tool "shell" (execute/local)';
const ask = (reply: string, answer: string) =>
  classifyAuthIntent(reply, ctx, { call: async () => answer });

test('our own offered words are read back deterministically, never sent to a classifier', async () => {
  assert.equal(matchOfferedAuthWord('同意'), 'grant');
  assert.equal(matchOfferedAuthWord('拒绝'), 'deny');
  assert.equal(matchOfferedAuthWord('approve'), 'grant');
  // if the enum matched, the aux model is not consulted at all
  let called = false;
  const v = await classifyAuthIntent('拒绝', ctx, {
    call: async () => {
      called = true;
      return 'grant';
    },
  });
  assert.equal(v, 'deny');
  assert.equal(called, false, 'our own word must not be re-interpreted');
});

test('the instructions rule out a question in BOTH directions, not just consent', async () => {
  // the prompt is the thing under test here — read it, do not paraphrase it
  const seen: string[] = [];
  await classifyAuthIntent('这个工具到底要干什么？', ctx, {
    call: async (req) => {
      seen.push(req.system);
      return 'unclear';
    },
  });
  const system = seen[0];
  assert.match(system, /neither consent NOR refusal/i);
  assert.match(system, /not a refusal/i);
  assert.match(system, /Only answer deny when/i);
});

test('an unexpected verdict is unclear, in the deny direction too', async () => {
  assert.equal(await ask('随便你', 'DENIED-ish'), 'unclear');
  assert.equal(await ask('随便你', ''), 'unclear');
  assert.equal(await ask('随便你', 'grant, probably'), 'grant', 'a clean prefix is still honoured');
});

test('an unreachable aux model never grants and never denies', async () => {
  const v = await classifyAuthIntent('这个安全吗？', ctx, {
    call: async () => {
      throw new Error('aux down');
    },
  });
  assert.equal(v, 'unclear');
});
