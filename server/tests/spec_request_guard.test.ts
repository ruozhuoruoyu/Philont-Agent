import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specRequestGuard, type SpecDoc } from '../src/spec_compile.js';

// A synthetic contract for an arbitrary service — proves the guard is spec-driven, not service-specific.
const SPEC: SpecDoc = {
  source: { contentHash: 'x' },
  service: { name: 'AcmeAPI', hosts: ['api.acme.test'] },
  auth: { scheme: 'bearer', header: 'X-Acme-Key' },
  endpoints: [
    { method: 'GET', path: '/v1/items', auth: 'required' },
    { method: 'POST', path: '/v1/items', requiredFields: ['title'], auth: 'required' },
    { method: 'GET', path: '/v1/items/:id', auth: 'required' },
  ],
  preconditions: [],
  rules: [],
  confidence: 0.9,
};

test('specRequestGuard: blocks a call missing the auth header its endpoint contract requires', () => {
  const rej = specRequestGuard({ method: 'GET', url: 'https://api.acme.test/v1/items', headers: {} }, SPEC);
  assert.ok(rej && /X-Acme-Key/.test(rej.error));
});

test('specRequestGuard: allows a call that carries the auth header + documented endpoint', () => {
  const rej = specRequestGuard(
    { method: 'GET', url: 'https://api.acme.test/v1/items', headers: { 'X-Acme-Key': 'k' } },
    SPEC,
  );
  assert.equal(rej, null);
});

test('specRequestGuard: param segment endpoint matches', () => {
  const rej = specRequestGuard(
    { method: 'GET', url: 'https://api.acme.test/v1/items/abc123', headers: { 'X-Acme-Key': 'k' } },
    SPEC,
  );
  assert.equal(rej, null);
});

test('specRequestGuard: blocks an undocumented endpoint and names the documented ones', () => {
  const rej = specRequestGuard(
    { method: 'GET', url: 'https://api.acme.test/v1/feed/hot', headers: { 'X-Acme-Key': 'k' } },
    SPEC,
  );
  assert.ok(rej && /not a documented endpoint/.test(rej.error) && /GET \/v1\/items/.test(rej.error));
});

test('specRequestGuard: ignores a host the spec does not govern (no false block)', () => {
  const rej = specRequestGuard({ method: 'GET', url: 'https://other.test/anything', headers: {} }, SPEC);
  assert.equal(rej, null);
});







// The contract, not the path name, decides whether an endpoint carries the credential.
test('specRequestGuard: an endpoint the contract marks auth:none is never asked for a credential', () => {
  // The endpoint that ISSUES the credential — its guide example shows no auth header. Its PATH is
  // deliberately not register/login/token-shaped: the guard must read the contract, not the vocabulary.
  const rej = specRequestGuard(
    { method: 'POST', url: 'https://api.acme.test/v1/provisioning/onboard', headers: {}, body: { invite: 'x' } },
    { ...SPEC, endpoints: [...SPEC.endpoints, { method: 'POST', path: '/v1/provisioning/onboard', auth: 'none' }] },
  );
  assert.equal(rej, null, 'a contract that says auth:none must never be second-guessed by path vocabulary');
});

test('specRequestGuard: an endpoint the contract marks auth:required IS asked for the credential', () => {
  const rej = specRequestGuard(
    { method: 'POST', url: 'https://api.acme.test/v1/items', headers: {}, body: { title: 't' } },
    SPEC,
  );
  assert.ok(rej && /X-Acme-Key/.test(rej.error) && /documented as requiring/.test(rej.error));
});

test('specRequestGuard: an UNKNOWN auth mark (older spec) demands nothing — no check beats a wrong one', () => {
  const noMarks = { ...SPEC, endpoints: SPEC.endpoints.map(({ auth, ...e }) => e) };
  const rej = specRequestGuard(
    { method: 'POST', url: 'https://api.acme.test/v1/items', headers: {}, body: { title: 't' } },
    noMarks,
  );
  assert.equal(rej, null, 'without contract auth facts the guard must not invent a requirement');
});
