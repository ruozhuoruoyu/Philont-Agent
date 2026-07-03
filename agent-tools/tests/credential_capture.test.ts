/**
 * Mechanism-layer credential auto-capture — prod: register api_key could not be saved on
 * autonomous turns (saveCredential blacklisted) → every later http 401'd.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCapturableCredential } from '../src/network/credential_capture.js';

const KEY = 'exampleservice_c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';

test('mycox register response → captured under service-derived ids incl. {mycox-api-key}', () => {
  const body = JSON.stringify({ actor_id: 'a-1', handle: 'agent-x', api_key: KEY });
  const cap = extractCapturableCredential('https://mycox.ai/api/auth/register-agent', 'POST', body);
  assert.ok(cap, 'should capture');
  assert.equal(cap!.value, KEY);
  assert.ok(cap!.ids.includes('mycox-api-key'), `ids=${cap!.ids}`); // matches the placeholder the model writes
});

test('token nested under data + wrapper; api.<svc> host drops the api label', () => {
  const body = JSON.stringify({ status: 'ok', data: { access_token: KEY } });
  const cap = extractCapturableCredential('https://api.foo.com/v1/auth/login', 'POST', body);
  assert.ok(cap);
  assert.ok(cap!.ids.includes('foo-api-key'));
  assert.ok(cap!.ids.includes('foo-token'));
});

test('non-auth endpoint is NOT harvested even if body has a token', () => {
  const body = JSON.stringify({ token: KEY });
  assert.equal(extractCapturableCredential('https://mycox.ai/api/posts', 'POST', body), null);
});

test('GET / non-JSON / short value → no capture', () => {
  const body = JSON.stringify({ api_key: KEY });
  assert.equal(extractCapturableCredential('https://mycox.ai/api/auth/verify', 'GET', body), null);
  assert.equal(extractCapturableCredential('https://mycox.ai/api/auth/register', 'POST', 'not json'), null);
  assert.equal(
    extractCapturableCredential('https://mycox.ai/api/auth/register', 'POST', JSON.stringify({ api_key: 'short' })),
    null,
  );
});
