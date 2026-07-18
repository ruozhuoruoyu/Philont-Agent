import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auxTimeoutFor } from '../src/utils/aux-llm.js';

test('timeout scales with the output the caller asked for', () => {
  // A tiny classifier must not squat a shared queue slot as long as a full distillation.
  assert.ok(auxTimeoutFor(4) < auxTimeoutFor(200));
  assert.ok(auxTimeoutFor(200) < auxTimeoutFor(2048));
  assert.ok(auxTimeoutFor(2048) <= auxTimeoutFor(4096));
});

test('never LONGER than the old flat 60s default — this can only shorten calls', () => {
  for (const t of [4, 200, 1024, 2048, 4096, 32768, undefined]) {
    assert.ok(auxTimeoutFor(t) <= 60_000, `maxTokens=${t} must not exceed the previous flat default`);
  }
  // The largest common job keeps exactly what it had before.
  assert.equal(auxTimeoutFor(4096), 60_000);
  assert.equal(auxTimeoutFor(undefined), 60_000, 'unspecified maxTokens defaults to the 4096 budget');
});

test('a per-turn classifier gets a small fraction of the old ceiling', () => {
  // intent-router / auth-intent block the user's turn; 60s for a ~200-token verdict was the bug.
  assert.ok(auxTimeoutFor(200) < 20_000, `got ${auxTimeoutFor(200)}ms for a 200-token classifier`);
});

test('never below a usable floor (slow connect must not false-timeout)', () => {
  assert.ok(auxTimeoutFor(1) >= 8_000);
  assert.ok(auxTimeoutFor(0) >= 8_000);
});
