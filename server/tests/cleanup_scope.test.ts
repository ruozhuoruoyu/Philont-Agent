/**
 * Cleanup-turn scoping tests — target extraction, schedule matching, external-write rejection.
 * Prod motivation: clear turns re-registered the service being cleared (409, burned invites), and
 * the project's scheduled check-in raced the clear and resurrected half-deleted state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCleanupTargets,
  matchesCleanupTarget,
  cleanupHttpWriteReject,
} from '../src/cleanup_scope.js';
import type { Schedule } from '@agent/memory';

function fakeSchedule(over: Partial<Schedule>): Schedule {
  return {
    id: 'id-1',
    name: 'daily-reflect',
    cronExpr: null,
    nextRunAt: 0,
    lastRunAt: null,
    actionType: 'autonomous_turn',
    payload: null,
    enabled: true,
    createdAt: 0,
    createdBy: 'user',
    consecutiveFailures: 0,
    pausedUntil: null,
    project: null,
    ...over,
  } as Schedule;
}

test('extractCleanupTargets: names the service, drops cleanup vocabulary', () => {
  assert.deepEqual(extractCleanupTargets('清除mycox相关记忆和技能'), ['mycox']);
  assert.deepEqual(extractCleanupTargets('delete all mycox related skills and memories'), ['mycox']);
  // Untargeted cleanup → no targets (pausing does nothing; cancel_schedule handles the ask).
  assert.deepEqual(extractCleanupTargets('清除所有定时'), []);
  assert.deepEqual(extractCleanupTargets('clear all schedules and reminders'), []);
});

test('matchesCleanupTarget: matches name / project / payload, case-insensitive', () => {
  const targets = ['mycox'];
  assert.ok(matchesCleanupTarget(fakeSchedule({ name: 'MyCox-checkin' }), targets));
  assert.ok(matchesCleanupTarget(fakeSchedule({ project: 'mycox' }), targets));
  assert.ok(matchesCleanupTarget(fakeSchedule({ payload: { message: 'Run the MycoX check-in' } }), targets));
  assert.ok(!matchesCleanupTarget(fakeSchedule({ name: 'daily-reflect' }), targets));
  assert.ok(!matchesCleanupTarget(fakeSchedule({ name: 'mycox-checkin' }), []));
});

test('cleanupHttpWriteReject: blocks external writes, allows GET and non-http tools', () => {
  const post = cleanupHttpWriteReject('http', { url: 'https://mycox.ai/api/auth/register-agent', method: 'POST' });
  assert.ok(post);
  assert.match(post!.error, /cleanup/i);
  assert.ok(cleanupHttpWriteReject('http', { method: 'PUT' }));
  assert.ok(cleanupHttpWriteReject('http', { method: 'delete' }));
  assert.equal(cleanupHttpWriteReject('http', { url: 'https://mycox.ai/api/posts', method: 'GET' }), null);
  assert.equal(cleanupHttpWriteReject('http', {}), null); // method defaults to GET
  assert.equal(cleanupHttpWriteReject('forget_skill', { contains: 'mycox' }), null);
  assert.equal(cleanupHttpWriteReject('cancel_schedule', { name: 'mycox' }), null);
});
