/**
 * The gate between the timeline and an outbound web search.
 *
 * The curiosity driver turns strings lifted out of the conversation into `webSearch(query)`. A production
 * night shows it proposing `mycox-api-key`, `<你的API密钥>` and a bare UUID as research targets, with no
 * credential filter anywhere on the path.
 *
 * The asymmetry that dictates every choice here: a false positive costs one skipped lookup; a false
 * negative puts a live key into a search engine's query log, which no later fix can undo. So these tests
 * assert aggression, and the "does not fire" cases exist only to keep it from swallowing everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCredential, redactForLog } from '../src/index.js';

test('vendor-prefixed keys', () => {
  for (const t of [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_16CharactersOrMoreOfTokenHere1234',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyD-abcdefghijklmnopqrstuvwxyz01234',
    'xoxb-123456789012-abcdefghijkl',
    'glpat-abcdefghij1234567890',
    'hf_abcdefghijklmnopqrstuvwxyzABCD',
  ]) {
    assert.ok(looksLikeCredential(t), t);
  }
});

test('JWTs, service keys, UUIDs and opaque blobs', () => {
  assert.ok(looksLikeCredential('eyJhbGciOi.eyJzdWIiOjEyMw.SflKxwRJSMeKKF2QT4'));
  assert.ok(looksLikeCredential('mycox_dd71ab34cd56ef7890ab12cd34ef5678'));
  // The exact UUID the driver proposed as a research target in production.
  assert.ok(looksLikeCredential('7362d16f-cd31-4eab-a02e-1891fa888c66'));
  assert.ok(looksLikeCredential('a1b2c3d4e5f60718293a4b5c6d7e8f90'));
  assert.ok(looksLikeCredential('Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiYw=='));
});

test('names that announce a credential are suppressed too', () => {
  // Searching the NAME still discloses which services the owner holds keys for, and suppressing it is free.
  for (const t of ['mycox-api-key', '<你的API密钥>', 'openai_token', 'DB_PASSWORD', 'refresh-token', '服务密码']) {
    assert.ok(looksLikeCredential(t), t);
  }
});

test('a credential name inside a phrase is still caught', () => {
  // The space check must not run before the name check.
  assert.ok(looksLikeCredential('your api key'));
  assert.ok(looksLikeCredential('the access token'));
});

test('ordinary research targets are not suppressed', () => {
  for (const t of [
    'arxiv:2511.16817',
    'CVE-2026-1234',
    'https://example.org/paper.pdf',
    'pytorch@2.1.0',
    'Drużkowski',
    'FunSearch',
    'Goldbach',
  ]) {
    assert.equal(looksLikeCredential(t), false, t);
  }
});

test('empty and trivial input', () => {
  assert.equal(looksLikeCredential(''), false);
  assert.equal(looksLikeCredential(null), false);
  assert.equal(looksLikeCredential('abc'), false);
});

test('the log form does not reprint the secret', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';
  const shown = redactForLog(key);
  assert.doesNotMatch(shown, /abcdefghij/, 'suppressing a value and then logging it in full defeats the point');
  assert.match(shown, /45 chars/);
});
