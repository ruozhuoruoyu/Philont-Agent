import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOREGROUND_TOOL_FLOOR_MS,
  planToolTimeBudget,
  readRequestedTimeoutMs,
  toolTakesForegroundTimeout,
  clampNotice,
  noRoomError,
} from '../src/tool_time_budget.js';

const HEADROOM = 3 * 60_000;

test('a foreground timeout is capped by what the turn has left, minus the wrap-up headroom', () => {
  // Production 2026-09-09 22:48: shell was given 600000ms; the turn's own hard deadline is 1200000ms.
  const plenty = planToolTimeBudget({ requestedMs: 600_000, remainingMs: 1_150_000, headroomMs: HEADROOM });
  assert.deepEqual(plenty, { kind: 'unchanged' }, 'a fresh turn can host a ten-minute call');
  const squeezed = planToolTimeBudget({ requestedMs: 600_000, remainingMs: 500_000, headroomMs: HEADROOM });
  assert.deepEqual(squeezed, { kind: 'clamped', timeoutMs: 320_000, requestedMs: 600_000 });
});

test('a turn with no working time left refuses the call instead of dying on the deadline', () => {
  const noRoom = planToolTimeBudget({ requestedMs: 600_000, remainingMs: HEADROOM + 10_000, headroomMs: HEADROOM });
  assert.equal(noRoom.kind, 'no-room');
  assert.equal(noRoom.kind === 'no-room' && noRoom.availableMs, 10_000);
  // The refusal must point at the mechanism that does work, or the model just retries the same call.
  assert.match(noRoom.kind === 'no-room' ? noRoomError('shell', noRoom.availableMs) : '', /process\(action:"spawn"\)/);
  const exactlyEnough = planToolTimeBudget({
    requestedMs: 600_000, remainingMs: HEADROOM + FOREGROUND_TOOL_FLOOR_MS, headroomMs: HEADROOM,
  });
  assert.equal(exactlyEnough.kind, 'clamped', 'the floor itself is still runnable');
});

test('callers with no turn are left alone, and a call with no timeout is not rewritten', () => {
  assert.deepEqual(
    planToolTimeBudget({ requestedMs: 1_800_000, remainingMs: Number.POSITIVE_INFINITY, headroomMs: HEADROOM }),
    { kind: 'unchanged' },
    'autonomous ticks and idle consolidation are not racing a turn deadline',
  );
  assert.deepEqual(
    planToolTimeBudget({ requestedMs: undefined, remainingMs: 900_000, headroomMs: HEADROOM }),
    { kind: 'unchanged' },
  );
});

test('a clamped call is told so, and told not to retry bigger inside the same turn', () => {
  const notice = clampNotice({ timeoutMs: 320_000, requestedMs: 600_000 });
  assert.match(notice, /600000ms to 320000ms/);
  // shell's own timeout hint says "never retry with the original timeout — pick a larger one". Left
  // unqualified that turns one clamped call into a loop the turn cannot afford.
  assert.match(notice, /do NOT retry it here with a bigger/i);
  assert.match(notice, /process\(action:"spawn"\)/);
});

test('only tools that advertise a wall-clock timeout are governed by the turn budget', () => {
  assert.equal(toolTakesForegroundTimeout({ properties: { timeout: { type: 'number' } } }), true);
  assert.equal(toolTakesForegroundTimeout({ properties: { path: { type: 'string' } } }), false,
    'a readFile with twenty seconds left is not the problem this solves');
  assert.equal(toolTakesForegroundTimeout({ properties: { timeout: { type: 'string' } } }), false);
  assert.equal(toolTakesForegroundTimeout(undefined), false);
  assert.equal(readRequestedTimeoutMs({ timeout: 600_000 }), 600_000);
  assert.equal(readRequestedTimeoutMs({ timeout: '600000' }), undefined);
  assert.equal(readRequestedTimeoutMs(null), undefined);
});
