import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
const cleanupBlock = (() => {
  const i = src.indexOf('if (looksLikeCleanupIntent(userMessage)) {');
  return src.slice(i, i + 1600);
})();

test('a cleanup command anchors a fresh episode', () => {
  // Otherwise the turn is judged on a same_root_cause ledger that predates it: prod saw a clear run 18 tools
  // with zero failures and still fire stop_and_report over the previous night's failures.
  assert.match(cleanupBlock, /episodeAnchorTs\.set\(sessionId, Date\.now\(\)\)/,
    'clearing a direction must reset the accumulated stop signals for it');
});

test('the anchor is set before the viability gate reads it', () => {
  // Ordering matters: the cleanup block runs early in the turn, the gate computes vSameRoot much later.
  const anchorAt = src.indexOf('episodeAnchorTs.set(sessionId, Date.now())');
  const gateAt = src.indexOf('sameRootCause: vSameRoot');
  assert.ok(anchorAt > 0 && gateAt > 0 && anchorAt < gateAt,
    'the anchor must be established before the gate consumes the ledger');
});

test('the ledger window still honours the anchor', () => {
  // The anchor is only useful because the window is lower-bounded by it.
  assert.match(src, /episodeAnchorTs\.get\(sessionId\) \?\? 0/,
    'vSameRoot must clamp its window to the episode anchor');
});
