import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TURN_HARD_DEADLINE_DEFAULT_MS,
  TURN_HARD_DEADLINE_MAX_MS,
  TURN_HARD_DEADLINE_MIN_MS,
  resolveTurnHardDeadlineMs,
} from '../src/turn_deadline.js';

test('turn hard deadline defaults to 20 min when the env var is unset', () => {
  assert.equal(resolveTurnHardDeadlineMs(undefined), 20 * 60_000);
  assert.equal(resolveTurnHardDeadlineMs(''), TURN_HARD_DEADLINE_DEFAULT_MS);
});

test('turn hard deadline accepts an in-range override (benchmark protocols grant more than 20 min)', () => {
  assert.equal(resolveTurnHardDeadlineMs('3600000'), 60 * 60_000);
  assert.equal(resolveTurnHardDeadlineMs(String(TURN_HARD_DEADLINE_MIN_MS)), TURN_HARD_DEADLINE_MIN_MS);
  assert.equal(resolveTurnHardDeadlineMs(String(TURN_HARD_DEADLINE_MAX_MS)), TURN_HARD_DEADLINE_MAX_MS);
});

test('turn hard deadline falls back to the default on out-of-range or garbage values', () => {
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (msg: string) => { seen.push(String(msg)); };
  try {
    assert.equal(resolveTurnHardDeadlineMs('1000'), TURN_HARD_DEADLINE_DEFAULT_MS);
    assert.equal(resolveTurnHardDeadlineMs(String(TURN_HARD_DEADLINE_MAX_MS + 1)), TURN_HARD_DEADLINE_DEFAULT_MS);
    assert.equal(resolveTurnHardDeadlineMs('soon'), TURN_HARD_DEADLINE_DEFAULT_MS);
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every((m) => m.includes('PHILONT_TURN_HARD_DEADLINE_MS')));
});
