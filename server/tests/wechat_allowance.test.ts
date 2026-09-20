import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundAllowance, DEFAULT_PEER_ALLOWANCE, REFUSAL_WINDOW } from '../src/channels/wechat/allowance.js';

// The ledger behind three outages: 2026-09-13 17:32 (9 sends), 19:06 (10), 2026-09-14 07:18 (10) — and a
// follow-up that went through at 05:29, six hours after the inbound, with one send on the ledger.

test('an inbound refills the allowance; every accepted message spends one', () => {
  const a = new OutboundAllowance(undefined, DEFAULT_PEER_ALLOWANCE, () => 1);
  assert.deepEqual(a.view('owner'), { remaining: 10, total: 10, sentSince: 0 });
  for (let i = 0; i < 7; i++) a.onSent('owner');
  assert.equal(a.view('owner').remaining, 3);
  a.onInbound('owner');
  assert.equal(a.view('owner').remaining, 10, 'the peer wrote: a fresh ten');
});

test('a refusal after N sends teaches the total; a success past the total corrects it upward', () => {
  const a = new OutboundAllowance(undefined, 10, () => 1);
  for (let i = 0; i < 8; i++) a.onSent('owner');
  a.onRefused('owner');
  assert.equal(a.view('owner').total, 8, 'the platform said eight');
  assert.equal(a.view('owner').remaining, 0);
  a.onInbound('owner');
  for (let i = 0; i < 9; i++) a.onSent('owner');
  assert.equal(a.view('owner').total, 9, 'nine went through, so the total was not eight');
});

test('a refusal with nothing sent since the inbound is not a quota lesson', () => {
  const a = new OutboundAllowance(undefined, 10, () => 1);
  a.onInbound('owner');
  a.onRefused('owner');
  assert.equal(a.view('owner').total, 10, 'zero is not an allowance; some other failure');
});

test('the ledger survives a restart mid-window', () => {
  let disk: Record<string, { total: number; sentSince: number; updatedAt: number }> = {};
  const persistence = { load: () => disk, save: (m: typeof disk) => { disk = JSON.parse(JSON.stringify(m)); } };
  const first = new OutboundAllowance(persistence, 10, () => 1);
  for (let i = 0; i < 6; i++) first.onSent('owner');
  // prod 2026-09-13 22:39 → 22:49: restarted with six on the ledger
  const second = new OutboundAllowance(persistence, 10, () => 2);
  assert.equal(second.view('owner').sentSince, 6);
  assert.equal(second.view('owner').remaining, 4);
});

test('a broken ledger file is relearned, never fatal', () => {
  const a = new OutboundAllowance({ load: () => { throw new Error('corrupt'); }, save: () => { throw new Error('ro'); } }, 10, () => 1);
  a.onSent('owner');
  assert.equal(a.view('owner').sentSince, 1);
});

test('one low refusal is an observation, not the total; a repeated one is learned', () => {
  // Prod 2026-09-19/20: one refusal after 3 sends pinned the total at 3, every report of the night was
  // held at remaining=0/3, and the blocking card sent at that "exhausted" ledger went through.
  const a = new OutboundAllowance(undefined, 10, () => 1);
  for (let i = 0; i < 9; i++) a.onSent('owner');
  a.onRefused('owner');
  assert.equal(a.view('owner').total, 9);
  a.onInbound('owner');
  for (let i = 0; i < 3; i++) a.onSent('owner');
  a.onRefused('owner');
  assert.equal(a.view('owner').total, 9, 'the outlier does not override the recent nine');
  assert.equal(a.view('owner').remaining, 6, 'the next sends are attempted; a refusal only defers');
  for (let k = 0; k < REFUSAL_WINDOW - 1; k++) {
    a.onInbound('owner');
    for (let i = 0; i < 3; i++) a.onSent('owner');
    a.onRefused('owner');
  }
  assert.equal(a.view('owner').total, 3, 'refused at three for the whole window: that is the allowance now');
  // A success past the learned total still corrects upward immediately.
  a.onInbound('owner');
  for (let i = 0; i < 4; i++) a.onSent('owner');
  assert.equal(a.view('owner').total, 4);
});

test('a ledger file from before the window (no refusalPoints) still loads and learns', () => {
  const store: Record<string, { total: number; sentSince: number; refusalPoints?: number[]; updatedAt: number }> = {
    owner: { total: 3, sentSince: 3, updatedAt: 1 },
  };
  const a = new OutboundAllowance({ load: () => store, save: (m) => Object.assign(store, m) }, 10, () => 2);
  assert.equal(a.view('owner').remaining, 0, 'the persisted total is honoured until relearned');
  a.onInbound('owner');
  for (let i = 0; i < 8; i++) a.onSent('owner');
  a.onRefused('owner');
  assert.deepEqual(store.owner.refusalPoints, [8]);
  assert.equal(a.view('owner').total, 8);
});
