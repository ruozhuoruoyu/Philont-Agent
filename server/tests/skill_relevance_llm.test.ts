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

test('every no-op path reports why lexical fallback was kept', async () => {
  const reasons: string[] = [];
  const observe = { onOutcome: (o: { result: string; reason?: string }) => o.reason && reasons.push(o.reason) };
  const previous = process.env.PHILONT_SKILL_RECALL_LLM;
  process.env.PHILONT_SKILL_RECALL_LLM = '0';
  await selectSkillsByAux('long enough', CANDIDATES, 6, { configured: true, ...observe });
  if (previous === undefined) delete process.env.PHILONT_SKILL_RECALL_LLM;
  else process.env.PHILONT_SKILL_RECALL_LLM = previous;

  await selectSkillsByAux('ok', CANDIDATES, 6, { configured: true, ...observe });
  await selectSkillsByAux('long enough', [], 6, { configured: true, ...observe });
  await selectSkillsByAux('long enough', CANDIDATES, 6, { configured: false, ...observe });
  await selectSkillsByAux('long enough', CANDIDATES, 6, {
    configured: true,
    ask: async () => 'NONE',
    ...observe,
  });
  await selectSkillsByAux('long enough', CANDIDATES, 6, {
    configured: true,
    ask: async () => { throw new Error('aux down'); },
    ...observe,
  });

  assert.deepEqual(reasons, [
    'disabled',
    'query-too-short',
    'no-candidates',
    'aux-unconfigured',
    'model-picked-nothing',
    'selector-failed',
  ]);
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

test('a reply naming skills we never offered is reported apart from an honest NONE', async () => {
  // Zero picks has two causes with opposite remedies: nothing in the corpus fits (a corpus problem)
  // versus the model answered with names we do not recognise (a prompt / exact-match problem).
  // Collapsing them leaves the reader with a fallback and no cause — the state this module was
  // written to end.
  const outcomes: unknown[] = [];
  const candidates = [{ name: 'export-long-answer-to-word-windows', description: 'export to docx' }];

  await selectSkillsByAux('调研技术路线并整理成文档', candidates, 6, {
    configured: true,
    ask: async () => 'NONE',
    onOutcome: (o) => outcomes.push(o),
  });
  await selectSkillsByAux('调研技术路线并整理成文档', candidates, 6, {
    configured: true,
    ask: async () => 'write-a-word-document\nexport-docx',
    onOutcome: (o) => outcomes.push(o),
  });

  assert.deepEqual(outcomes[0], { result: 'fallback', reason: 'model-picked-nothing' });
  const unknown = outcomes[1] as { result: string; reason: string; error?: string };
  assert.equal(unknown.reason, 'model-named-unknown');
  assert.match(String(unknown.error), /write-a-word-document/, 'the reply is sampled so the cause is diagnosable');
});

// ── the selector is sampled (2026-08-28) ──────────────────────────────────────────────────────────
//
// The identical resolved query (the L4e-3 node) was asked three times in twenty minutes and answered
// NONE / six picks / NONE. The picks were good when they came, so neither the corpus nor the query was
// at fault — a single draw was deciding whether the skill layer participated in the turn at all.

test('an empty answer is re-asked once; a good second draw is used', async () => {
  let calls = 0;
  const picked = await selectSkillsByAux('推进 LRC 的 L4e-3 核心界证明', CANDIDATES, 6, {
    configured: true,
    ask: async () => (++calls === 1 ? 'NONE' : NAMES[0]),
  });
  assert.deepEqual(picked, [NAMES[0]]);
  assert.equal(calls, 2, 'the first NONE must not be the whole decision');
});

test('two empty answers are an answer; a named-unknown reply is not re-asked', async () => {
  let none = 0;
  assert.equal(
    await selectSkillsByAux('unrelated task at length', CANDIDATES, 6, {
      configured: true,
      ask: async () => { none++; return 'NONE'; },
    }),
    null,
  );
  assert.equal(none, 2, 'bounded: one retry, not a loop');

  // Naming skills we do not offer is a prompt/matching problem — an identical second draw cannot fix
  // it, and re-asking would just double the cost of a diagnosable failure.
  let unknown = 0;
  assert.equal(
    await selectSkillsByAux('unrelated task at length', CANDIDATES, 6, {
      configured: true,
      ask: async () => { unknown++; return 'some-skill-we-never-had'; },
    }),
    null,
  );
  assert.equal(unknown, 1);
});
