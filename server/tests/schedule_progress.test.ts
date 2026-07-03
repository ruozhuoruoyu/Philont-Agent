/**
 * scheduledTurnMadeProgress — the scheduler circuit-breaker input.
 * Prod shape reproduced: an all-401 heartbeat returns an honest partial report (no throw); it must
 * be judged NO-progress so recordFailure arms the 1h auto-pause instead of recordSuccess resetting it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledTurnMadeProgress, isExternalWriteRecord } from '../src/schedule_progress.js';
import type { InTurnToolRecord } from '../src/in_turn_reflection.js';

const http = (method: string, success: boolean): InTurnToolRecord => ({
  toolName: 'http', success, toolInput: { method, url: 'https://mycox.ai/api/posts' },
});
const read = (success = true): InTurnToolRecord => ({ toolName: 'get_fact', success });

test('all external writes failed (the all-401 avalanche) → NO progress', () => {
  const records = [read(true), http('POST', false), http('POST', false), http('GET', true)];
  assert.equal(scheduledTurnMadeProgress(records), false);
});

test('at least one successful external write → progress', () => {
  const records = [http('POST', false), http('POST', true), http('GET', true)];
  assert.equal(scheduledTurnMadeProgress(records), true);
});

test('clean read-only check-in (no write attempts) → progress (must not false-pause)', () => {
  const records = [read(true), http('GET', true), http('GET', true)];
  assert.equal(scheduledTurnMadeProgress(records), true);
});

test('empty turn → progress (nothing failed)', () => {
  assert.equal(scheduledTurnMadeProgress([]), true);
});

test('isExternalWriteRecord: mutating http methods only', () => {
  assert.equal(isExternalWriteRecord(http('POST', true)), true);
  assert.equal(isExternalWriteRecord(http('put', true)), true);
  assert.equal(isExternalWriteRecord(http('GET', false)), false);
  assert.equal(isExternalWriteRecord(read()), false);
});
