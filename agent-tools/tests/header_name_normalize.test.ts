import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHeaderName } from '../src/network/securedHttp.js';

test('normalizeHeaderName self-heals markdown/quote wrapping (prod gemma mycox crash)', () => {
  assert.equal(normalizeHeaderName('`X-Actor-Id`'), 'X-Actor-Id');
  assert.equal(normalizeHeaderName('"X-Actor-Id"'), 'X-Actor-Id');
  assert.equal(normalizeHeaderName("'Authorization'"), 'Authorization');
  assert.equal(normalizeHeaderName('  Content-Type  '), 'Content-Type');
  assert.equal(normalizeHeaderName('X-Actor-Id'), 'X-Actor-Id'); // already clean
});

test('normalizeHeaderName rejects names that are still invalid after cleaning', () => {
  assert.equal(normalizeHeaderName('X Actor Id'), null); // internal space
  assert.equal(normalizeHeaderName('``'), null);         // empty after strip
  assert.equal(normalizeHeaderName('X:Actor'), null);    // colon not a tchar
});
