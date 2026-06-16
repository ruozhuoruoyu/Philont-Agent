import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/utils/retry.js';

test('withRetry: retries a retryable error then succeeds', async () => {
  let calls = 0;
  const r = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('timeout');
      return 'ok';
    },
    { isRetryable: (e) => (e as Error).message === 'timeout', baseDelayMs: 1 },
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 3); // 2 retries + success
});

test('withRetry: non-retryable error rethrows immediately (no retry)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('404 not found');
      },
      { isRetryable: (e) => (e as Error).message.includes('timeout'), baseDelayMs: 1 },
    ),
    /404/,
  );
  assert.equal(calls, 1); // never retried
});

test('withRetry: gives up after retries exhausted', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error('timeout');
      },
      { retries: 2, isRetryable: () => true, baseDelayMs: 1 },
    ),
    /timeout/,
  );
  assert.equal(calls, 3); // first + 2 retries
});
