import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specHostDriftGuard, clearSpecRegistryCache } from '../src/service_spec_registry.js';

function makeSkills(): string {
  const root = mkdtempSync(join(tmpdir(), 'spec-drift-'));
  const dir = join(root, 'acme-service');
  mkdirSync(dir);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({
    source: { contentHash: 'x' },
    service: { name: 'AcmeAPI', hosts: ['acme.test'] },
    endpoints: [{ method: 'POST', path: '/v1/verify' }],
    preconditions: [], rules: [], confidence: 0.9,
  }));
  clearSpecRegistryCache();
  return root;
}

test('specHostDriftGuard: flags a call to the wrong host when the path is documented elsewhere', () => {
  const root = makeSkills();
  // Model drifted to api.acme.test (no spec) but /v1/verify is documented on acme.test.
  const rej = specHostDriftGuard('POST', 'https://api.acme.test/v1/verify', root);
  assert.ok(rej && /acme\.test/.test(rej.error) && /wrong host/.test(rej.error));
});

test('specHostDriftGuard: no flag when the host IS the governed one', () => {
  const root = makeSkills();
  const rej = specHostDriftGuard('POST', 'https://acme.test/v1/verify', root);
  assert.equal(rej, null);
});

test('specHostDriftGuard: no flag for an unrelated host with no documented path', () => {
  const root = makeSkills();
  // Different domain family AND path not documented anywhere → nothing to say.
  const rej = specHostDriftGuard('GET', 'https://unrelated.example/v1/unknown', root);
  assert.equal(rej, null);
});

test('specHostDriftGuard: sibling host (api. prefix) fires even when method/path also wrong', () => {
  const root = makeSkills();
  // Model prepended api. AND used the wrong method+path — the family signal must still catch the host.
  const rej = specHostDriftGuard('GET', 'https://api.acme.test/v1/whatever', root);
  assert.ok(rej && /acme\.test/.test(rej.error) && /wrong host/.test(rej.error));
});
