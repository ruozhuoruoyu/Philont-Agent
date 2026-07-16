import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specRequestGuard, type SpecDoc } from '../src/spec_compile.js';

// A synthetic contract for an arbitrary service — proves the guard is spec-driven, not service-specific.
const SPEC: SpecDoc = {
  source: { contentHash: 'x' },
  service: { name: 'AcmeAPI', hosts: ['api.acme.test'] },
  auth: { scheme: 'bearer', header: 'X-Acme-Key' },
  endpoints: [
    { method: 'GET', path: '/v1/items' },
    { method: 'POST', path: '/v1/items', requiredFields: ['title'] },
    { method: 'GET', path: '/v1/items/:id' },
  ],
  preconditions: [],
  rules: [],
  confidence: 0.9,
};

test('specRequestGuard: blocks a call missing the documented auth header', () => {
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
