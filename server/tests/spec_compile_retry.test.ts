import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { compileSpec, clearSpecCache, type SpecDoc } from '../src/spec_compile.js';
import type { GuideApi } from '../src/plan_execute_loop.js';
import { AuxLLMError } from '@agent/tools';

// Exercises the compile subsystem, which is opt-in by default (see specCompileEnabled).
beforeEach(() => { process.env.PHILONT_SPEC_COMPILE = '1'; });
const GUIDE = 'POST /api/things — create a thing. Host: api.acme.test';
const REGEX_API: GuideApi = { hosts: ['api.acme.test'], endpoints: ['POST /api/things'], authPaths: [] } as unknown as GuideApi;

const GOOD = JSON.stringify({
  service: { name: 'Acme', hosts: ['api.acme.test'] },
  auth: { scheme: 'bearer', header: 'Authorization' },
  endpoints: [{ method: 'POST', path: '/api/things', purpose: 'create', requiredFields: ['title'] }],
  preconditions: [], rules: [], confidence: 0.9,
});

test('spec-compile passes a timeout well above the aux 60s chat default', async () => {
  clearSpecCache();
  let seenTimeout: number | undefined;
  await compileSpec(GUIDE, REGEX_API, { call: async (req) => { seenTimeout = req.timeoutMs; return GOOD; } });
  assert.ok(seenTimeout && seenTimeout > 60_000, `expected >60s compile timeout, got ${seenTimeout}`);
});

test('a TRANSIENT compile failure (aux timeout) is not cached — the next read retries and can recover', async () => {
  clearSpecCache();
  let calls = 0;
  const deps = {
    call: async () => {
      calls++;
      if (calls === 1) throw new AuxLLMError('Aux LLM request timed out after 60000ms', 'timeout');
      return GOOD;
    },
  };
  const first = await compileSpec(GUIDE, REGEX_API, deps);
  assert.equal(first, null, 'transient failure yields null');
  const second = await compileSpec(GUIDE, REGEX_API, deps);
  assert.equal(calls, 2, 'must retry after a transient failure, not serve a cached null');
  assert.ok(second && (second as SpecDoc).service.hosts.includes('api.acme.test'), 'retry recovers the spec');
});

test('a deterministic validation failure IS cached — no pointless retry loop', async () => {
  clearSpecCache();
  let calls = 0;
  const deps = { call: async () => { calls++; return '{"garbage":true}'; } };
  await compileSpec(GUIDE, REGEX_API, deps);
  await compileSpec(GUIDE, REGEX_API, deps);
  assert.equal(calls, 1, 'validation failure is deterministic → cached, not retried');
});

test('an unparseable model output is cached — retrying the same guide cannot help', async () => {
  clearSpecCache();
  let calls = 0;
  const deps = { call: async () => { calls++; return 'sorry, I cannot do that'; } };
  await compileSpec(GUIDE, REGEX_API, deps);
  await compileSpec(GUIDE, REGEX_API, deps);
  assert.equal(calls, 1, 'model-output failure is deterministic → cached, not retried');
});
