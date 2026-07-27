/**
 * A round that committed nothing must not report itself as progress.
 *
 * Production 2026-07-27, five consecutive "继续" on the Lonely Runner session. Each round spent its calls
 * on list_facts / search_notes / search_skills, committed nothing to the tree, and came back as:
 *
 *     Reasoning advanced; session still active.
 *     This round: 18 still open; (hit this round's iteration cap; you can continue)
 *
 * Both halves false. Nothing advanced, and the round did not run out of iterations — it stopped early for
 * NO PROGRESS after two calls. Blaming the cap and inviting "you can continue" is what produced the next
 * identical round, and the next. The candidate pile went 11 → 16 → 17 → 18 open with 0 proved and 0 dead
 * ends the whole way.
 *
 * The diverge path was given this tooth on 2026-07-25 (barren diverge round). The advance path is the
 * mirror, and it was left open — the same symmetric-problem-fixed-once shape this repo keeps hitting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { committedNothing } from '../src/deep_explore.js';
import type { ProgressSummary } from '../src/deep_explore.js';

const summary = (o: Partial<ProgressSummary> = {}): ProgressSummary => ({
  newlyProved: [],
  newlyRefuted: [],
  newDeadEnds: [],
  stillOpen: 18,
  decomposedInto: 0,
  ...o,
});

test('the production shape — 18 open, nothing else — is barren', () => {
  assert.equal(committedNothing(summary()), true);
});

test('any single commitment makes a round non-barren', () => {
  assert.equal(committedNothing(summary({ decomposedInto: 3 })), false);
  assert.equal(committedNothing(summary({ newlyProved: ['lemma A'] })), false);
  assert.equal(committedNothing(summary({ newlyRefuted: ['bad idea'] })), false);
  // A dead end is a real result: the tree learned that a branch is closed.
  assert.equal(committedNothing(summary({ newDeadEnds: ['that angle'] })), false);
});

test('open nodes alone are not progress — they are the backlog, not the work', () => {
  assert.equal(committedNothing(summary({ stillOpen: 999 })), true);
});
