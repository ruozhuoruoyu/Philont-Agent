import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmEndpointBreaker, LlmEndpointDownError } from '../src/llm-adapter.js';

const down = () => Object.assign(new Error('OpenAI-compatible API 504: '), { status: 504 });
const modelReject = () => Object.assign(new Error('invalid request: bad tool schema'), { status: 400 });

test('stays closed below the threshold — a flaky call must not trip it', () => {
  const b = new LlmEndpointBreaker(4, 1000);
  for (let i = 0; i < 3; i++) b.recordFailure(down());
  assert.doesNotThrow(() => b.assertClosed());
});

test('opens after consecutive endpoint failures and then fails FAST', () => {
  const b = new LlmEndpointBreaker(4, 1000);
  for (let i = 0; i < 4; i++) b.recordFailure(down());
  assert.throws(() => b.assertClosed(), LlmEndpointDownError);
});

test('a single success resets the count — only CONSECUTIVE failures matter', () => {
  const b = new LlmEndpointBreaker(4, 1000);
  for (let i = 0; i < 3; i++) b.recordFailure(down());
  b.recordSuccess();
  for (let i = 0; i < 3; i++) b.recordFailure(down());
  assert.doesNotThrow(() => b.assertClosed(), 'intermittent failures must never open it');
});

test('a model-level rejection does NOT indict the endpoint (it is answering fine)', () => {
  const b = new LlmEndpointBreaker(4, 1000);
  for (let i = 0; i < 10; i++) b.recordFailure(modelReject());
  assert.doesNotThrow(() => b.assertClosed());
});

test('a user abort does NOT open it', () => {
  const b = new LlmEndpointBreaker(4, 1000);
  for (let i = 0; i < 10; i++) b.recordFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.doesNotThrow(() => b.assertClosed());
});

test('half-open after cooldown lets exactly ONE probe through, and success closes it', async () => {
  const b = new LlmEndpointBreaker(4, 30);
  for (let i = 0; i < 4; i++) b.recordFailure(down());
  assert.throws(() => b.assertClosed(), LlmEndpointDownError, 'open immediately after tripping');

  await new Promise((r) => setTimeout(r, 45));
  assert.doesNotThrow(() => b.assertClosed(), 'cooldown elapsed → one probe allowed');

  b.recordSuccess();
  assert.doesNotThrow(() => b.assertClosed(), 'endpoint recovered → closed, no restart needed');
});

test('a failed probe re-opens it (still down)', async () => {
  const b = new LlmEndpointBreaker(4, 30);
  for (let i = 0; i < 4; i++) b.recordFailure(down());
  await new Promise((r) => setTimeout(r, 45));
  b.assertClosed();          // probe goes out
  b.recordFailure(down());   // probe failed
  assert.throws(() => b.assertClosed(), LlmEndpointDownError, 'still down → keep failing fast');
});

test('PHILONT_LLM_BREAKER=0 disables it entirely', () => {
  const prev = process.env.PHILONT_LLM_BREAKER;
  process.env.PHILONT_LLM_BREAKER = '0';
  try {
    const b = new LlmEndpointBreaker(4, 1000);
    for (let i = 0; i < 20; i++) b.recordFailure(down());
    assert.doesNotThrow(() => b.assertClosed());
  } finally {
    if (prev === undefined) delete process.env.PHILONT_LLM_BREAKER; else process.env.PHILONT_LLM_BREAKER = prev;
  }
});
