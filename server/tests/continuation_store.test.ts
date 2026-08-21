import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteContinuation, loadContinuations, saveContinuation } from '../src/continuation_store.js';

test('continuation store persists, reloads and deletes a private atomic snapshot', () => {
  const previous = process.env.PHILONT_ROOT;
  const root = mkdtempSync(join(tmpdir(), 'philont-continuation-'));
  process.env.PHILONT_ROOT = root;
  try {
    saveContinuation({
      version: 1,
      sessionId: 'wechat:user',
      savedAt: 123,
      auth: {
        tool: 'shell',
        deliveredAt: 1_787_268_800_000,
        deliveryState: 'delivered',
      },
    });
    const dir = join(root, 'state', 'continuations');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.endsWith('.tmp'), false);
    assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
    assert.doesNotMatch(files[0]!, /wechat|user/);
    assert.equal(JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')).sessionId, 'wechat:user');
    assert.deepEqual(loadContinuations(), [
      {
        version: 1,
        sessionId: 'wechat:user',
        savedAt: 123,
        auth: {
          tool: 'shell',
          deliveredAt: 1_787_268_800_000,
          deliveryState: 'delivered',
        },
      },
    ]);
    deleteContinuation('wechat:user');
    assert.deepEqual(loadContinuations(), []);
  } finally {
    if (previous === undefined) delete process.env.PHILONT_ROOT;
    else process.env.PHILONT_ROOT = previous;
  }
});
