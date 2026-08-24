/**
 * trimPrefixToCap (2026-07-09): shave bulky low-priority sections first; the blunt tail cut is
 * only the true last resort — the prefix tail carries the highest-signal sections.
 *
 * 2026-07-21: the order was inverted at the top — "Lessons I have learned" (the self-learning layer's
 * only channel into the prompt) was being shaved FIRST on every single turn, while the section that
 * actually grows ("Known project information") sat in 4th place and was never reached.
 * Plus collapseFactSeries, which keeps a recurring writer from owning the whole fact top-N.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimPrefixToCap, factKeyStem, collapseFactSeries } from '../src/chat-handler.js';

function section(title: string, bodyChars: number, filler = 'x'): string {
  return `## ${title}\n${filler.repeat(bodyChars)}\n`;
}

test('under cap: unchanged, nothing trimmed', () => {
  const raw = 'preamble\n' + section('Lessons I have learned', 500) + '[End of memory layer]';
  const r = trimPrefixToCap(raw, 10_000);
  assert.equal(r.text, raw);
  assert.deepEqual(r.trimmed, []);
});

test('over cap: the churn-prone project section is shaved; tail sections survive intact', () => {
  const tailMarker = 'VERIFIED-CALL-http-POST-/api/auth/verify';
  const raw =
    'preamble\n' +
    section('Known project information', 8_000) +
    section('Known user information', 4_000) +
    section('Verified working calls (from a real successful run)', 300, 'v') +
    `${tailMarker}\n[End of memory layer]`;
  const cap = raw.length - 3_000; // need to free ~3k
  const r = trimPrefixToCap(raw, cap);
  assert.ok(r.text.length <= cap, `must fit cap: ${r.text.length} > ${cap}`);
  assert.ok(
    r.trimmed.some((t) => t.title.startsWith('Known project information')),
    'project info shaved first',
  );
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

// The prod regression, pinned. Thirteen consecutive turns logged `Lessons I have learned(-5170)`:
// reflection distilled lessons that the trimmer then cut to the floor before the prompt was sent.
test('learned lessons are the LAST thing sacrificed, not the first', () => {
  const raw =
    'preamble\n' +
    section('Lessons I have learned', 6_000) +
    section('Known project information', 10_000) +
    section('Known user information', 9_000) +
    '[End of memory layer]';
  const cap = raw.length - 8_000; // freeable from project+user alone
  const r = trimPrefixToCap(raw, cap);
  assert.ok(r.text.length <= cap);
  assert.ok(
    !r.trimmed.some((t) => t.title.startsWith('Lessons')),
    'Lessons must be untouched while other sections still have slack',
  );
  assert.ok(r.trimmed.some((t) => t.title.startsWith('Known project information')));
});

test('task-aware trimming preserves the project section that matches the current task', () => {
  const raw =
    'preamble\n' +
    section('Known project information', 6_000, 'LRC region3 Lean proof ') +
    section('Known user information', 6_000, 'generic preference ') +
    section('Extended capabilities', 5_000, 'generic capability ') +
    '[End of memory layer]';
  const cap = raw.length - 3_000;
  const r = trimPrefixToCap(raw, cap, { query: '继续 LRC region3 证明' });
  assert.ok(r.text.length <= cap);
  assert.ok(!r.trimmed.some((t) => t.title.startsWith('Known project information')));
  assert.ok(
    r.trimmed.some((t) => t.title.startsWith('Known user information') || t.title.startsWith('Extended capabilities')),
  );
});

test('lessons ARE trimmed once everything else is at its floor (still a last resort, not immune)', () => {
  const raw =
    'preamble\n' +
    section('Lessons I have learned', 9_000) +
    section('Known project information', 2_000) +
    '[End of memory layer]';
  const cap = raw.length - 8_000;
  const r = trimPrefixToCap(raw, cap);
  assert.ok(r.text.length <= cap);
  assert.ok(r.trimmed.some((t) => t.title.startsWith('Lessons')), 'floor reached → Lessons shaved');
});

// ── collapseFactSeries ────────────────────────────────────────────────────────────────────────
test('factKeyStem: strips run-identifying tails, keeps what the key is about', () => {
  assert.equal(factKeyStem('checkin-2026-07-21-13-11'), 'checkin');
  assert.equal(factKeyStem('checkin-2026-07-21-13-17'), 'checkin');
  assert.equal(factKeyStem('run-42'), 'run');
  assert.equal(factKeyStem('note_a3f9b2c1'), 'note');
  assert.equal(factKeyStem('deploy-v2'), 'deploy');
  // Nothing serial-looking → untouched, so ordinary facts never collapse together.
  assert.equal(factKeyStem('api-endpoints'), 'api-endpoints');
  assert.equal(factKeyStem('release-checklist'), 'release-checklist');
  // A wholly serial key still keeps an identity rather than collapsing to ''.
  assert.equal(factKeyStem('2026-07-21'), '2026');
  assert.equal(factKeyStem(''), '');
});

test('collapseFactSeries: a recurring writer keeps ONE slot, distinct facts all survive', () => {
  // Recency-ranked, as the caller passes it: newest check-in first.
  const ranked = [
    { key: 'checkin-2026-07-21-14-01' },
    { key: 'checkin-2026-07-21-13-55' },
    { key: 'checkin-2026-07-21-13-49' },
    { key: 'checkin-2026-07-21-13-43' },
    { key: 'api-endpoints' },
    { key: 'release-checklist' },
  ];
  const { kept, collapsed } = collapseFactSeries(ranked);
  assert.deepEqual(
    kept.map((f) => f.key),
    ['checkin-2026-07-21-14-01', 'api-endpoints', 'release-checklist'],
    'newest series member survives; the durable facts are no longer evicted',
  );
  assert.equal(collapsed, 3);
});

test('collapseFactSeries: no recurring writer → exact no-op', () => {
  const ranked = [{ key: 'api-endpoints' }, { key: 'release-checklist' }, { key: 'owner-timezone' }];
  const { kept, collapsed } = collapseFactSeries(ranked);
  assert.deepEqual(kept, ranked);
  assert.equal(collapsed, 0);
});
