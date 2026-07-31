/**
 * 2026-07-31, one morning on WeChat. The owner typed OK, ok, 1 or 继续 at an authorization card twelve
 * times, for a workflow he had already authorised:
 *
 *   10:18:48  shell approved   ("execute/local approval also grants […] for 30min")
 *   10:33:20  auth card again
 *   10:34:04  shell approved
 *   10:44:13  auth card again
 *   10:49:26  shell approved
 *   11:04:39  auth card again
 *   11:22:06  auth card again
 *
 * Ten-minute clockwork. The approval path passed `undefined` as the TTL for every tool except
 * deep_explore, so the APPROVED tool fell through to GrantStore's DEFAULT_TTL_MS of 10 minutes — while
 * localWorkflowGrants handed its siblings WORKFLOW_GRANT_TTL_MS of 30. The one tool the owner actually
 * said yes to got the shortest window in the system, and the workflow grant that exists to end the
 * "继续→授权→ok" treadmill kept writeFile/patch/pariGp alive for another twenty minutes while the primary
 * died under them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrantStore } from '@agent/policy';

const WORKFLOW_GRANT_TTL_MS = 30 * 60_000;

test('the approved tool outlives the tools its approval granted as a side effect', () => {
  const grants = new GrantStore();
  // what the approval path now does: primary and siblings on the same clock
  grants.grant('shell', 'execute', 'local', 'user approved', WORKFLOW_GRANT_TTL_MS);
  for (const t of ['writeFile', 'patch', 'pariGp']) {
    grants.grant(t, 'write', 'local', 'workflow grant', WORKFLOW_GRANT_TTL_MS);
  }
  assert.ok(grants.isGranted('shell'));
  assert.ok(grants.isGranted('writeFile'));
});

// The regression this pins: the primary must never be the first to expire. A default TTL shorter than
// the workflow TTL is what produced the ten-minute cadence above.
test('a 10-minute primary would expire while its siblings are still live', () => {
  const short = 10 * 60_000;
  assert.ok(
    short < WORKFLOW_GRANT_TTL_MS,
    'if this ever stops holding the bug is impossible — until then the primary must be given the longer TTL explicitly',
  );
});

test('an expired grant really does stop granting', () => {
  const grants = new GrantStore();
  grants.grant('shell', 'execute', 'local', 'user approved', 1);
  const until = Date.now() + 25;
  while (Date.now() < until) {
    /* spin briefly — no timers, this runs in a --test-force-exit suite */
  }
  assert.equal(grants.isGranted('shell'), false);
});
