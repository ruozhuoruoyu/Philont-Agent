/** artifact_readback: files a turn wrote, and files a reply names, must exist and open. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkArtifacts,
  checkTurnArtifacts,
  effectToolTargets,
  extractReplyPaths,
  renderReadbackDirective,
  structuralCheck,
} from '../src/artifact_readback.js';

const dir = mkdtempSync(join(tmpdir(), 'readback-'));
const ok = (name: string, content: string | Buffer) => { const p = join(dir, name); writeFileSync(p, content); return p; };

// A docx is a zip whose central directory names [Content_Types].xml; the checker reads the header and the tail.
const fakeDocx = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(64, 0), Buffer.from('[Content_Types].xml', 'latin1'), Buffer.alloc(16, 0)]);
const fakePdf = Buffer.from('%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n', 'latin1');

test('extractReplyPaths: produced-file paths in three spellings; URLs and non-artifact words are not paths', () => {
  const text = '报告已生成：E:\\dev\\out\\report.docx，数据在 /tmp/data/result.json 和 output/lrc/sum.lean。参考 https://example.com/a.pdf 。';
  assert.deepEqual(extractReplyPaths(text), ['E:\\dev\\out\\report.docx', '/tmp/data/result.json', 'output/lrc/sum.lean']);
  assert.deepEqual(extractReplyPaths('没有文件，只是讨论 docx 格式'), []);
});

test('effectToolTargets: successful file-writing calls only, first path key wins', () => {
  const targets = effectToolTargets([
    { toolName: 'writeFile', success: true, toolInput: { path: 'a.txt', content: 'x' } },
    { toolName: 'writeFile', success: false, toolInput: { path: 'b.txt', content: 'x' } },
    { toolName: 'downloadFile', success: true, toolInput: { url: 'http://x', dest: 'c.pdf' } },
    { toolName: 'readFile', success: true, toolInput: { path: 'd.txt' } },
    { toolName: 'shell', success: true, toolInput: { command: 'ls' } },
  ]);
  assert.deepEqual(targets, ['a.txt', 'c.pdf']);
});

test('structuralCheck: office containers, pdf, json — valid passes, broken is named', async () => {
  assert.equal(await structuralCheck(ok('good.docx', fakeDocx), fakeDocx.length), null);
  assert.match((await structuralCheck(ok('bad.docx', 'hello world'), 11))!, /not a zip container/);
  assert.match((await structuralCheck(ok('nocontent.xlsx', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(32)])), 36))!, /no \[Content_Types\]\.xml/);
  assert.equal(await structuralCheck(ok('good.pdf', fakePdf), fakePdf.length), null);
  assert.match((await structuralCheck(ok('trunc.pdf', '%PDF-1.7\n1 0 obj'), 16))!, /%%EOF/);
  assert.equal(await structuralCheck(ok('good.json', '{"a":1}'), 7), null);
  assert.match((await structuralCheck(ok('bad.json', '{"a":'), 5))!, /does not parse/);
  assert.equal(await structuralCheck(ok('plain.txt', 'anything'), 8), null, 'no structural rule for txt');
});

test('checkArtifacts: missing, empty, corrupt, fine; deleted-on-purpose paths are skipped', async () => {
  const fine = ok('fine.md', '# ok');
  const empty = ok('empty.csv', '');
  const bad = ok('bad2.docx', 'nope');
  const issues = await checkArtifacts([
    { path: fine, source: 'tool' },
    { path: empty, source: 'tool' },
    { path: bad, source: 'reply' },
    { path: join(dir, 'gone.pdf'), source: 'reply' },
    { path: join(dir, 'removed.txt'), source: 'tool' },
  ], { deleted: [join(dir, 'removed.txt')] });
  assert.deepEqual(issues.map((i) => [i.kind, i.source]), [['empty', 'tool'], ['corrupt', 'reply'], ['missing', 'reply']]);
});

test('checkTurnArtifacts: reply paths are checked only when an effect tool ran, never the owner\'s own path', async () => {
  const written = ok('w.txt', 'written');
  const missingReply = join(dir, 'claimed.docx');
  const ownerPath = join(dir, 'owner-asked.pdf');
  const withEffect = await checkTurnArtifacts({
    replyText: `已写入 ${written}，报告在 ${missingReply}，你问的 ${ownerPath} 不存在。`,
    records: [{ toolName: 'writeFile', success: true, toolInput: { path: written, content: 'written' } }],
    userMessage: `看看 ${ownerPath} 还在吗`,
  });
  assert.equal(withEffect.checked, 2);
  assert.deepEqual(withEffect.issues.map((i) => i.path), [missingReply]);
  const readOnly = await checkTurnArtifacts({
    replyText: `报告在 ${missingReply}`,
    records: [{ toolName: 'readFile', success: true, toolInput: { path: written } }],
  });
  assert.equal(readOnly.checked, 0, 'a turn that wrote nothing is not held to file claims');
});

test('the directive names each file and the honest way out', () => {
  const d = renderReadbackDirective([{ path: 'x.docx', kind: 'corrupt', detail: 'docx is not a zip container', source: 'tool' }]);
  assert.match(d, /^\[artifact-readback\]/);
  assert.match(d, /- x\.docx — docx is not a zip container \(written by a tool this turn\)/);
  assert.match(d, /say so plainly/);
});
