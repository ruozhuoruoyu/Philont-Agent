import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegexFloor, type SpecDoc } from '../src/spec_compile.js';

// Verbatim from the installed mycox spec.json: the LLM stated paths with :param (prose form), while the
// guide's curl examples use $VAR — the same endpoints written two ways.
const LLM_SPEC: SpecDoc = {
  source: { contentHash: '046ca80c9325e182' },
  service: { name: 'mycox', hosts: ['mycox.ai'] },
  basePath: '/api',
  auth: { scheme: 'bearer', header: 'Authorization' },
  endpoints: [
    { method: 'POST', path: '/api/posts/:public_id/upvote' },
    { method: 'POST', path: '/api/posts/:public_id/downvote' },
    { method: 'GET', path: '/api/agents/:actor_id/identity' },
    { method: 'PUT', path: '/api/agents/:actor_id/memories/:key' },
  ],
  preconditions: [],
  rules: [],
  confidence: 1,
};

const REGEX_SAME_ENDPOINTS_AS_SHELL_VARS = {
  hosts: ['mycox.ai'],
  endpoints: [
    'POST /api/posts/$PUBLIC_ID/upvote',
    'POST /api/posts/$PUBLIC_ID/downvote',
    'GET /api/agents/$ACTOR_ID/identity',
    'PUT /api/agents/$ACTOR_ID/memories/$KEY',
  ],
};

test('the same endpoint in :param and $VAR form is ONE endpoint — no phantom "LLM missed"', () => {
  const merged = mergeRegexFloor(LLM_SPEC, REGEX_SAME_ENDPOINTS_AS_SHELL_VARS as never);
  assert.equal(merged.endpoints.length, 4, 'must not duplicate endpoints the LLM already captured');
  assert.equal(
    merged.endpoints.filter((e) => /LLM missed/.test(e.purpose ?? '')).length,
    0,
    'nothing was missed, so nothing may be tagged as missed',
  );
});

test('confidence is not punished for phantoms (prod: a complete spec was driven 1.0 → 0.3)', () => {
  const merged = mergeRegexFloor(LLM_SPEC, REGEX_SAME_ENDPOINTS_AS_SHELL_VARS as never);
  assert.equal(merged.confidence, 1, 'a spec that missed nothing keeps full confidence');
});

test('a genuinely missed endpoint IS still merged and still costs confidence', () => {
  const merged = mergeRegexFloor(LLM_SPEC, {
    hosts: ['mycox.ai'],
    endpoints: ['GET /api/really/new/thing'],
  } as never);
  assert.equal(merged.endpoints.length, 5);
  assert.ok(merged.confidence < 1, 'a real miss must still lower confidence');
});
