import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellTimeoutRetryRejection } from '../src/shell_timeout_retry.js';
import { isMechanicalFailure } from '../src/in_turn_reflection.js';

test('timeout permits a larger bounded retry and unrelated diagnostics, not unchanged retries', () => {
  const failed = { toolName: 'shell', success: false, toolInput: { command: 'lake build', timeout: 180000 }, resultText: 'killed=true (likely timeout)' };
  assert.ok(shellTimeoutRetryRejection(failed.toolInput, [failed]));
  assert.equal(shellTimeoutRetryRejection({ command: 'lake build', timeout: 600000 }, [failed]), null);
  assert.equal(shellTimeoutRetryRejection({ command: 'dir' }, [failed, failed, failed]), null);
  assert.ok(shellTimeoutRetryRejection({ command: 'lake build', timeout: 600000 }, [failed, failed, failed]));
  assert.equal(isMechanicalFailure('shell:timeout'), true);
  assert.equal(isMechanicalFailure('shell:permission-denied'), false);
});
