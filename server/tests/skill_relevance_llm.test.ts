/**
 * `relevance=on(matched 0 → global fallback)` appears in nearly every logged turn, for weeks.
 *
 * Not a tokenizer bug. The owner writes Chinese; the skill corpus is English after the i18n pass. Token
 * overlap between "我们需要推进lrc证明本身" and `classify-computational-evidence-vs-proof` is zero BY
 * CONSTRUCTION. So every turn fell back to "top six by score" — the same five mature skills plus one
 * rotating draft — and a draft got its three showings on three unrelated turns and was deleted for
 * "never chosen". 2026-08-04 removed four skills that way, all of them about the week's actual work.
 *
 * A model reading the task and a list of English names has no difficulty. So the choice goes to the aux
 * model, under the rule this repo has paid for twice: it CHOOSES FROM a list we printed, and its answer
 * is exact-matched back against that list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkillSelectionPrompt,
  parseSelectedSkillNames,
  selectSkillsByAux,
  skillRecallLlmEnabled,
} from '../src/skill_relevance_llm.js';

const CANDIDATES = [
  { name: 'exact-rational-lrc-tightness-verification', description: 'verify LRC tight sets with exact rationals' },
  { name: 'export-long-answer-to-word-windows', description: 'export a long answer to Word on Windows' },
  { name: 'timeout-safe-combinatorial-enumeration', description: 'enumerate without hitting the timeout' },
];
const NAMES = CANDIDATES.map((c) => c.name);

test('the cross-language case the lexical ranker cannot do', async () => {
  const picked = await selectSkillsByAux('我们需要推进lrc证明本身', CANDIDATES, 6, {
    configured: true,
    ask: async () => 'exact-rational-lrc-tightness-verification\ntimeout-safe-combinatorial-enumeration',
  });
  assert.deepEqual(picked, [
    'exact-rational-lrc-tightness-verification',
    'timeout-safe-combinatorial-enumeration',
  ]);
});

test('the selector is told to judge by meaning and never to invent a name', () => {
  const { system, user } = buildSkillSelectionPrompt('推进lrc证明', CANDIDATES, 6);
  assert.match(system, /judge by MEANING/);
  assert.match(system, /Never invent a name/);
  assert.match(system, /output exactly: NONE/);
  assert.match(user, /推进lrc证明/);
  assert.match(user, /exact-rational-lrc-tightness-verification/);
});

// It chooses from our list; it does not get to write to it.
test('a name we never offered is dropped', () => {
  assert.deepEqual(parseSelectedSkillNames('some-skill-i-made-up', NAMES), []);
  assert.deepEqual(
    parseSelectedSkillNames('made-up\nexport-long-answer-to-word-windows', NAMES),
    ['export-long-answer-to-word-windows'],
  );
});

// Transcription is not assumed reliable — the UUID post-mortem is in this repo's memory for a reason.
test('the usual model decorations around a name still resolve', () => {
  for (const reply of [
    '- exact-rational-lrc-tightness-verification',
    '1. exact-rational-lrc-tightness-verification',
    '`exact-rational-lrc-tightness-verification`',
    '"exact-rational-lrc-tightness-verification"',
    'Exact-Rational-LRC-Tightness-Verification',
    'exact-rational-lrc-tightness-verification — verifies tight sets',
    '  exact-rational-lrc-tightness-verification  ',
  ]) {
    assert.deepEqual(parseSelectedSkillNames(reply, NAMES), [NAMES[0]], reply);
  }
});

test('duplicates collapse and order is the selector\'s', () => {
  assert.deepEqual(
    parseSelectedSkillNames(`${NAMES[2]}\n${NAMES[0]}\n${NAMES[2]}`, NAMES),
    [NAMES[2], NAMES[0]],
  );
});

test('NONE and an all-invented reply select nothing rather than something wrong', async () => {
  assert.deepEqual(parseSelectedSkillNames('NONE', NAMES), []);
  assert.deepEqual(parseSelectedSkillNames('  none  ', NAMES), []);
  assert.equal(
    await selectSkillsByAux('unrelated task', CANDIDATES, 6, { configured: true, ask: async () => 'NONE' }),
    null,
    'no opinion, not an empty opinion — the caller keeps its ranking',
  );
  assert.equal(
    await selectSkillsByAux('x'.repeat(20), CANDIDATES, 6, { configured: true, ask: async () => 'nope\nalso-nope' }),
    null,
  );
});

test('an unreachable or unconfigured selector leaves the lexical ranking alone', async () => {
  assert.equal(await selectSkillsByAux('推进lrc证明', CANDIDATES, 6, { configured: false }), null);
  assert.equal(
    await selectSkillsByAux('推进lrc证明', CANDIDATES, 6, {
      configured: true,
      ask: async () => {
        throw new Error('aux down');
      },
    }),
    null,
  );
});

test('a message too short to carry a topic costs no aux call', async () => {
  let called = false;
  const r = await selectSkillsByAux('ok', CANDIDATES, 6, {
    configured: true,
    ask: async () => {
      called = true;
      return NAMES[0];
    },
  });
  assert.equal(r, null);
  assert.equal(called, false);
});

test('an empty pool costs no aux call', async () => {
  let called = false;
  await selectSkillsByAux('推进lrc证明本身', [], 6, {
    configured: true,
    ask: async () => {
      called = true;
      return '';
    },
  });
  assert.equal(called, false);
});

test('the picks are capped at k', async () => {
  const picked = await selectSkillsByAux('推进lrc证明本身', CANDIDATES, 1, {
    configured: true,
    ask: async () => NAMES.join('\n'),
  });
  assert.equal(picked?.length, 1);
});

test('the switch restores the previous behaviour wholesale', async () => {
  const prev = process.env.PHILONT_SKILL_RECALL_LLM;
  process.env.PHILONT_SKILL_RECALL_LLM = '0';
  try {
    assert.equal(skillRecallLlmEnabled(), false);
    assert.equal(
      await selectSkillsByAux('推进lrc证明本身', CANDIDATES, 6, { configured: true, ask: async () => NAMES[0] }),
      null,
    );
  } finally {
    if (prev === undefined) delete process.env.PHILONT_SKILL_RECALL_LLM;
    else process.env.PHILONT_SKILL_RECALL_LLM = prev;
  }
});
