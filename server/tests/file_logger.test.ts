/**
 * file_logger — pure formatter / config tests + a real tee smoke test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stampChunk,
  dayStamp,
  logFileName,
  stampTime,
  logTimeZone,
  tzOffsetLabel,
  fileLoggingEnabled,
  logDir,
  initFileLogging,
} from '../src/file_logger.js';

test('stampChunk: prefixes each line start, carries state across writes', () => {
  // Single full line.
  const a = stampChunk('TS ', 'hello\n', true);
  assert.equal(a.out, 'TS hello\n');
  assert.equal(a.atLineStart, true);

  // Mid-line continuation: previous write did not end with \n.
  const b = stampChunk('TS ', 'abc', true);
  assert.equal(b.out, 'TS abc');
  assert.equal(b.atLineStart, false);
  const c = stampChunk('TS ', 'def\n', b.atLineStart);
  assert.equal(c.out, 'def\n', 'no prefix when continuing a line');
  assert.equal(c.atLineStart, true);

  // Multi-line chunk stamps every interior line start, not the trailing empty one.
  const d = stampChunk('TS ', 'l1\nl2\n', true);
  assert.equal(d.out, 'TS l1\nTS l2\n');
  assert.equal(d.atLineStart, true);

  // Empty chunk is a no-op and preserves state.
  assert.deepEqual(stampChunk('TS ', '', false), { out: '', atLineStart: false });
});

test('dayStamp / logFileName: YYYYMMDD in the OWNER timezone, not UTC', () => {
  const d = new Date(Date.UTC(2026, 5, 26, 23, 59)); // 2026-06-26 23:59 UTC
  assert.equal(dayStamp(d, 'UTC'), '20260626');
  assert.equal(logFileName(d, 'UTC'), 'philont-20260626.log');
  // Same instant is already the NEXT day in Shanghai (+08:00) — the file must roll over at the
  // owner's midnight, so "today's log" is one file for them, not two.
  assert.equal(dayStamp(d, 'Asia/Shanghai'), '20260627');
  assert.equal(logFileName(d, 'Asia/Shanghai'), 'philont-20260627.log');
  // …and still the PREVIOUS day in New York (-04:00).
  assert.equal(dayStamp(d, 'America/New_York'), '20260626');
});

test('stampTime: plain local wall clock — no offset, no "T", no arithmetic for the reader', () => {
  const d = new Date(Date.UTC(2026, 6, 13, 1, 46, 46, 545)); // the UTC stamp from a real prod log
  assert.equal(stampTime(d, 'UTC'), '2026-07-13 01:46:46.545');
  // 01:46 UTC is 09:46 the same morning in Shanghai — which is what the owner's clock said.
  assert.equal(stampTime(d, 'Asia/Shanghai'), '2026-07-13 09:46:46.545');
  // A zone whose DATE also differs from UTC's — the stamp must follow the local calendar.
  assert.equal(stampTime(d, 'America/New_York'), '2026-07-12 21:46:46.545');
  // Half-hour zone.
  assert.equal(stampTime(d, 'Asia/Kolkata'), '2026-07-13 07:16:46.545');
  // No timezone marker anywhere — a bare local clock is the whole point.
  assert.doesNotMatch(stampTime(d, 'Asia/Shanghai'), /[TZ]|[+-]\d{2}:\d{2}/);
});

test('tzOffsetLabel: still exact (the banner records it, since the lines no longer do)', () => {
  const d = new Date(Date.UTC(2026, 6, 13, 1, 46, 46, 545));
  assert.equal(tzOffsetLabel(d, 'UTC'), 'Z');
  assert.equal(tzOffsetLabel(d, 'Asia/Shanghai'), '+08:00');
  assert.equal(tzOffsetLabel(d, 'America/New_York'), '-04:00');
  assert.equal(tzOffsetLabel(d, 'Asia/Kolkata'), '+05:30', 'must not assume whole-hour offsets');
});

test('logTimeZone: AGENT_TIMEZONE drives it; unset / bogus → UTC (never throws)', () => {
  const saved = process.env.AGENT_TIMEZONE;
  try {
    delete process.env.AGENT_TIMEZONE;
    assert.equal(logTimeZone(), 'UTC', 'unset → UTC');
    process.env.AGENT_TIMEZONE = 'Asia/Shanghai';
    assert.equal(logTimeZone(), 'Asia/Shanghai');
    process.env.AGENT_TIMEZONE = '  ';
    assert.equal(logTimeZone(), 'UTC', 'blank → UTC');
    process.env.AGENT_TIMEZONE = 'Not/AZone';
    assert.equal(logTimeZone(), 'UTC', 'a config typo must not crash the logger');
  } finally {
    if (saved === undefined) delete process.env.AGENT_TIMEZONE;
    else process.env.AGENT_TIMEZONE = saved;
  }
});

test('fileLoggingEnabled: default ON, off only on explicit off-ish value', () => {
  const saved = process.env.PHILONT_FILE_LOG;
  try {
    delete process.env.PHILONT_FILE_LOG;
    assert.equal(fileLoggingEnabled(), true, 'default ON');
    for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
      process.env.PHILONT_FILE_LOG = v;
      assert.equal(fileLoggingEnabled(), false, `${v} disables`);
    }
    for (const v of ['1', 'on', 'true', '']) {
      process.env.PHILONT_FILE_LOG = v;
      assert.equal(fileLoggingEnabled(), true, `${v} stays on`);
    }
  } finally {
    if (saved === undefined) delete process.env.PHILONT_FILE_LOG;
    else process.env.PHILONT_FILE_LOG = saved;
  }
});

test('logDir: PHILONT_LOG_DIR override', () => {
  const saved = process.env.PHILONT_LOG_DIR;
  try {
    process.env.PHILONT_LOG_DIR = '/tmp/philont-logs-xyz';
    assert.equal(logDir(), '/tmp/philont-logs-xyz');
  } finally {
    if (saved === undefined) delete process.env.PHILONT_LOG_DIR;
    else process.env.PHILONT_LOG_DIR = saved;
  }
});

test('initFileLogging: tees console to the dated file AND still prints to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-flog-'));
  const savedFlag = process.env.PHILONT_FILE_LOG;
  // NOTE: initFileLogging installs a PROCESS-level tee that reads logDir() at each write. We point
  // PHILONT_LOG_DIR at a temp dir and deliberately do NOT restore it — so for the rest of this test
  // process (full-suite runs) the now-permanent tee keeps writing to temp, never the user's ~/.philont.
  process.env.PHILONT_LOG_DIR = dir;
  delete process.env.PHILONT_FILE_LOG;
  try {
    initFileLogging(); // idempotent; installs the tee once for the process

    const marker = `evidence-marker-${dayStamp(new Date())}-${process.pid}`;
    console.log(`[webSearch] backend=test hits=3 query="${marker}"`);

    const files = readdirSync(dir).filter((f) => /^philont-\d{8}\.log$/.test(f));
    assert.ok(files.length >= 1, 'a dated log file was created');
    const body = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('');
    assert.match(body, new RegExp(marker), 'the console line was mirrored to the file');
    assert.match(body, /\[out\] \[webSearch\] backend=test/, 'line is tagged + timestamped');
  } finally {
    if (savedFlag === undefined) delete process.env.PHILONT_FILE_LOG;
    else process.env.PHILONT_FILE_LOG = savedFlag;
  }
});
