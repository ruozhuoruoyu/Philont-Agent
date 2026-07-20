import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/plan_execute_loop.ts', import.meta.url), 'utf8');

// ── the reviewer's independence must be preserved ────────────────────────────────────────────────
test('the aux reviewer is never handed the cross-round memory', () => {
  // Its verdict is only worth something while its context stays clean; anchoring it on its own earlier
  // judgements would make the second opinion a rerun of the first. The MECHANISM remembers instead.
  const auxCall = src.slice(src.indexOf('deps.auxJudge ? await deps.auxJudge('), src.indexOf('deps.auxJudge ? await deps.auxJudge(') + 200);
  assert.doesNotMatch(auxCall, /prevGapTexts|prevContestedTexts|gapsNote/, 'aux must not receive round history');
});

test('the reviewer sees the guide and deliverables — not the author\'s reasoning', () => {
  const wiring = src.slice(src.indexOf('auxJudge?:'), src.indexOf('auxJudge?:') + 400);
  assert.match(wiring, /guideText/);
  assert.match(wiring, /deliverables/);
});

// ── persistence: a complaint survives rewording ──────────────────────────────────────────────────
test('a reworded repeat of the same complaint is recognised as the same one', () => {
  // The reviewer rewords freely between rounds, so identity is by meaning-overlap, not string equality.
  assert.match(src, /function sameComplaint/);
  assert.match(src, /inter \/ Math\.min\(ta\.size, tb\.size\) >= 0\.6/);
});

test('a repeat is escalated to the author as RAISED AGAIN', () => {
  assert.match(src, /RAISED AGAIN — your last revision did not close this/);
});

// ── contested: disagreement becomes a question, not a silent verdict ─────────────────────────────
test('an aux objection the checker overrules is retained as CONTESTED, not discarded', () => {
  assert.match(src, /const auxContested = auxSignal\.filter\(\(g\) => detCovers\(g\)\)/);
});

test('contested items are escalated only on repeat, and bounded', () => {
  // One-off aux objections are often noise; a repeat after a revision is signal.
  assert.match(src, /auxContested\.filter\(\(g\) => raisedBefore\(g, prevContestedTexts\)\)\.slice\(0, 3\)/);
});

test('a contested item is put to the author as a QUESTION and kept out of the owner-facing gap list', () => {
  assert.match(src, /CONTESTED — the reviewer has raised this twice/);
  assert.match(src, /Decide: name the deliverable that covers it, or add one/);
  // unresolvedGaps (what the owner is shown) is assigned from gapTexts only.
  assert.match(src, /unresolvedGaps = gapTexts;/);
});
