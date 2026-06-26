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

test('dayStamp / logFileName: UTC YYYYMMDD', () => {
  const d = new Date(Date.UTC(2026, 5, 26, 23, 59)); // 2026-06-26 UTC
  assert.equal(dayStamp(d), '20260626');
  assert.equal(logFileName(d), 'philont-20260626.log');
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
