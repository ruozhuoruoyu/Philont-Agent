/**
 * 2026-10-09: deliberate reviewers judge against what the prover actually retrieved, can say
 * UNVERIFIABLE instead of refuting for lack of access, and a deliberate round may compute a little.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIBERATE_RESEARCH_ALLOW,
  DELIBERATE_PARI_CALLS,
  limitReviewerCompute,
  retrievalKeyOf,
  rememberRetrievedEvidence,
  withEvidenceCapture,
  renderRetrievedEvidence,
  parseSkepticVerdict,
  tallyVerdicts,
  renderReportDigest,
  type RetrievedEvidence,
} from '../src/deep_explore.js';

test('a deliberate session can compute a little: pariGp/magnitude are allowed, z3 is not', () => {
  assert.ok(DELIBERATE_RESEARCH_ALLOW.has('pariGp'));
  assert.ok(DELIBERATE_RESEARCH_ALLOW.has('magnitude'));
  assert.ok(!DELIBERATE_RESEARCH_ALLOW.has('z3Verify'));
  assert.ok(DELIBERATE_PARI_CALLS >= 1);
});

test('the round compute cap refuses past N pariGp calls with a round-worded message, other tools untouched', async () => {
  const seen: string[] = [];
  const runner = limitReviewerCompute(async (name) => { seen.push(name); return { ok: true, output: `ran ${name}` }; }, { maxCalls: 2, timeoutMs: 1000, label: 'round' });
  assert.equal((await runner('pariGp', { script: '1' })).ok, true);
  assert.equal((await runner('pariGp', { script: '2' })).ok, true);
  const third = await runner('pariGp', { script: '3' });
  assert.equal(third.ok, false);
  assert.match(third.error ?? '', /per round/);
  assert.doesNotMatch(third.error ?? '', /Judge from/);
  assert.equal((await runner('webFetch', { url: 'https://x' })).ok, true);
  assert.deepEqual(seen, ['pariGp', 'pariGp', 'webFetch']);
});

test('retrievalKeyOf: url / path / query for the retrieval tools, null otherwise', () => {
  assert.equal(retrievalKeyOf('webFetch', { url: 'https://arxiv.org/abs/1801.01423' }), 'https://arxiv.org/abs/1801.01423');
  assert.equal(retrievalKeyOf('readFile', { path: 'papers/hat.pdf' }), 'papers/hat.pdf');
  assert.equal(retrievalKeyOf('webSearch', { query: 'HAT Serra 2018' }), 'HAT Serra 2018');
  assert.equal(retrievalKeyOf('pariGp', { script: '1+1' }), null);
  assert.equal(retrievalKeyOf('webFetch', {}), null);
});

test('rememberRetrievedEvidence: keeps successful retrievals, skips stubs and crumbs, replaces a repeated key, caps the list', () => {
  const store = new Map<string, RetrievedEvidence[]>();
  const long = 'x'.repeat(100);
  rememberRetrievedEvidence(store, 's1', 'webFetch', { url: 'https://a' }, long, 1);
  rememberRetrievedEvidence(store, 's1', 'webFetch', { url: 'https://a' }, 'y'.repeat(100), 2);
  rememberRetrievedEvidence(store, 's1', 'webFetch', { url: 'https://b' }, '⚠ DUPLICATE: webFetch(https://b) was already run this session — ' + long, 3);
  rememberRetrievedEvidence(store, 's1', 'readFile', { path: 'p' }, 'short', 4);
  const entries = store.get('s1') ?? [];
  assert.equal(entries.length, 1, 'the stub and the crumb are not evidence; the repeat replaced its entry');
  assert.equal(entries[0].excerpt[0], 'y');
  for (let i = 0; i < 60; i++) rememberRetrievedEvidence(store, 's1', 'webFetch', { url: `https://n${i}` }, long, 10 + i);
  assert.equal((store.get('s1') ?? []).length, 40);
  assert.equal((store.get('s1') ?? [])[0].key, 'https://n20', 'oldest entries fall off');
});

test('withEvidenceCapture: records ok retrievals around the delegate and passes results through unchanged', async () => {
  const store = new Map<string, RetrievedEvidence[]>();
  const runner = withEvidenceCapture(async (name) => ({ ok: name !== 'readFile', output: name === 'readFile' ? '' : 'z'.repeat(200), error: name === 'readFile' ? 'ENOENT' : undefined }), 's2', store);
  assert.equal((await runner('webFetch', { url: 'https://ok' })).ok, true);
  assert.equal((await runner('readFile', { path: 'missing' })).ok, false);
  assert.equal((await runner('pariGp', { script: '1' })).ok, true);
  assert.deepEqual((store.get('s2') ?? []).map((e) => e.key), ['https://ok']);
});

test('renderRetrievedEvidence: cited sources first, then newest, within the budget; empty when nothing retrieved', () => {
  assert.equal(renderRetrievedEvidence([], 'anything'), '');
  const entries: RetrievedEvidence[] = [
    { tool: 'webFetch', key: 'https://old', excerpt: 'OLD '.repeat(50), at: 1 },
    { tool: 'webFetch', key: 'https://cited', excerpt: 'CITED '.repeat(50), at: 2 },
    { tool: 'webFetch', key: 'https://new', excerpt: 'NEW '.repeat(50), at: 3 },
  ];
  const out = renderRetrievedEvidence(entries, 'per https://cited the gate is 1-min(a,b)');
  const order = ['https://cited', 'https://new', 'https://old'].map((k) => out.indexOf(`### webFetch: ${k}`));
  assert.ok(order[0] < order[1] && order[1] < order[2], `cited first, then newest: ${order}`);
  assert.match(out, /do not refute a claim merely because you could not open its source/);
  const tight = renderRetrievedEvidence(entries, null, 700);
  assert.ok(tight.length <= 760, `budget respected: ${tight.length}`);
});

test('parseSkepticVerdict: UNVERIFIABLE is an abstention with a reason, not a refutation', () => {
  const v = parseSkepticVerdict('本会话无 web 工具，笔记里没有 HAT 原文，无法核对公式。\nVERDICT: UNVERIFIABLE');
  assert.equal(v?.unverifiable, true);
  assert.equal(v?.refuted, false);
  assert.match(v?.reason ?? '', /无法核对/);
  assert.equal(parseSkepticVerdict('判定: 无法核验')?.unverifiable, true);
  assert.equal(parseSkepticVerdict('gap in step 2.\nVERDICT: REFUTED')?.refuted, true);
  assert.equal(parseSkepticVerdict('VERDICT: HOLDS')?.unverifiable, undefined);
});

test('tallyVerdicts: unverifiable votes are not refutations, but all-unverifiable does not pass', () => {
  const hold = { refuted: false, reason: '' };
  const unv = { refuted: false, reason: 'source out of reach', unverifiable: true };
  const ref = { refuted: true, reason: 'misread' };
  const t1 = tallyVerdicts([hold, hold, unv]);
  assert.equal(t1.confirmed, true);
  assert.equal(t1.validVotes, 2);
  assert.equal(t1.unverifiableCount, 1);
  const t2 = tallyVerdicts([ref, hold, unv]);
  assert.equal(t2.confirmed, false, 'a tie among those who could judge still fails');
  const t3 = tallyVerdicts([unv, unv, null]);
  assert.equal(t3.confirmed, false, 'nobody could reach the evidence → not established');
  assert.match(t3.topObjection ?? '', /could reach the cited evidence/);
  const t4 = tallyVerdicts([null, null, null]);
  assert.equal(t4.confirmed, true, 'pure abstention (infrastructure) still fails open');
});

test('renderReportDigest: keeps the verdict and the established findings, ends with the trailer, fits the cap', () => {
  const report = [
    '# Deliberation report — ✓ ANSWERED',
    'Question: 设计参考大脑运作方式的模型架构',
    'Tree: 30 nodes — established 7 / open 20 / ruled out 3. Budget spent: 3294/300000 tokens.',
    '',
    '## ✓ Established (evidence-backed)',
    ...Array.from({ length: 12 }, (_, i) => `- 发现 ${i}：${'这是一条比较长的已确立结论，带有来源说明。'.repeat(3)}`),
    '',
    '## ◯ Still open / unresolved',
    '- 开放问题 A',
    'session id: abc',
  ].join('\n');
  const digest = renderReportDigest(report, 820, 'zh');
  assert.ok(digest.length <= 820, `cap: ${digest.length}`);
  assert.match(digest, /^# Deliberation report — ✓ ANSWERED/);
  assert.match(digest, /## ✓ Established/);
  assert.ok(digest.endsWith('……（摘要；完整报告见本轮回复）'));
  assert.equal(renderReportDigest('short report', 820, 'zh'), 'short report');
});
