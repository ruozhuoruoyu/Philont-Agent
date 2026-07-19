import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specEndpointForDeliverable, type SpecDoc } from '../src/spec_compile.js';

// Verbatim shape from the installed mycox spec: the service's OWN purposes.
const SPEC = {
  source: { contentHash: 'h' },
  service: { name: 'svc', hosts: ['svc.test'] },
  basePath: '/api',
  endpoints: [
    { method: 'POST', path: '/api/auth/register-agent', purpose: 'register agent with invite code' },
    { method: 'POST', path: '/api/posts', purpose: 'create a new post' },
    { method: 'GET', path: '/api/posts', purpose: 'list posts feed' },
    { method: 'POST', path: '/api/comments', purpose: 'create a comment or reply' },
    { method: 'POST', path: '/api/posts/:public_id/upvote', purpose: 'upvote a post (toggle)' },
    { method: 'POST', path: '/api/posts/:public_id/downvote', purpose: 'downvote a post (toggle)' },
  ],
  preconditions: [], rules: [], confidence: 1,
} as unknown as SpecDoc;

test('resolves the UPVOTE deliverable the keyword table got wrong (prod false-FAILED)', () => {
  // "Upvote" does not match \bvote\b, so the table fell through to the posts-collection hint and reported
  // two SUCCESSFUL upvotes as a failure. The service's own purpose says "upvote a post".
  const ep = specEndpointForDeliverable(SPEC, 'Upvote posts worth engaging with');
  assert.ok(ep, 'must resolve');
  assert.equal(ep!.path, '/api/posts/:public_id/upvote');
  assert.equal(ep!.method, 'POST');
});

test('never resolves an action deliverable to a READ endpoint', () => {
  // GET /api/posts ("list posts feed") must not answer "publish a post".
  const ep = specEndpointForDeliverable(SPEC, 'Publish a new post to the feed');
  if (ep) assert.notEqual(ep.method, 'GET');
});

test('declines when ambiguous rather than guessing — caller keeps its keyword table', () => {
  // Shares only the generic word "post" with several endpoints → no confident winner.
  assert.equal(specEndpointForDeliverable(SPEC, 'Publish the first substantive post'), null);
});

test('declines on a weak/unrelated deliverable', () => {
  assert.equal(specEndpointForDeliverable(SPEC, 'Read SOUL.md in full'), null);
  assert.equal(specEndpointForDeliverable(null, 'anything'), null);
  assert.equal(specEndpointForDeliverable({ ...SPEC, endpoints: [] } as SpecDoc, 'upvote a post'), null);
});

test('resolves a register deliverable to the register endpoint', () => {
  const ep = specEndpointForDeliverable(SPEC, 'Register the agent using the invite code');
  assert.ok(ep && /register/.test(ep.path));
});
