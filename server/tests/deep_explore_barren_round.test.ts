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

// ── Which question did this round advance? (2026-07-27) ─────────────────────
//
// The owner and the agent were on Lonely Runner. The agent closed that session; the next bare "continue"
// silently resumed a graph-visualisation session created three days earlier, because getMostRecentActive
// Session ordered by created_at while listActiveSessions had always ordered by updated_at — two functions
// answering the same question two ways. The round then spent six minutes on 知识图谱 / 思维导图 / RDF
// while the owner believed LRC was advancing, until: 这是跑偏到什么地方去了？
import { renderSessionSubject } from '../src/deep_explore.js';

test('every round result names the question it advanced', () => {
  const out = renderSessionSubject('攻克「孤独跑者猜想」（Lonely Runner Conjecture）。根本约束：不能重复已知论文的路径', 'abc-123');
  assert.match(out, /孤独跑者/, 'the subject must be readable at a glance');
  assert.match(out, /session id: abc-123/);
});

test('a long goal is truncated but still identifies the problem', () => {
  const out = renderSessionSubject('x'.repeat(500), 'id');
  assert.ok(out.split('\n')[0].length < 130, 'the subject is one line, not a wall');
  assert.match(out, /…/);
});

// The auto-advance line joined this block on 2026-07-28. It is held to the same standard the subject is:
// the round result is read by a person on a phone, so anything added here must be one short line or it
// becomes the noise it was meant to reduce.
test('a goal with newlines stays on one line — the switch must be visible, not buried', () => {
  const out = renderSessionSubject('攻克 LRC\n\n已知进展：\n- k<=12 已证', 'id');
  const lines = out.split('\n');
  assert.equal(lines.length, 3, 'subject line + auto line + id line');
  assert.match(lines[0], /^on: "攻克 LRC 已知进展/, 'the goal is first and unwrapped');
  assert.ok(lines[1].length < 60, 'the auto-advance offer is a marker, not a paragraph');
});
