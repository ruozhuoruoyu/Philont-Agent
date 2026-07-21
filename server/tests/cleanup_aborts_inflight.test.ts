import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');

/** The cleanup-scope block that pauses matching schedules. */
const block = (() => {
  const i = src.indexOf('const until = Date.now() + CLEANUP_SCHEDULE_PAUSE_MS;');
  return src.slice(i, i + 2000);
})();

test('cleanup aborts in-flight scheduled runs, not just future fires', () => {
  // Pausing alone left a running turn to lose its credentials mid-flight and thrash into the breaker.
  assert.match(block, /abortActiveTurn\(/, 'the matching-schedule loop must abort in-flight runs');
});

test('the abort uses the schedule NAME — the key scheduled turns are actually registered under', () => {
  // This is the silent-failure trap: abortActiveTurn returns false for an unknown session and reports
  // nothing, so keying by id would look like it worked while doing nothing at all.
  assert.match(block, /abortActiveTurn\(`system:scheduled:\$\{s\.name\}`\)/,
    'must key by s.name; s.id would silently no-op');
});

test('scheduled turns are registered under that same key (the two sites must agree)', () => {
  assert.match(src, /const turnSessionId = `system:scheduled:\$\{s\.name\}`/,
    'the dispatch site defines the key the abort has to match');
});

test('the abort happens BEFORE the turn proceeds to delete', () => {
  // Ordering is the whole point: abort first, then let the cleanup turn remove credentials/skills.
  const abortAt = block.indexOf('abortActiveTurn(');
  const loopEnd = block.indexOf('if (paused.length > 0)');
  assert.ok(abortAt > 0 && abortAt < loopEnd, 'abort must run inside the matching loop, ahead of the report');
});

test('only schedules matching the cleanup target are touched', () => {
  assert.match(block, /if \(!matchesCleanupTarget\(s, targets\)\) continue;[\s\S]*abortActiveTurn/,
    'the match filter must gate the abort — unrelated schedules must keep running');
});
