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

import {
  webDedupEnabled,
  webDedupKey,
  searchNearDupEnabled,
  searchNearDupKey,
  deliberateSoftAnswerEnabled,
} from '../src/deep_explore.js';

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

test('searchNearDupKey: reworded query with same key terms → same key (year/order/stopword-insensitive)', () => {
  // The production log's actual repeats: same PFR question, different wording each round.
  assert.equal(
    searchNearDupKey('webSearch', { query: 'Terence Tao PFR formalization Lean 2024 2025 Polynomial Freiman Ruzsa' }),
    searchNearDupKey('webSearch', { query: 'Polynomial Freiman-Ruzsa PFR Lean formalization of Tao Terence' }),
    'same significant terms, different order/year → collapse',
  );
  // Adding a genuinely new subject term keeps it distinct (do not over-block refinement).
  assert.notEqual(
    searchNearDupKey('webSearch', { query: 'Goldbach conjecture Lean mathlib' }),
    searchNearDupKey('webSearch', { query: 'Goldbach conjecture Lean mathlib DeepSeek prover' }),
    'a new discriminating term → distinct query, not blocked',
  );
  // But it must NOT collapse two genuinely different questions that share one word.
  assert.notEqual(
    searchNearDupKey('webSearch', { query: 'Lean software verification industry' }),
    searchNearDupKey('webSearch', { query: 'Lean mathematics formalization number theory' }),
  );
  assert.equal(searchNearDupKey('webFetch', { url: 'https://x' }), null, 'fetch is exact-keyed, not near-dup');
  assert.equal(searchNearDupKey('webSearch', { query: '2024 the latest' }), null, 'only stopwords/years → null');
});

test('searchNearDupEnabled / deliberateSoftAnswerEnabled: default ON, =off disables', () => {
  for (const [envVar, fn] of [
    ['PHILONT_DEEP_EXPLORE_SEARCH_NEARDUP', searchNearDupEnabled],
    ['PHILONT_DEEP_EXPLORE_SOFT_ANSWER', deliberateSoftAnswerEnabled],
  ] as const) {
    const prev = process.env[envVar];
    try {
      delete process.env[envVar];
      assert.equal(fn(), true, `${envVar} default ON`);
      process.env[envVar] = 'off';
      assert.equal(fn(), false, `${envVar}=off disables`);
    } finally {
      if (prev === undefined) delete process.env[envVar];
      else process.env[envVar] = prev;
    }
  }
});
