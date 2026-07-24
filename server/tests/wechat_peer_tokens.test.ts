/**
 * The per-peer context-token cache — the push path's missing half.
 *
 * Reference: hermes weixin.py keeps a disk-backed token store keyed by account + peer, updated on every
 * inbound, and every outbound echoes the peer's latest token. philont's port carried the reply half only,
 * so proactive pushes went tokenless — and twelve hours of production drew the line exactly: replies
 * worked throughout while pushes failed ret=-2 "prepare failed" at +8s, +20min and +40min. Same session,
 * same client; the only difference between the live path and the dead one was this field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writePeerToken, readPeerToken } from '../src/channels/wechat/state.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ACCOUNT = 'test-peer-tokens-account';
const cleanup = () => {
  try { rmSync(join(homedir(), '.philont', 'wechat', 'accounts', ACCOUNT), { recursive: true, force: true }); } catch { /* absent */ }
};

test('the freshest inbound token wins, per peer', () => {
  cleanup();
  writePeerToken(ACCOUNT, 'peer-a@im.wechat', 'tok-1');
  writePeerToken(ACCOUNT, 'peer-b@im.wechat', 'tok-b');
  writePeerToken(ACCOUNT, 'peer-a@im.wechat', 'tok-2');
  assert.equal(readPeerToken(ACCOUNT, 'peer-a@im.wechat'), 'tok-2');
  assert.equal(readPeerToken(ACCOUNT, 'peer-b@im.wechat'), 'tok-b');
  cleanup();
});

test('an unknown peer reads null — the push degrades to the old tokenless behaviour, never throws', () => {
  cleanup();
  assert.equal(readPeerToken(ACCOUNT, 'never-seen@im.wechat'), null);
  assert.equal(readPeerToken('never-seen-account', 'x'), null);
});

test('an empty token is not cached — a blank must not shadow a real one', () => {
  cleanup();
  writePeerToken(ACCOUNT, 'peer-a@im.wechat', 'tok-real');
  writePeerToken(ACCOUNT, 'peer-a@im.wechat', '');
  assert.equal(readPeerToken(ACCOUNT, 'peer-a@im.wechat'), 'tok-real');
  cleanup();
});
