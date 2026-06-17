/**
 * detectUngroundedArxivCitation — fire only when a cited arXiv id has no grounding source (retrieved
 * tool_result or user-supplied), never when the model actually fetched it or the user gave it (2026-06-17).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUngroundedArxivCitation } from '../src/citation_gate.js';

const userMsg = (t: string) => ({ role: 'user', content: t });
const asstMsg = (t: string) => ({ role: 'assistant', content: t });
// A tool_result the harness pushes back as a user-role message with array content.
const toolResult = (t: string) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'x', content: t }],
});

test('cited id with no source anywhere → flagged', () => {
  const text = 'According to arXiv:2603.29831, the equation x^3+y^3=z^3+1 has no solutions.';
  const msgs = [userMsg('帮我研究最小的未解丢番图方程')];
  assert.equal(detectUngroundedArxivCitation(text, msgs), '2603.29831');
});

test('cited id present in a retrieved tool_result → grounded, null', () => {
  const text = 'arXiv:2603.29831 studies x^3+y^3=z^3+1.';
  const msgs = [userMsg('go'), toolResult('Title ... (arXiv:2603.29831) abstract: ...')];
  assert.equal(detectUngroundedArxivCitation(text, msgs), null);
});

test('id supplied by the user → grounded, null', () => {
  const text = 'I read arXiv:2603.29831 and it claims ...';
  const msgs = [userMsg('看一下 arXiv:2603.29831 这篇')];
  assert.equal(detectUngroundedArxivCitation(text, msgs), null);
});

test('id only in the model\'s own prior assistant message → still flagged (self-citation is not grounding)', () => {
  const text = 'As I noted, arXiv:2603.29831 proves it.';
  const msgs = [userMsg('go'), asstMsg('I will look at arXiv:2603.29831')];
  assert.equal(detectUngroundedArxivCitation(text, msgs), '2603.29831');
});

test('no arxiv citation → null (cheap exit)', () => {
  const text = 'I proved the lemma by induction; banked it in the tree.';
  assert.equal(detectUngroundedArxivCitation(text, [userMsg('go')]), null);
});

test('url form arxiv.org/abs/<id> is detected', () => {
  const text = 'see https://arxiv.org/abs/2401.01234 for the construction';
  assert.equal(detectUngroundedArxivCitation(text, [userMsg('go')]), '2401.01234');
});

test('mixed: one grounded, one not → returns the ungrounded one', () => {
  const text = 'arXiv:2401.01234 and arXiv:2603.29831 both apply.';
  const msgs = [userMsg('go'), toolResult('fetched paper arXiv:2401.01234 body...')];
  assert.equal(detectUngroundedArxivCitation(text, msgs), '2603.29831');
});
