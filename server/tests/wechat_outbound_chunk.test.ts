import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── chunkMarkdownBytes: WeChat rejects by BYTES, not chars (prod: 1560-char CJK reply → ret=-2) ──
import { chunkMarkdownBytes, TEXT_CHUNK_BYTE_LIMIT } from '../src/channels/wechat/outbound.js';

test('chunkMarkdownBytes: CJK text under the char limit but over the byte limit gets split', () => {
  const cjk = '哥德巴赫猜想的证明研究进展。'.repeat(120); // ~1680 chars ≈ 5KB UTF-8, < 4000 chars
  assert.ok(cjk.length < 4000, 'under char limit');
  assert.ok(Buffer.byteLength(cjk, 'utf8') > TEXT_CHUNK_BYTE_LIMIT, 'over byte limit');
  const chunks = chunkMarkdownBytes(cjk);
  assert.ok(chunks.length >= 2, 'must be split');
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= TEXT_CHUNK_BYTE_LIMIT, `chunk ${Buffer.byteLength(c, 'utf8')}B exceeds byte limit`);
  }
  assert.equal(chunks.join(''), cjk, 'lossless');
});

test('chunkMarkdownBytes: ASCII under both limits passes through as one chunk', () => {
  const ascii = 'hello world. '.repeat(100);
  assert.deepEqual(chunkMarkdownBytes(ascii), [ascii]);
});
