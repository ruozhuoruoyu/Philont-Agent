/**
 * CaseStore tests: write policy (success/failure only, blank goal or empty trace rejected), tools derived
 * from the trace, Jaccard search with no zero-score results (void case), verdict filter, retention cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, CASE_RETAIN_MAX } from '../src/index.js';

test('record: stores success/failure, derives distinct tools in order, rejects blank/empty', () => {
  const { cases } = openMemoryDb(':memory:');
  const c = cases.record({
    sessionId: 's1',
    goal: 'count the lines of notes.txt in the workspace',
    trace: [
      { toolName: 'writeFile', ok: true },
      { toolName: 'shell', ok: false },
      { toolName: 'shell', ok: true },
    ],
    verdict: 'success',
    basis: 'rails',
    evidence: 'shell wc -l returned 3',
  });
  assert.ok(c);
  assert.deepEqual(c!.tools, ['writeFile', 'shell']);
  assert.equal(c!.trace.length, 3);
  assert.equal(c!.verdict, 'success');
  assert.equal(cases.count(), 1);

  assert.equal(cases.record({ sessionId: 's1', goal: '   ', trace: [{ toolName: 'shell', ok: true }], verdict: 'failure' }), null);
  assert.equal(cases.record({ sessionId: 's1', goal: 'x', trace: [], verdict: 'failure' }), null);
  // @ts-expect-error — verdicts outside success/failure are not cases
  assert.equal(cases.record({ sessionId: 's1', goal: 'x y z', trace: [{ toolName: 'shell', ok: true }], verdict: 'could_not_verify' }), null);
  assert.equal(cases.count(), 1);
});

test('search: Jaccard over the goal, best first, zero overlap never returned, verdict filter', () => {
  const { cases } = openMemoryDb(':memory:');
  cases.record({ sessionId: 's', goal: 'count lines in notes.txt with a shell command', trace: [{ toolName: 'shell', ok: true }], verdict: 'success' });
  cases.record({ sessionId: 's', goal: 'count lines in notes.txt with a shell command and report', trace: [{ toolName: 'shell', ok: false }], verdict: 'failure' });
  cases.record({ sessionId: 's', goal: 'deliver weekly summary via wechat', trace: [{ toolName: 'wechat', ok: true }], verdict: 'success' });

  const got = cases.search('count lines notes.txt shell', { k: 3 });
  assert.equal(got.length, 2, 'the wechat case has no overlap and is not returned');
  assert.ok(got.every((m) => m.score > 0));
  assert.ok(got[0].score >= got[1].score);

  const onlySuccess = cases.search('count lines notes.txt shell', { k: 3, verdicts: ['success'] });
  assert.equal(onlySuccess.length, 1);
  assert.equal(onlySuccess[0].verdict, 'success');

  assert.deepEqual(cases.search('', { k: 3 }), []);
  assert.deepEqual(cases.search('完全无关的中文', { k: 3 }), []);
  assert.deepEqual(cases.countByVerdict(), { success: 2, failure: 1 });
});

test('retention: the store is bounded; the oldest cases are trimmed', () => {
  const { cases } = openMemoryDb(':memory:');
  const n = CASE_RETAIN_MAX + 25;
  for (let i = 0; i < n; i++) {
    cases.record({ sessionId: 's', goal: `task number ${i} does a thing`, trace: [{ toolName: 'shell', ok: true }], verdict: 'success' }, 1_000_000 + i);
  }
  assert.equal(cases.count(), CASE_RETAIN_MAX);
  const oldest = cases.recent(CASE_RETAIN_MAX).at(-1)!;
  assert.ok(oldest.createdAt >= 1_000_000 + 25, 'the first 25 (oldest) were trimmed');
});

test('trajectory replay (2026-10-08): input/output excerpts are stored, bounded, and rendered compactly', async () => {
  const { renderCaseTrajectory } = await import('../src/cases.js');
  const { cases } = openMemoryDb(':memory:');
  const long = 'x'.repeat(1000);
  const c = cases.record({
    sessionId: 's2',
    goal: 'reset venmo friends to match my phone contacts',
    trace: [
      { toolName: 'shell', ok: true, input: 'aw exec: print(apis.api_docs.show_api_descriptions(app_name="venmo"))', output: '[{"name": "login", ...}]' },
      { toolName: 'shell', ok: false, input: long, output: 'Traceback: KeyError' },
      { toolName: 'readFile', ok: true },
    ],
    verdict: 'success',
  });
  assert.ok(c);
  assert.equal(c!.trace[0].input!.startsWith('aw exec: print('), true);
  assert.equal(c!.trace[1].input!.length, 300, 'input is clipped at 300 chars');
  assert.equal(c!.trace[1].output, 'Traceback: KeyError');
  assert.equal(c!.trace[2].input, undefined, 'a step without content stays bare');
  const txt = renderCaseTrajectory(c!, 900);
  assert.match(txt, /^· Task: "reset venmo friends/);
  assert.match(txt, /shell: aw exec: print\(apis\.api_docs/);
  assert.match(txt, /shell \(failed\): x+/);
  assert.match(txt, /other calls: readFile/);
  assert.ok(txt.length <= 900 + 8, `bounded: ${txt.length}`);
  // the stored row round-trips through rowToCase with the excerpts
  const again = cases.search('venmo friends phone contacts', { k: 1, verdicts: ['success'] });
  assert.equal(again.length, 1);
  assert.equal(again[0].trace[0].output, '[{"name": "login", ...}]');
  // a legacy case without excerpts renders as the tools line
  const bare = cases.record({ sessionId: 's3', goal: 'list files', trace: [{ toolName: 'shell', ok: true }], verdict: 'success' });
  assert.match(renderCaseTrajectory(bare!), /tools: shell/);
});
