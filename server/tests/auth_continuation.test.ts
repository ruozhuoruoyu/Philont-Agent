import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPendingAuthReply,
  isPendingAuthExpired,
  PENDING_AUTH_TTL_MS,
  WORKFLOW_GRANT_TTL_MS,
} from '../src/auth-continuation.js';

test('pending auth has a practical 30 minute default window', () => {
  assert.equal(PENDING_AUTH_TTL_MS, 30 * 60_000);
  assert.equal(WORKFLOW_GRANT_TTL_MS, 30 * 60_000);
  assert.equal(isPendingAuthExpired(1_000, 1_000 + PENDING_AUTH_TTL_MS), false);
  assert.equal(isPendingAuthExpired(1_000, 1_001 + PENDING_AUTH_TTL_MS), true);
});

test('short continuation replies deterministically resume pending authorization', () => {
  for (const reply of ['OK', 'ok', '同意', '允许', '继续', '好的']) {
    assert.equal(classifyPendingAuthReply(reply), 'grant', reply);
  }
  for (const reply of ['no', '拒绝', '取消']) {
    assert.equal(classifyPendingAuthReply(reply), 'deny', reply);
  }
  assert.equal(classifyPendingAuthReply('请先解释风险'), 'unclear');
});
