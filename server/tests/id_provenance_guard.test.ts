import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idProvenanceReject, type SpecDoc } from '../src/plan_execute_loop.js';

const SPEC = {
  source: { contentHash: 'x' },
  service: { name: 'svc', hosts: ['svc.test'] },
  endpoints: [
    { method: 'GET', path: '/api/communities' },
    { method: 'POST', path: '/api/posts' },
  ],
  preconditions: [], rules: [], confidence: 0.9,
} as unknown as SpecDoc;

const POST_GENERAL = {
  method: 'POST',
  url: 'https://svc.test/api/posts',
  body: { community_id: 'general', title: 'Hi', body: '...' },
};

test('blocks an invented community_id never read this turn (prod: "general")', () => {
  const rej = idProvenanceReject(POST_GENERAL, ['task text with no ids'], SPEC);
  assert.ok(rej && /community_id/.test(rej.error) && /GET \/api\/communities/.test(rej.error));
});

test('allows the id when it was read from a response this turn', () => {
  const corpus = ['task', '{"communities":[{"id":"01926abc-real","name":"General"}]}'];
  const ok = { ...POST_GENERAL, body: { community_id: '01926abc-real', title: 'Hi', body: '...' } };
  assert.equal(idProvenanceReject(ok, corpus, SPEC), null);
});

test('allows the id when the user gave it in the task', () => {
  const ok = { ...POST_GENERAL, body: { community_id: 'c-from-user', title: 'Hi', body: '...' } };
  assert.equal(idProvenanceReject(ok, ['post to community c-from-user please'], SPEC), null);
});

test('allows the id when it came from a get_fact result this turn', () => {
  const corpus = ['task', 'project.svc.community_id = "c-remembered" [state ...]'];
  const ok = { ...POST_GENERAL, body: { community_id: 'c-remembered', title: 'Hi', body: '...' } };
  assert.equal(idProvenanceReject(ok, corpus, SPEC), null);
});

test('ignores non-id fields and reads', () => {
  // title is invented but it is not an identifier — not our business
  assert.equal(idProvenanceReject({ method: 'POST', url: 'https://svc.test/api/posts', body: { title: 'anything', body: 'x' } }, ['t'], SPEC), null);
  // GET is a read, never blocked
  assert.equal(idProvenanceReject({ method: 'GET', url: 'https://svc.test/api/posts?community_id=made-up' }, ['t'], SPEC), null);
});

test('stringified JSON body is parsed and checked', () => {
  const rej = idProvenanceReject(
    { method: 'POST', url: 'https://svc.test/api/posts', body: JSON.stringify({ community_id: 'invented', title: 'x', body: 'y' }) },
    ['t'], SPEC,
  );
  assert.ok(rej && /community_id/.test(rej.error));
});

test('trivial short values are not policed (avoids noise)', () => {
  assert.equal(idProvenanceReject({ method: 'POST', url: 'https://svc.test/api/posts', body: { post_id: '3' } }, ['t'], SPEC), null);
});
