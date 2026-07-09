/**
 * trimPrefixToCap (2026-07-09): shave bulky low-priority sections first; the blunt tail cut is
 * only the true last resort — the prefix tail carries the highest-signal sections.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimPrefixToCap } from '../src/chat-handler.js';

function section(title: string, bodyChars: number, filler = 'x'): string {
  return `## ${title}\n${filler.repeat(bodyChars)}\n`;
}

test('under cap: unchanged, nothing trimmed', () => {
  const raw = 'preamble\n' + section('Lessons I have learned', 500) + '[End of memory layer]';
  const r = trimPrefixToCap(raw, 10_000);
  assert.equal(r.text, raw);
  assert.deepEqual(r.trimmed, []);
});

test('over cap: bulky Lessons section is shaved; tail sections survive intact', () => {
  const tailMarker = 'VERIFIED-CALL-http-POST-/api/auth/verify';
  const raw =
    'preamble\n' +
    section('Lessons I have learned', 8_000) +
    section('Known user information', 4_000) +
    section('Verified working calls (from a real successful run)', 300, 'v') +
    `${tailMarker}\n[End of memory layer]`;
  const cap = raw.length - 3_000; // need to free ~3k
  const r = trimPrefixToCap(raw, cap);
  assert.ok(r.text.length <= cap, `must fit cap: ${r.text.length} > ${cap}`);
  assert.ok(r.trimmed.some((t) => t.title.startsWith('Lessons I have learned')), 'Lessons shaved first');
  // The high-signal tail is untouched
  assert.ok(r.text.includes(tailMarker), 'verified-calls content must survive');
  assert.ok(r.text.trimEnd().endsWith('[End of memory layer]'), 'closing marker intact');
  assert.match(r.text, /section trimmed to fit the prefix cap/);
});

test('nothing trimmable: falls back to the blunt tail cut', () => {
  const raw = 'preamble\n' + section('Some Untouchable Section', 6_000) + '[End of memory layer]';
  const r = trimPrefixToCap(raw, 3_000);
  assert.ok(r.text.length <= 3_000 + 120, 'blunt cut + marker');
  assert.match(r.text, /memory prefix too long, truncated/);
});

test('trim order respected: user info only shaved after Lessons is exhausted to its floor', () => {
  const raw =
    'preamble\n' +
    section('Lessons I have learned', 2_000) +
    section('Known user information', 8_000) +
    '[End of memory layer]';
  const cap = raw.length - 4_000;
  const r = trimPrefixToCap(raw, cap);
  assert.ok(r.text.length <= cap);
  const lessons = r.trimmed.find((t) => t.title.startsWith('Lessons'));
  const userInfo = r.trimmed.find((t) => t.title.startsWith('Known user information'));
  assert.ok(lessons, 'Lessons shaved (to its floor)');
  assert.ok(userInfo, 'remainder came from Known user information');
});
