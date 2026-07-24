/**
 * The single-instance lock, when its refusal must not be forever.
 *
 * Production 2026-07-24 20:47: the owner restarted with the 13:06 process (pid 38736) still alive. The
 * lock refused the new gateway — correctly, two long-pollers steal each other's messages — but the
 * refusal was a fire-and-forget throw. When the old process later exited, nobody was polling WeChat and
 * every message went unanswered until the next manual restart. Meanwhile the boot banner printed
 * "WeChat: ✅ gateway scheduled" seconds after the crash.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewayLockHeldError, superviseGatewayStart } from '../src/channels/wechat/gateway.js';

const held = () => new GatewayLockHeldError({ pid: 38736, startedAt: Date.parse('2026-07-24T05:06:44.733Z') }, 'acct');
const noSleep = () => Promise.resolve();

test('the production shape: lock held twice, old process exits, gateway takes over', async () => {
  let attempts = 0;
  const blocked: number[] = [];
  const outcome = await superviseGatewayStart(
    async () => {
      attempts++;
      if (attempts <= 2) throw held();
      // third attempt: old pid is gone, start() runs to clean stop
    },
    { sleep: noSleep, onBlocked: (e) => blocked.push(e.holder.pid) },
  );
  assert.equal(outcome, 'stopped');
  assert.equal(attempts, 3, 'kept retrying until the lock freed — the old behavior stopped at 1');
  assert.deepEqual(blocked, [38736, 38736], 'each refusal is surfaced, with the holder pid');
});

test('a real crash is not retried — resurrection loops hide genuine defects', async () => {
  let attempts = 0;
  let crash: unknown;
  const outcome = await superviseGatewayStart(
    async () => {
      attempts++;
      throw new Error('ECONNREFUSED ilinkai.weixin.qq.com');
    },
    { sleep: noSleep, onCrash: (e) => (crash = e) },
  );
  assert.equal(outcome, 'crashed');
  assert.equal(attempts, 1);
  assert.match(String(crash), /ECONNREFUSED/);
});

test('shutdown during the wait ends the loop instead of starting a gateway nobody wants', async () => {
  let stop = false;
  const outcome = await superviseGatewayStart(
    async () => {
      stop = true; // simulate SIGINT arriving while we are lock-blocked
      throw held();
    },
    { sleep: noSleep, shouldStop: () => stop },
  );
  assert.equal(outcome, 'shutdown');
});

test('the error is typed — supervision must not depend on matching our own prose', () => {
  const e = held();
  assert.equal(e.name, 'GatewayLockHeldError');
  assert.ok(e instanceof GatewayLockHeldError);
  assert.match(e.message, /pid=38736/);
});
