import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specEndpointForDeliverable, endpointMatches, type SpecDoc } from '../src/spec_compile.js';
import { ENDPOINT_HINTS, callMatchesHint } from '../src/plan_execute_loop.js';

// A freshly compiled spec that FAILED to base-resolve its paths (prod 2026-07-20, confidence 0.30).
const UNRESOLVED_SPEC = {
  source: { contentHash: 'h' },
  service: { name: 'svc', hosts: ['svc.test'] },
  endpoints: [
    { method: 'POST', path: '/auth/verify', purpose: 'check API key validity' },
    { method: 'POST', path: '/auth/register-agent', purpose: 'register agent with invite code' },
    { method: 'POST', path: '/posts/:public_id/upvote', purpose: 'upvote a post (toggle)' },
  ],
  preconditions: [], rules: [], confidence: 0.3,
} as unknown as SpecDoc;

/** Mirrors the union the loop builds: spec-endpoint match OR keyword-hint match. */
function matches(spec: SpecDoc | null, dText: string, url: string, method: string): boolean {
  const ep = specEndpointForDeliverable(spec, dText);
  const hint = ENDPOINT_HINTS.find(([k]) => k.test(dText))?.[1];
  const pathname = new URL(url).pathname;
  const bySpec = (() => {
    if (!ep || method.toUpperCase() !== ep.method) return false;
    if (endpointMatches(ep, ep.method, pathname)) return true;
    const segs = pathname.split('/').filter(Boolean);
    const want = ep.path.split('/').filter(Boolean).length;
    return want > 0 && want < segs.length
      ? endpointMatches(ep, ep.method, `/${segs.slice(segs.length - want).join('/')}`)
      : false;
  })();
  const byHint = !!hint && callMatchesHint(hint, url, 'http');
  return bySpec || byHint;
}

test('a successful verify counts even when the contract omitted the base prefix (prod false-FAILED)', () => {
  // The spec says /auth/verify; the real call is /api/auth/verify. Two successful verifies were reported
  // FAILED because exact path matching missed them.
  assert.equal(
    matches(UNRESOLVED_SPEC, 'Verify the API key is valid', 'https://svc.test/api/auth/verify', 'POST'),
    true,
  );
});

test('a completed registration counts — it must not be retried into a 409 that burns the invite', () => {
  assert.equal(
    matches(UNRESOLVED_SPEC, 'Register the agent with the invite code', 'https://svc.test/api/auth/register-agent', 'POST'),
    true,
  );
});

test('the upvote case the keyword table alone gets wrong still works', () => {
  assert.equal(
    matches(UNRESOLVED_SPEC, 'Upvote posts worth engaging with', 'https://svc.test/api/posts/abc/upvote', 'POST'),
    true,
  );
});

test('the union never vetoes: whatever the keyword table matched before still matches', () => {
  // No spec at all → pure keyword behaviour, unchanged.
  assert.equal(matches(null, 'Verify the API key', 'https://svc.test/api/auth/verify', 'POST'), true);
  assert.equal(matches(null, 'Publish a post', 'https://svc.test/api/posts', 'POST'), true);
});

test('an unrelated call still does not count', () => {
  assert.equal(matches(UNRESOLVED_SPEC, 'Verify the API key is valid', 'https://svc.test/api/posts', 'POST'), false);
});
