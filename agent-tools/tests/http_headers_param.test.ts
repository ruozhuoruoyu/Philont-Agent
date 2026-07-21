/**
 * coerceHeadersParam — the `headers` parameter itself, as opposed to one header's NAME.
 *
 * Prod 2026-07-21: the model passed headers as a JSON *string* (symmetrically with `body`, which has
 * accepted both forms for months). Object.entries of a string yields index→character pairs, so the
 * request went out with ~45 headers named "0","1","2"… and no Authorization — and the service answered
 * 401 UNAUTHORIZED. An authentication error for a request that carried no credential is close to
 * undebuggable from the model's side, because the error text points at the credential: it retried the
 * same shape three times, fell back to GET (404), tripped the in-turn tool block, spawned a placeholder
 * plan and finally fabricated a recovery claim that fired the honesty gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceHeadersParam } from '../src/index.js';

const ok = (r: ReturnType<typeof coerceHeadersParam>) => {
  assert.ok(!('error' in r), `expected success, got: ${'error' in r ? r.error : ''}`);
  return (r as { headers: Record<string, unknown> }).headers;
};

test('the prod shape: a JSON string is parsed, not spread into characters', () => {
  const raw = '{"Authorization": "Bearer {mycox-api-key}"}';
  const headers = ok(coerceHeadersParam(raw));
  assert.deepEqual(headers, { Authorization: 'Bearer {mycox-api-key}' });
  // The exact regression: the placeholder must survive as a header VALUE so credential injection can
  // see it. Character-spreading produced keys "0","1",… and no Authorization at all.
  assert.equal(Object.keys(headers).length, 1);
  assert.ok(!('0' in headers), 'must not be spread by index');
});

test('an object is passed through untouched (the normal path is unchanged)', () => {
  const obj = { Authorization: 'Bearer x', 'X-Actor-Id': 'a' };
  assert.deepEqual(ok(coerceHeadersParam(obj)), obj);
});

test('absent / empty means no headers, not an error', () => {
  assert.deepEqual(ok(coerceHeadersParam(undefined)), {});
  assert.deepEqual(ok(coerceHeadersParam(null)), {});
  assert.deepEqual(ok(coerceHeadersParam('')), {});
  assert.deepEqual(ok(coerceHeadersParam('   ')), {});
});

test('a shape that cannot be headers fails fast, naming the shape', () => {
  // Failing loudly beats sending an unauthenticated request: the 401 blames the credential and sends
  // the model off re-checking a key that was never at fault.
  for (const bad of ['not json at all', '"just a string"', '[1,2,3]', '42', [1, 2], 7, true]) {
    const r = coerceHeadersParam(bad);
    assert.ok('error' in r, `expected an error for ${JSON.stringify(bad)}`);
    assert.match((r as { error: string }).error, /OBJECT/, 'the message must say what shape is wanted');
  }
});

test('the error text shows the correct call, since that is what the model will copy', () => {
  const r = coerceHeadersParam('nope');
  assert.ok('error' in r);
  assert.match((r as { error: string }).error, /\{"Authorization"/, 'must show a concrete example');
});
