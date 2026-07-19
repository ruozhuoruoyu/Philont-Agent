import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMatchesHint, ENDPOINT_HINTS } from '../src/plan_execute_loop.js';

/** The hint a "publish a post" deliverable resolves to. */
const publishHint = ENDPOINT_HINTS.find(([k]) => k.test('Publish the first substantive post'))![1];

test('a real POST to the posts COLLECTION satisfies the publish hint (prod false-negative)', () => {
  // Prod 2026-07-19: this exact call returned ok and the deliverable still reported FAILED, because the
  // url and tool name were concatenated before matching, so `$` could never anchor.
  assert.equal(callMatchesHint(publishHint, 'https://mycox.ai/api/posts', 'http'), true);
});

test('a sub-resource write does NOT satisfy it — the anchor still does its job', () => {
  // This is why the hint is anchored: an upvote must not pass off as publishing.
  assert.equal(callMatchesHint(publishHint, 'https://mycox.ai/api/posts/abc123/upvote', 'http'), false);
  assert.equal(callMatchesHint(publishHint, 'https://mycox.ai/api/posts/abc123/comments', 'http'), false);
});

test('concatenating url + tool name is what broke it — verify the old form would fail', () => {
  // Guard against a regression back to `${url} ${name}`.
  assert.equal(publishHint.test('https://mycox.ai/api/posts http'), false, 'the old concatenated form never matched');
  assert.equal(publishHint.test('https://mycox.ai/api/posts'), true, 'the url alone matches');
});

test('a trailing slash and a query string both still match the collection', () => {
  assert.equal(callMatchesHint(publishHint, 'https://mycox.ai/api/posts/', 'http'), true);
  assert.equal(callMatchesHint(publishHint, 'https://mycox.ai/api/posts?draft=false', 'http'), true);
});

test('the tool name is still matched independently (hints may name a tool)', () => {
  const scheduleish = /schedule_reminder/;
  assert.equal(callMatchesHint(scheduleish, undefined, 'schedule_reminder'), true);
  assert.equal(callMatchesHint(scheduleish, 'https://x.test/anything', 'http'), false);
});
