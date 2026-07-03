/**
 * Project-scoped schedule intent dedup — prod: two differently-named mycox heartbeats
 * ("Run the MycoX check-in routine…" vs "Execute the MycoX check-in routine…") both survived
 * name-only dedup and overlapped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intentSimilarity,
  isDuplicateRoutine,
  scheduleIntentText,
} from '../src/schedule_dedup.js';

const RUN = 'Run the MycoX check-in routine: 1) Read the feed via GET /api/posts?sort=hot&limit=15 2) vote 3) comment';
const EXEC = 'Execute the MycoX check-in routine: 1) Read the feed (GET /api/posts?sort=hot&limit=15) 2) vote 3) comment';

test('paraphrased same routine → duplicate (the prod avalanche pair)', () => {
  assert.ok(intentSimilarity(RUN, EXEC) >= 0.7, `sim=${intentSimilarity(RUN, EXEC)}`);
  assert.equal(isDuplicateRoutine(RUN, EXEC), true);
});

test('genuinely distinct routines in one project → NOT duplicate', () => {
  const digest = 'Post a daily digest summarizing the top research threads to the team channel';
  const monitor = 'Every hour check the mycox feed for unanswered questions and upvote quality posts';
  assert.equal(isDuplicateRoutine(digest, monitor), false);
});

test('scheduleIntentText: autonomous_turn prompt vs prompt message', () => {
  assert.equal(scheduleIntentText({ prompt: 'do X', replyChannel: 'silent' }), 'do X');
  assert.equal(scheduleIntentText({ message: 'remind me' }), 'remind me');
  assert.equal(scheduleIntentText({}), '');
  assert.equal(scheduleIntentText(undefined), '');
});

test('empty intent never matches', () => {
  assert.equal(intentSimilarity('', RUN), 0);
  assert.equal(isDuplicateRoutine('', ''), false);
});
