/**
 * Spec compiler tests — validation, regex floor merge, caching, graceful degradation.
 * The model understands prose; the mechanism validates truth (docs/design/spec_regime.md).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSpec,
  mergeRegexFloor,
  specToGuideApi,
  clearSpecCache,
  guideContentHash,
  type SpecDoc,
} from '../src/spec_compile.js';

const GUIDE = 'export BASE_URL="https://mycox.ai/api"\n| `/comments` | POST |\ncurl -s "$BASE_URL/stats"';

const GOOD_JSON = JSON.stringify({
  service: { name: 'mycox', hosts: ['mycox.ai'] },
  basePath: '/api',
  auth: { scheme: 'bearer', header: 'Authorization' },
  endpoints: [
    { method: 'POST', path: '/api/comments', purpose: 'create comment', requiredFields: ['post_id', 'body'] },
    { method: 'GET', path: '/api/stats' },
    { method: 'BOGUS', path: '/api/x' }, // illegal method → dropped
    { method: 'GET', path: 'no-slash' }, // relative path → dropped
  ],
  preconditions: ['first session must publish one post'],
  rules: ['no content-free comments'],
});

const REGEX_API = { hosts: ['mycox.ai'], endpoints: ['POST /api/comments', 'GET /api/stats'] };

beforeEach(() => clearSpecCache());

test('compileSpec: validates shape, drops illegal entries, reports via log', async () => {
  const logs: string[] = [];
  const spec = await compileSpec(GUIDE, REGEX_API, { call: async () => GOOD_JSON, log: (m) => logs.push(m) });
  assert.ok(spec);
  assert.deepEqual(spec!.service.hosts, ['mycox.ai']);
  assert.equal(spec!.endpoints.length, 2, 'illegal method and relative path must be dropped');
  assert.deepEqual(spec!.endpoints[0], {
    method: 'POST', path: '/api/comments', purpose: 'create comment', requiredFields: ['post_id', 'body'],
  });
  assert.equal(spec!.preconditions[0], 'first session must publish one post');
  assert.ok(logs.some((l) => l.includes('[spec-compile]') && l.includes('endpoints=2')));
});

test('compileSpec: markdown-fenced JSON is tolerated', async () => {
  const spec = await compileSpec(GUIDE, REGEX_API, { call: async () => '```json\n' + GOOD_JSON + '\n```' });
  assert.ok(spec);
});

test('compileSpec: junk / unusable output → null (regex anchor kept), cached per hash', async () => {
  let calls = 0;
  const call = async () => { calls++; return 'sorry, I cannot do that'; };
  assert.equal(await compileSpec(GUIDE, REGEX_API, { call }), null);
  assert.equal(await compileSpec(GUIDE, REGEX_API, { call }), null);
  assert.equal(calls, 1, 'a failed compile must not be retried for the same guide version');
  // No-endpoint output is also unusable.
  clearSpecCache();
  const empty = await compileSpec(GUIDE, REGEX_API, {
    call: async () => JSON.stringify({ service: { name: 'x', hosts: ['x.ai'] }, endpoints: [] }),
  });
  assert.equal(empty, null);
});

test('compileSpec: cache hit for a successful compile — one LLM call per guide version', async () => {
  let calls = 0;
  const call = async () => { calls++; return GOOD_JSON; };
  const a = await compileSpec(GUIDE, REGEX_API, { call });
  const b = await compileSpec(GUIDE, REGEX_API, { call });
  assert.ok(a && b);
  assert.equal(calls, 1);
  // Different guide content → different hash → recompile.
  await compileSpec(GUIDE + '\nchanged', REGEX_API, { call });
  assert.equal(calls, 2);
  assert.notEqual(guideContentHash(GUIDE), guideContentHash(GUIDE + '\nchanged'));
});

test('mergeRegexFloor: regex hits the LLM missed are merged in and confidence drops', () => {
  const spec: SpecDoc = {
    source: { contentHash: 'h' },
    service: { name: 'mycox', hosts: ['mycox.ai'] },
    endpoints: [{ method: 'POST', path: '/api/comments' }],
    preconditions: [], rules: [], confidence: 1,
  };
  const merged = mergeRegexFloor(spec, {
    hosts: ['mycox.ai'],
    endpoints: ['POST /api/comments', 'GET /api/stats', '/api'], // bare path (no method) is not mergeable
  });
  assert.equal(merged.endpoints.length, 2);
  assert.equal(merged.endpoints[1].path, '/api/stats');
  assert.match(merged.endpoints[1].purpose ?? '', /regex/);
  assert.ok(merged.confidence < 1);
  // Nothing missing → same object, confidence intact.
  const same = mergeRegexFloor(merged, { hosts: ['mycox.ai'], endpoints: ['POST /api/comments'] });
  assert.equal(same.endpoints.length, 2);
});

test('specToGuideApi: adapter emits the METHOD /path strings the guards consume', () => {
  const spec: SpecDoc = {
    source: { contentHash: 'h' },
    service: { name: 'mycox', hosts: ['mycox.ai'] },
    endpoints: [
      { method: 'POST', path: '/api/auth/verify' },
      { method: 'POST', path: '/api/comments' },
    ],
    preconditions: [], rules: [], confidence: 1,
  };
  const api = specToGuideApi(spec);
  assert.deepEqual(api.hosts, ['mycox.ai']);
  assert.deepEqual(api.endpoints, ['POST /api/auth/verify', 'POST /api/comments']);
});

test('compileSpec: kill switch PHILONT_SPEC_COMPILE=0 → null without calling the LLM', async () => {
  const saved = process.env.PHILONT_SPEC_COMPILE;
  process.env.PHILONT_SPEC_COMPILE = '0';
  try {
    let calls = 0;
    const spec = await compileSpec(GUIDE, REGEX_API, { call: async () => { calls++; return GOOD_JSON; } });
    assert.equal(spec, null);
    assert.equal(calls, 0);
  } finally {
    if (saved === undefined) delete process.env.PHILONT_SPEC_COMPILE;
    else process.env.PHILONT_SPEC_COMPILE = saved;
  }
});

test('specBodyGuardReject: corrects non-JSON and incomplete write bodies on documented endpoints', async () => {
  const { specBodyGuardReject } = await import('../src/spec_compile.js');
  const spec: SpecDoc = {
    source: { contentHash: 'h' },
    service: { name: 'mycox', hosts: ['mycox.ai'] },
    endpoints: [
      { method: 'POST', path: '/api/posts', requiredFields: ['community_id', 'title', 'body'] },
      { method: 'POST', path: '/api/posts/:public_id/upvote' },
    ],
    preconditions: [], rules: [], confidence: 1,
  };
  // Prod shape: raw markdown string as body → rejected naming the documented fields.
  const raw = specBodyGuardReject('http', {
    url: 'https://mycox.ai/api/posts', method: 'POST', body: '# My Post\n\nlots of markdown…',
  }, spec);
  assert.ok(raw);
  assert.match(raw!.error, /JSON OBJECT/);
  assert.match(raw!.error, /community_id.*title.*body/s);
  // Missing documented field → rejected naming the gap.
  const missing = specBodyGuardReject('http', {
    url: 'https://mycox.ai/api/posts', method: 'POST', body: { title: 't', body: 'b' },
  }, spec);
  assert.ok(missing);
  assert.match(missing!.error, /missing documented required field\(s\): community_id/);
  // Complete object body (or its JSON string form) passes.
  assert.equal(specBodyGuardReject('http', {
    url: 'https://mycox.ai/api/posts', method: 'POST', body: { community_id: 'c', title: 't', body: 'b' },
  }, spec), null);
  assert.equal(specBodyGuardReject('http', {
    url: 'https://mycox.ai/api/posts', method: 'POST', body: '{"community_id":"c","title":"t","body":"b"}',
  }, spec), null);
  // Param-path endpoint without documented fields: bodyless POST passes; GET / other hosts / undocumented paths ignored.
  assert.equal(specBodyGuardReject('http', { url: 'https://mycox.ai/api/posts/05f3693d/upvote', method: 'POST' }, spec), null);
  assert.equal(specBodyGuardReject('http', { url: 'https://mycox.ai/api/posts', method: 'GET' }, spec), null);
  assert.equal(specBodyGuardReject('http', { url: 'https://other.io/api/posts', method: 'POST', body: 'x' }, spec), null);
  assert.equal(specBodyGuardReject('http', { url: 'https://mycox.ai/api/unknown', method: 'POST', body: 'x' }, spec), null);
});
