/**
 * Diverge web-lookup cap — the mechanism backstop for a diverge round browsing instead of generating
 * candidates (observed: 10 web calls, 0 tree commits, round cut for no progress).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWebCallCap } from '../src/deep_explore.js';

const WEB = new Set(['webSearch', 'webFetch']);

test('withWebCallCap: allows `cap` web calls, then blocks with a decompose directive', async () => {
  const seen: string[] = [];
  const base = async (name: string) => { seen.push(name); return { ok: true, output: `ran ${name}` }; };
  const runner = withWebCallCap(base, { cap: 2, webTools: WEB });

  assert.match((await runner('webSearch', {})).output, /ran webSearch/);
  assert.match((await runner('webFetch', {})).output, /ran webFetch/);
  const blocked = await runner('webSearch', {});
  assert.match(blocked.output, /STOP searching/);
  assert.match(blocked.output, /reason_decompose/);
  // non-web tools always pass, even after the web cap is hit
  assert.match((await runner('reason_decompose', {})).output, /ran reason_decompose/);
  assert.deepEqual(seen, ['webSearch', 'webFetch', 'reason_decompose'], 'blocked web call never reached base');
});

test('withWebCallCap: cap=0 blocks web immediately; non-web unaffected', async () => {
  const runner = withWebCallCap(async (n: string) => ({ ok: true, output: `ran ${n}` }), { cap: 0, webTools: WEB });
  assert.match((await runner('webSearch', {})).output, /STOP searching/);
  assert.match((await runner('reason_record', {})).output, /ran reason_record/);
});

import { webDedupEnabled, webDedupKey } from '../src/deep_explore.js';

test('webDedupEnabled: default ON, =0 off', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_WEB_DEDUP;
  try {
    delete process.env.PHILONT_DEEP_EXPLORE_WEB_DEDUP;
    assert.equal(webDedupEnabled(), true);
    process.env.PHILONT_DEEP_EXPLORE_WEB_DEDUP = '0';
    assert.equal(webDedupEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_WEB_DEDUP;
    else process.env.PHILONT_DEEP_EXPLORE_WEB_DEDUP = prev;
  }
});

test('webDedupKey: normalizes fetch URL (#/?/trailing-slash collapse, version stays distinct)', () => {
  assert.equal(
    webDedupKey('webFetch', { url: 'https://arxiv.org/html/2506.12708v3/' }),
    webDedupKey('webFetch', { url: 'https://ARXIV.org/html/2506.12708v3#S3.SS3' }),
    'same page, different fragment/case/slash → same key',
  );
  assert.notEqual(
    webDedupKey('webFetch', { url: 'https://arxiv.org/html/2506.12708' }),
    webDedupKey('webFetch', { url: 'https://arxiv.org/html/2506.12708v3' }),
    'different version = different document → distinct',
  );
});

test('webDedupKey: normalizes search query (case/whitespace); null for non-web / empty', () => {
  assert.equal(
    webDedupKey('webSearch', { query: 'CloudMatrix-Infer  arxiv 2506.12708' }),
    webDedupKey('webSearch', { query: 'cloudmatrix-infer arxiv 2506.12708' }),
  );
  assert.equal(webDedupKey('reason_decompose', { parentNodeId: 'n1' }), null);
  assert.equal(webDedupKey('webFetch', {}), null);
  assert.equal(webDedupKey('webSearch', { query: '   ' }), null);
});
