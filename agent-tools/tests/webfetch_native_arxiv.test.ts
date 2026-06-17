/**
 * webFetch: arxiv→HTML routing + native web_fetch tool-result extraction (2026-06-17).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arxivCandidates, collectText } from '../src/network/webFetch.js';

test('arxivCandidates: pdf URL → HTML renderings first, original last', () => {
  const c = arxivCandidates('https://export.arxiv.org/pdf/2204.11624');
  assert.deepEqual(c, [
    'https://arxiv.org/html/2204.11624',
    'https://ar5iv.labs.arxiv.org/html/2204.11624',
    'https://export.arxiv.org/pdf/2204.11624',
  ]);
});

test('arxivCandidates: handles .pdf suffix, versions, abs, old-style ids', () => {
  assert.equal(arxivCandidates('https://arxiv.org/pdf/2401.01234v2.pdf')![0], 'https://arxiv.org/html/2401.01234v2');
  assert.equal(arxivCandidates('https://arxiv.org/abs/2310.04406')![0], 'https://arxiv.org/html/2310.04406');
  assert.equal(arxivCandidates('https://arxiv.org/abs/math/0309136')![0], 'https://arxiv.org/html/math/0309136');
});

test('arxivCandidates: non-arxiv or non-paper URLs → null (no rewrite)', () => {
  assert.equal(arxivCandidates('https://baidu.com/s?id=123'), null);
  assert.equal(arxivCandidates('https://arxiv.org/list/math/2024'), null); // not pdf/abs/html
  assert.equal(arxivCandidates('not a url'), null);
});

test('arxivCandidates: an already-HTML arxiv URL still routes (idempotent-ish)', () => {
  const c = arxivCandidates('https://arxiv.org/html/2401.01234');
  assert.equal(c![0], 'https://arxiv.org/html/2401.01234');
});

test('collectText: pulls text out of nested web_fetch_tool_result shapes', () => {
  // Shape A: content → document → source → {text}
  const blockA = {
    type: 'web_fetch_tool_result',
    content: { type: 'web_fetch_result', url: 'x', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'PAGE BODY A' } } },
  };
  const outA: string[] = [];
  collectText(blockA.content, outA, { n: 10000 });
  assert.ok(outA.join('').includes('PAGE BODY A'));

  // Shape B: content is an array of {type:'text', text}
  const blockB = { content: [{ type: 'text', text: 'PAGE BODY B' }] };
  const outB: string[] = [];
  collectText(blockB.content, outB, { n: 10000 });
  assert.ok(outB.join('').includes('PAGE BODY B'));
});

test('collectText: respects the char budget (does not collect once exhausted)', () => {
  const node = { content: [{ text: 'aaaa' }, { text: 'bbbb' }, { text: 'cccc' }] };
  const out: string[] = [];
  collectText(node.content, out, { n: 5 }); // first push (4) leaves 1, second push leaves <0 → stop after
  assert.ok(out.join('').length <= 8);
});
