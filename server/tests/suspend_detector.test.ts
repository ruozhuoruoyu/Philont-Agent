/**
 * 2026-08-04: the owner sent 继续 at 11:35, 继续 at 13:42, 怎么样了？at 15:35. Three turns, three
 * `TypeError: terminated`, three 19-character "抱歉，刚才出错了". Five hours, no explanation.
 *
 * The timestamps show every clock in the process stopping and restarting together:
 *
 *   11:35:35 [timeline] retrieved …   →  12:35:21 [turn] start      (60 min inside one setup)
 *   13:42:11 [turn] start …           →  14:35:24 [drive] evaluated (53 min between two lines)
 *   [autonomous] tick: ran=1 … 4202284ms                            (a 70-minute 300-second tick)
 *
 * A suspended process cannot run its own deadline: the 20-minute turn limit was not late, it never
 * executed. The one thing still possible is noticing afterwards — a wall-clock gap far larger than the
 * tick interval can only mean nothing ran in between — and then telling the owner that their laptop was
 * asleep rather than that philont broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  observeClock,
  suspensionDuring,
  explainSuspension,
  _resetSuspendDetectorForTest,
  suspendDetectEnabled,
} from '../src/suspend_detector.js';

const T0 = 1_785_800_000_000;
const TICK = 30_000;

test('ordinary ticks record nothing', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  for (let i = 1; i <= 10; i++) {
    assert.equal(observeClock(T0 + i * TICK), null);
  }
  assert.equal(suspensionDuring(T0, T0 + 10 * TICK), 0);
});

// A blocked event loop can swallow ticks — better-sqlite3 is synchronous. Telling the owner "your
// machine was asleep" when it was merely busy is worse than saying nothing, so the bar is minutes.
test('a busy event loop is not a suspension', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  assert.equal(observeClock(T0 + TICK * 3), null, 'a slow tick is not the host stopping');
  assert.equal(observeClock(T0 + TICK * 3 + 4 * 60_000), null, 'four minutes is still not an outage');
  assert.ok(observeClock(T0 + TICK * 3 + 4 * 60_000 + 6 * 60_000), 'six minutes is');
});

test('the 53-minute hole between two log lines is recorded', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  const gap = 53 * 60_000;
  const s = observeClock(T0 + gap);
  assert.ok(s);
  assert.equal(s.from, T0);
  assert.equal(s.to, T0 + gap);
});

test('a turn that spanned the hole is told how long it was not running', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  observeClock(T0 + 53 * 60_000);

  const turnStart = T0 - 60_000; // the owner's message landed a minute before the host went away
  const turnEnd = T0 + 54 * 60_000;
  assert.ok(suspensionDuring(turnStart, turnEnd) >= 53 * 60_000 - 1);

  const zh = explainSuspension(turnStart, turnEnd, false)!;
  assert.match(zh, /53 分钟/);
  assert.match(zh, /不是 philont 的故障/);
  assert.match(zh, /重发/);
  assert.match(explainSuspension(turnStart, turnEnd, true)!, /asleep or a frozen console|suspended/);
});

test('a turn that ran on a live process is told nothing', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  observeClock(T0 + 53 * 60_000);
  // a later turn, entirely after the host came back
  assert.equal(explainSuspension(T0 + 60 * 60_000, T0 + 61 * 60_000, false), null);
  assert.equal(suspensionDuring(T0 + 60 * 60_000, T0 + 61 * 60_000), 0);
});

test('only the overlapping part counts, not the whole outage', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  observeClock(T0 + 60 * 60_000); // one hour gone

  // a turn that started halfway through the outage overlaps only the second half
  const overlap = suspensionDuring(T0 + 30 * 60_000, T0 + 60 * 60_000);
  assert.equal(overlap, 30 * 60_000);
});

test('several outages in one turn add up', () => {
  _resetSuspendDetectorForTest();
  observeClock(T0);
  observeClock(T0 + 20 * 60_000);
  observeClock(T0 + 23 * 60_000); // 3 min — under the threshold, a busy event loop, not an outage
  observeClock(T0 + 43 * 60_000);
  assert.equal(suspensionDuring(T0, T0 + 43 * 60_000), 40 * 60_000);
});

test('the first observation has nothing to compare against', () => {
  _resetSuspendDetectorForTest();
  assert.equal(observeClock(T0 + 10 * 60 * 60_000), null, 'boot is not an outage');
});

test('the switch gates the detector', () => {
  const prev = process.env.PHILONT_SUSPEND_DETECT;
  try {
    process.env.PHILONT_SUSPEND_DETECT = '0';
    assert.equal(suspendDetectEnabled(), false);
    delete process.env.PHILONT_SUSPEND_DETECT;
    assert.equal(suspendDetectEnabled(), true, 'on by default — an unexplained five hours is the cost');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_SUSPEND_DETECT;
    else process.env.PHILONT_SUSPEND_DETECT = prev;
  }
});
