/**
 * 7-day report: `reflect.new_skill = 0`, top failure signature `pariGp:gp-syntax ×71`.
 *
 * The reading that looks obvious — "skill distillation is blocked" — would have shipped a mechanism that
 * produces nothing. The model is RIGHT not to emit new_skill for a gp syntax error: the reflection prompt
 * asks new_skill for "a new workflow (registration / onboarding / report generation)", and an unbalanced
 * paren is not a workflow. No learning type can carry "when signature S happens, do THIS repair".
 *
 * The repair knowledge existed only as authoringCheatsheet() — a table hand-written on 2026-06-22 after
 * watching the same PARI/GP mistakes for hours. Four weeks later the same signature still led the chart,
 * because a hand-written table only knows the mistakes someone already sat and watched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMechanicalRecovery,
  distillMechanicalFix,
  parseMechanicalFix,
  learnedCheatsheet,
  buildMechanicalFixPrompt,
  MECHANICAL_FIX_NAMESPACE,
} from '../src/mechanical_fix_learning.js';
import { buildMechanicalFixReminder } from '../src/in_turn_reflection.js';

/** Minimal stand-in for the fact store: namespace/key → value. */
function fakeFacts() {
  const m = new Map<string, unknown>();
  return {
    getFact: (ns: string, key: string) =>
      m.has(`${ns}/${key}`) ? { value: m.get(`${ns}/${key}`) } : null,
    storeFact: (i: { namespace: string; key: string; value: unknown }) => {
      m.set(`${i.namespace}/${i.key}`, i.value);
      return i;
    },
    _dump: m,
  };
}

const failed = {
  toolName: 'pariGp',
  content: '⚠ TOOL FAILED — *** syntax error, unexpected end of file, expecting )',
  toolInput: { code: 'for(n=1,100, print(n)' },
};
const worked = {
  toolName: 'pariGp',
  content: '✓ TOOL OK\n1\n2\n3',
  toolInput: { code: 'for(n=1,100, print(n))' },
};

test('a failure followed by a success on the same tool is a recovery', () => {
  const r = findMechanicalRecovery([failed, worked]);
  assert.ok(r);
  assert.equal(r.signature, 'pariGp:gp-syntax');
  assert.equal(r.failedSource, 'for(n=1,100, print(n)');
  assert.equal(r.workingSource, 'for(n=1,100, print(n))');
});

// The floor is the whole safety story: without recovery evidence we would be recording a GUESS at a fix
// that was never seen to work, and a wrong cheatsheet line is then injected into every future turn that
// hits the signature. Learning nothing is strictly better.
test('a turn that only failed teaches nothing', () => {
  assert.equal(findMechanicalRecovery([failed]), null);
  assert.equal(findMechanicalRecovery([failed, { ...failed, toolInput: { code: 'still(broken' } }]), null);
});

test('a success BEFORE the failure is not a repair of it', () => {
  assert.equal(findMechanicalRecovery([worked, failed]), null);
});

test('an identical script that failed then passed is a flake, not a rule', () => {
  const same = { ...worked, toolInput: { code: failed.toolInput.code } };
  assert.equal(findMechanicalRecovery([failed, same]), null, '"do the same thing again" teaches nothing');
});

test('only tools whose every error is a script bug qualify', () => {
  const httpFail = { toolName: 'webFetch', content: '⚠ TOOL FAILED — 503', toolInput: { url: 'a' } };
  const httpOk = { toolName: 'webFetch', content: '✓ TOOL OK', toolInput: { url: 'b' } };
  assert.equal(findMechanicalRecovery([httpFail, httpOk]), null, 'a 503 has no authoring rule in it');
});

