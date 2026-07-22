/**
 * Scheduled-run reporting (2026-07-22).
 *
 * A scheduled task reported NOTHING unless it was created with replyChannel:'summary', and the default
 * was 'silent'. Prod: a check-in ran every six minutes for days and every reply was discarded at the
 * emitter — including "这个模式已经走到死胡同了，同样的情况已经重复了 30+ 次".
 *
 * Flipping the default to 'summary' would have been the opposite error: ten "feed unchanged" messages an
 * hour, and a notification stream a human learns to ignore is worth the same as no notification at all.
 * The default is therefore change-based.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleRunFingerprint, shouldReportScheduledRun } from '../src/chat-handler.js';

const quiet = { outcome: 'ok', httpFailCount: 0, failureSignatures: [] as string[] };
const fp = (o: Partial<typeof quiet> = {}) => scheduleRunFingerprint({ ...quiet, ...o });

test('the fingerprint ignores meaningless variation', () => {
  // httpOk 5 vs 6 tracks how many comment threads existed that minute. It is not news.
  assert.equal(fp(), fp());
  assert.equal(
    scheduleRunFingerprint({ outcome: 'ok', httpFailCount: 0, failureSignatures: [] }),
    scheduleRunFingerprint({ outcome: 'ok', httpFailCount: 0, failureSignatures: [] }),
  );
  // Signature ORDER is not a change either.
  assert.equal(
    scheduleRunFingerprint({ outcome: 'partial', httpFailCount: 1, failureSignatures: ['a', 'b'] }),
    scheduleRunFingerprint({ outcome: 'partial', httpFailCount: 1, failureSignatures: ['b', 'a'] }),
  );
});

test('the fingerprint moves on anything a person would call news', () => {
  assert.notEqual(fp(), fp({ outcome: 'partial' }), 'outcome flipped');
  assert.notEqual(fp(), fp({ httpFailCount: 1 }), 'requests started failing');
  assert.notEqual(fp(), fp({ failureSignatures: ['http:http-401'] }), 'a new failure signature');
  assert.notEqual(fp(), fp({ failureSignatures: ['blocked:writeFile'] }));
});

test('on-change: the first run always reports, then only on a change', () => {
  assert.equal(shouldReportScheduledRun('on-change', fp(), undefined), true, 'first run');
  assert.equal(shouldReportScheduledRun('on-change', fp(), fp()), false, 'nothing changed');
  assert.equal(shouldReportScheduledRun('on-change', fp({ httpFailCount: 1 }), fp()), true, 'broke');
  assert.equal(shouldReportScheduledRun('on-change', fp(), fp({ httpFailCount: 1 })), true, 'recovered');
});

test('sixty identical quiet runs produce exactly one message', () => {
  // The prod shape, and the whole point of not defaulting to 'summary'.
  let prev: string | undefined;
  let reports = 0;
  for (let i = 0; i < 60; i++) {
    const cur = fp();
    if (shouldReportScheduledRun('on-change', cur, prev)) reports++;
    prev = cur;
  }
  assert.equal(reports, 1);
});

test('a break in the quiet run reports, and so does the recovery', () => {
  const seq = [fp(), fp(), fp({ httpFailCount: 1 }), fp({ httpFailCount: 1 }), fp()];
  let prev: string | undefined;
  const reported: number[] = [];
  seq.forEach((cur, i) => {
    if (shouldReportScheduledRun('on-change', cur, prev)) reported.push(i);
    prev = cur;
  });
  assert.deepEqual(reported, [0, 2, 4], 'first run, the break, the recovery — not the repeats');
});

test('explicit modes still mean exactly what they meant', () => {
  // Someone who deliberately opted out stays opted out; someone who deliberately wanted every run
  // keeps getting every run.
  assert.equal(shouldReportScheduledRun('silent', fp(), undefined), false, 'silent even on run one');
  assert.equal(shouldReportScheduledRun('silent', fp({ httpFailCount: 1 }), fp()), false);
  assert.equal(shouldReportScheduledRun('summary', fp(), fp()), true, 'summary even when unchanged');
});

// ── Auto-pause reaches the owner (2026-07-22) ───────────────────────────────────────────────────
//
// Both pause sites wrote an audit row and one console.warn and stopped. A schedule going quiet is
// indistinguishable from a schedule with nothing to say, so the owner would find out by eventually
// noticing the absence of something they had stopped expecting. At the 24h cadence they moved to, that
// costs days.
import { readFileSync } from 'node:fs';

test('both auto-pause sites report through the one shared builder', () => {
  // They were separately written and had already drifted — one carried a `reason`, the other did not.
  // Same split that produced two different blacklist rejection messages.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const calls = src.match(/reportSchedulePaused\(\{/g) ?? [];
  assert.equal(calls.length, 2, 'both pause paths must notify');
  assert.equal((src.match(/function reportSchedulePaused/g) ?? []).length, 1, 'one definition, not two');
});

test('the pause report goes to the owner channels, not only to a note', () => {
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function reportSchedulePaused'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.match(fn, /memory\.notes\.storeNote/, 'durable record kept');
  assert.match(fn, /webuiClients/, 'web-ui');
  assert.match(fn, /pushDispatcher/, 'WeChat/Telegram');
  // The dedup key must vary per pause, or a second pause the same day is swallowed by the 24h
  // (kind, targetRef) dedup — exactly the one worth hearing about.
  assert.match(fn, /schedule-paused:\$\{input\.scheduleName\}:\$\{input\.pausedUntilTs\}/);
});
