import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The per-tool log must name the http endpoint but never leak credentials.
const src = readFileSync(new URL('../src/plan_execute_loop.ts', import.meta.url), 'utf8');

test('http per-tool log includes method + host + path', () => {
  const block = src.slice(src.indexOf('For http, name the endpoint'), src.indexOf('For http, name the endpoint') + 900);
  assert.match(block, /u\.host\}\$\{u\.pathname\}/, 'must log host + pathname');
  assert.match(block, /input\.method/, 'must log the method');
});

test('http per-tool log drops the query string and never logs args', () => {
  const block = src.slice(src.indexOf('For http, name the endpoint'), src.indexOf('For http, name the endpoint') + 900);
  assert.doesNotMatch(block, /u\.search/, 'query string can carry tokens — must not be logged');
  assert.doesNotMatch(block, /JSON\.stringify\(input\)/, 'args carry credentials — never log them');
});
