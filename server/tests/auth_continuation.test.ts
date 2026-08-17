import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPendingAuthExpired,
  PENDING_AUTH_TTL_MS,
  resolvePendingAuthTtlMs,
  WORKFLOW_GRANT_TTL_MS,
} from '../src/auth-continuation.js';
import { matchOfferedAuthWord } from '../src/auth_intent.js';

test('pending auth has a practical 30 minute default window', () => {
  assert.equal(PENDING_AUTH_TTL_MS, 30 * 60_000);
  assert.equal(WORKFLOW_GRANT_TTL_MS, 30 * 60_000);
  assert.equal(isPendingAuthExpired(1_000, 1_000 + PENDING_AUTH_TTL_MS), false);
  assert.equal(isPendingAuthExpired(1_000, 1_001 + PENDING_AUTH_TTL_MS), true);
});

test('only the words printed on auth cards take the deterministic path', () => {
  for (const reply of ['同意', 'approve', 'yes']) assert.equal(matchOfferedAuthWord(reply), 'grant', reply);
  for (const reply of ['拒绝', 'reject', 'no']) assert.equal(matchOfferedAuthWord(reply), 'deny', reply);
  for (const reply of ['OK', '继续', '好', '可以', '确认', '取消', '算了']) {
    assert.equal(matchOfferedAuthWord(reply), null, reply);
  }
});

test('pending auth TTL accepts the legacy env name but prefers the namespaced one', () => {
  assert.equal(resolvePendingAuthTtlMs({ PENDING_AUTH_TTL_MS: '1234' }), 1234);
  assert.equal(resolvePendingAuthTtlMs({
    PENDING_AUTH_TTL_MS: '1234',
    PHILONT_PENDING_AUTH_TTL_MS: '5678',
  }), 5678);
});