test('the prompt shows both scripts and the error, and asks for one line', () => {
  const r = findMechanicalRecovery([failed, worked])!;
  const { system, user } = buildMechanicalFixPrompt(r);
  assert.match(user, /for\(n=1,100, print\(n\)$/m);
  assert.match(user, /syntax error/);
  assert.match(system, /ONE imperative sentence/);
  assert.match(system, /output exactly: NONE/);
});

test('the learned line is stored under the signature and read back', async () => {
  const facts = fakeFacts();
  const got = await distillMechanicalFix([failed, worked], facts, {
    configured: true,
    ask: async () => 'Close every "(" you open: for( needs its own ")" before the statement ends.',
  });
  assert.ok(got);
  assert.equal(got.signature, 'pariGp:gp-syntax');
  assert.deepEqual(learnedCheatsheet('pariGp:gp-syntax', facts), [got.line]);
  assert.ok(facts._dump.has(`${MECHANICAL_FIX_NAMESPACE}/pariGp:gp-syntax`));
});

test('the same line is not stored twice', async () => {
  const facts = fakeFacts();
  const ask = async () => 'Close every "(" you open before the statement ends, including for( and sum(.';
  await distillMechanicalFix([failed, worked], facts, { configured: true, ask });
  const second = await distillMechanicalFix([failed, worked], facts, { configured: true, ask });
  assert.equal(second, null);
  assert.equal(learnedCheatsheet('pariGp:gp-syntax', facts).length, 1);
});

test('the model is never asked whether a fix happened — the trace already settled that', () => {
  const r = findMechanicalRecovery([failed, worked])!;
  const { system, user } = buildMechanicalFixPrompt(r);
  for (const p of [system, user]) {
    assert.doesNotMatch(p, /did (you|the agent) (fix|repair)/i);
    assert.doesNotMatch(p, /was it fixed/i);
  }
});

test('NONE and useless answers store nothing', async () => {
  assert.equal(parseMechanicalFix('NONE'), null);
  assert.equal(parseMechanicalFix('  none  '), null);
  assert.equal(parseMechanicalFix('fix it'), null, 'too short to teach anything');
  assert.equal(parseMechanicalFix('x'.repeat(400)), null, 'a paragraph is not a cheatsheet line');
  assert.equal(parseMechanicalFix(''), null);
  assert.equal(parseMechanicalFix('- Balance parentheses in for() loops before closing.'),
    'Balance parentheses in for() loops before closing.');

  const facts = fakeFacts();
  assert.equal(
    await distillMechanicalFix([failed, worked], facts, { configured: true, ask: async () => 'NONE' }),
    null,
  );
  assert.equal(facts._dump.size, 0);
});

test('an unreachable or unconfigured aux model changes nothing', async () => {
  const facts = fakeFacts();
  assert.equal(await distillMechanicalFix([failed, worked], facts, { configured: false }), null);
  assert.equal(
    await distillMechanicalFix([failed, worked], facts, {
      configured: true,
      ask: async () => {
        throw new Error('aux down');
      },
    }),
    null,
  );
  assert.equal(facts._dump.size, 0);
});

test('the switch restores the previous behaviour wholesale', async () => {
  const prev = process.env.PHILONT_MECHANICAL_FIX_LEARNING;
  process.env.PHILONT_MECHANICAL_FIX_LEARNING = '0';
  try {
    const facts = fakeFacts();
    assert.equal(
      await distillMechanicalFix([failed, worked], facts, { configured: true, ask: async () => 'a real rule here' }),
      null,
    );
    assert.deepEqual(learnedCheatsheet('pariGp:gp-syntax', facts), []);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_MECHANICAL_FIX_LEARNING;
    else process.env.PHILONT_MECHANICAL_FIX_LEARNING = prev;
  }
});

// The consumption end: learned lines have to reach the reminder that already works, next to the
// hand-written table, or none of the above is worth anything.
test('learned lines appear in the in-turn reminder', () => {
  const line = 'Braces cannot nest — define each brace-bodied helper at top level.';
  const text = buildMechanicalFixReminder('pariGp:gp-syntax', 3, [line]);
  assert.ok(text.includes(line));
  assert.match(text, /Learned from your own past repairs of pariGp:gp-syntax/);
  assert.match(text, /PARI\/GP authoring rules/, 'the hand-written table is still there too');
});

test('no learned lines leaves the reminder exactly as it was', () => {
  const before = buildMechanicalFixReminder('pariGp:gp-syntax', 3);
  assert.equal(buildMechanicalFixReminder('pariGp:gp-syntax', 3, []), before);
  assert.doesNotMatch(before, /Learned from your own past repairs/);
});
