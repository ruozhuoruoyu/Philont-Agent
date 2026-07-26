/**
 * Candidate novelty against the reasoning record.
 *
 * 2026-07-25, one evening: "这两个路径你都已经趟过很多遍了" / "你这个想法，早已有人试过吧，而且你在之前也试过，
 * 毫无意义" / "你这些方向都有人做过了吧？" — then "停下吧". Each time the agent agreed, and only after being
 * told. The tree held every one of those nodes; generation never looked at them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  charBigrams,
  claimSimilarity,
  findPriorMatch,
  renderRepeatNote,
} from '../src/claim_novelty.js';
import { openMemoryDb } from '../src/index.js';

test('similarity survives rewording, in Chinese, with no segmenter', () => {
  const a = '用 CRT 剩余类覆盖构造哥德巴赫反例';
  const b = '通过 CRT 剩余类覆盖来构造哥德巴赫猜想的反例';
  assert.ok(claimSimilarity(a, b) > 0.5, `reworded same idea scored ${claimSimilarity(a, b)}`);
  assert.ok(claimSimilarity(a, '用 Lean 形式化验证素数分布定理') < 0.3, 'a genuinely different idea stays low');
});

test('English behaves the same way — the measure is not language-specific', () => {
  assert.ok(claimSimilarity('search for a K4-free non-traceable graph', 'search for K4-free non traceable graphs') > 0.6);
  assert.ok(claimSimilarity('symbolic regression on Goldbach partitions', 'formalise the parity obstruction in Lean') < 0.25);
});

test('a repeat of something already marked dead is found and reported with its fate', () => {
  const priors = [
    { claim: '用 CRT 剩余类覆盖构造哥德巴赫反例', status: 'dead_end', sessionId: 's-old' },
    { claim: '统计哥德巴赫分拆数的分布', status: 'open', sessionId: 's-old' },
  ];
  const m = findPriorMatch('通过 CRT 剩余类覆盖来构造哥德巴赫猜想的反例', priors);
  assert.ok(m);
  assert.equal(m!.prior.status, 'dead_end');
  const note = renderRepeatNote([{ candidate: '通过 CRT 剩余类覆盖来构造哥德巴赫猜想的反例', match: m! }]);
  assert.match(note, /DEAD END/);
  assert.match(note, /what is DIFFERENT this time/i, 'a repeat is allowed — presenting it as new is not');
});

test('a genuinely new candidate matches nothing', () => {
  const priors = [{ claim: '用 CRT 剩余类覆盖构造哥德巴赫反例', status: 'dead_end', sessionId: 's-old' }];
  assert.equal(findPriorMatch('把奇偶性障碍在 Lean 里形式化成一条不可能性定理', priors), null);
});

test('ties break towards the approach that was tried AND failed', () => {
  const claim = 'search for a K4-free non-traceable 4-critical graph';
  const priors = [
    { claim, status: 'open', sessionId: 'a' },
    { claim, status: 'dead_end', sessionId: 'b' },
  ];
  assert.equal(findPriorMatch(claim, priors)!.prior.status, 'dead_end');
});

test('empty inputs are inert, not crashes', () => {
  assert.equal(claimSimilarity('', 'anything'), 0);
  assert.equal(charBigrams('').size, 0);
  assert.equal(findPriorMatch('x', []), null);
  assert.equal(renderRepeatNote([]), '');
});

test('listPriorClaims: other sessions in full, own session only where settled', () => {
  const db = openMemoryDb(':memory:');
  const older = db.reasoning.createSession({ goal: 'old goal', mode: 'deliberate' });
  const current = db.reasoning.createSession({ goal: 'current goal', mode: 'deliberate' });
  db.reasoning.addNodes(older.session.id, older.rootNode.id, [
    { claim: 'tried CRT covering', kind: 'subgoal' },
  ]);
  const [mine, dead] = db.reasoning.addNodes(current.session.id, current.rootNode.id, [
    { claim: 'still open here', kind: 'subgoal' },
    { claim: 'my own dead end', kind: 'subgoal' },
  ]);
  db.reasoning.updateNode(current.session.id, dead.id, { status: 'dead_end' });

  const claims = db.reasoning
    .listPriorClaims({ excludeSessionId: current.session.id })
    .map((p) => p.claim);
  assert.ok(claims.includes('tried CRT covering'), 'another session contributes everything');
  assert.ok(claims.includes('my own dead end'), "this session's settled nodes are memory too");
  assert.ok(!claims.includes(mine.claim), 'an open node in the CURRENT session is not "already tried"');
});
