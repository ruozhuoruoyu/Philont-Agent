import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJsonParse } from '../src/llm-adapter.js';

test('strips the quote artifact from a header NAME (the exact prod failure)', () => {
  // Verbatim from prod 2026-07-17 (gemma-4-31B): the header name arrived as `<|"|>Content-Type<|"|>`.
  const args = JSON.stringify({
    url: 'https://mycox.ai/api/posts',
    method: 'POST',
    headers: { '<|"|>Content-Type<|"|>': 'application/json' },
  });
  const out = safeJsonParse(args);
  assert.deepEqual(Object.keys(out.headers as object), ['Content-Type']);
});

test('strips the artifact from a header VALUE — the case nothing else catches', () => {
  // A polluted Authorization VALUE still ships to the server (only the NAME is validated), which is
  // exactly what a "401 Invalid API key" on a freshly-captured key looks like.
  const args = JSON.stringify({
    url: 'https://mycox.ai/api/auth/verify',
    method: 'POST',
    headers: { Authorization: '<|"|>Bearer {mycox-api-key}<|"|>' },
  });
  const out = safeJsonParse(args);
  assert.equal((out.headers as Record<string, string>).Authorization, 'Bearer {mycox-api-key}');
});

test('strips through nested bodies and arrays, and leaves clean args untouched', () => {
  const out = safeJsonParse(JSON.stringify({
    body: { title: '<|"|>hi<|"|>', tags: ['<|"|>a<|"|>', 'b'], n: 3, ok: true, nil: null },
  }));
  assert.deepEqual(out.body, { title: 'hi', tags: ['a', 'b'], n: 3, ok: true, nil: null });

  const clean = JSON.stringify({ url: 'https://x.test/a', headers: { Authorization: 'Bearer {k}' } });
  assert.deepEqual(safeJsonParse(clean), JSON.parse(clean));
});

test('does NOT strip legitimate <|...|> content — only the quote-token form', () => {
  // A post body genuinely discussing template tokens must survive intact.
  const out = safeJsonParse(JSON.stringify({ body: { text: 'the <|im_start|> token and <|endoftext|>' } }));
  assert.equal((out.body as Record<string, string>).text, 'the <|im_start|> token and <|endoftext|>');
});

test('unparseable arguments still degrade to {} (unchanged)', () => {
  assert.deepEqual(safeJsonParse('not json'), {});
  assert.deepEqual(safeJsonParse(''), {});
});
