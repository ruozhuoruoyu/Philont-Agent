/**
 * GrantStore scope semantics.
 *
 * A grant is looked up by tool NAME — capability and domain are recorded but not compared — so
 * "who is this yes for" had no representation at all until `audience`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrantStore, RENEWAL_CEILING_FACTOR } from '../src/index.js';


test('an audience-scoped grant answers to that audience and to nothing else', () => {
  const g = new GrantStore();
  // What background research gets when the owner approves its request.
  g.grant({
    toolName: 'shell',
    capability: 'execute',
    domain: 'system',
    reason: 'research:p-1',
    audience: 'research',
    ttlMs: 60_000,
  });

  assert.equal(g.isGranted('shell', undefined, 'tool', 'research'), true, 'reaches the loop it was for');
  // Lookup is by tool NAME, so before this the same yes was a yes for the main loop and for any
  // plan sub-task, for the whole window. The reason string recorded which research asked; nothing
  // read it.
  assert.equal(g.isGranted('shell'), false, 'and not for anyone else');
  assert.equal(g.isGranted('shell', undefined, 'tool', 'other'), false);
});

test('an ordinary grant still answers to everyone, including audiences', () => {
  const g = new GrantStore();
  // An approval the owner gave in conversation about the work in front of them.
  g.grant('shell', 'execute', 'local', 'user said OK', 60_000);
  assert.equal(g.isGranted('shell'), true);
  assert.equal(g.isGranted('shell', undefined, 'tool', 'research'), true, 'unscoped grants are unchanged');
});

// ── renewal on use (2026-08-28) ───────────────────────────────────────────────────────────────────
//
// The TTL was measuring time since approval, not whether the authorised loop was still running. Prod:
// a 30-minute grant issued at 10:34:41 lapsed at 11:04:41 while the turn it covered was still working,
// and every verifier call after that was denied by the matrix — the turn kept going and reported a
// compile result with its verifiers dark.

test('a granted call in progress re-arms its own window; merely asking does not', () => {
  const store = new GrantStore();
  store.grant('z3Verify', 'execute', 'local', 'approved', 1_000);

  // Asking is not using: isGranted must leave the clock alone.
  assert.equal(store.isGranted('z3Verify'), true);
  const beforeUse = store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt;
  assert.equal(store.isGranted('z3Verify'), true);
  assert.equal(store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt, beforeUse);

  // Using it pushes the window out from now.
  assert.equal(store.useGrant('z3Verify'), true);
  assert.ok(store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt >= beforeUse);
});

test('renewal is bounded by a multiple of the window the caller asked for', () => {
  const store = new GrantStore();
  const ttl = 60_000;
  store.grant('pariGp', 'execute', 'local', 'approved', ttl);
  const issued = store.list().find((g) => g.toolName === 'pariGp')!;
  const ceiling = issued.issuedAt + ttl * RENEWAL_CEILING_FACTOR;
  for (let i = 0; i < 20; i++) store.useGrant('pariGp');
  assert.ok(
    store.list().find((g) => g.toolName === 'pariGp')!.expiresAt <= ceiling,
    'continuous use must not hold a grant open forever',
  );
});

test('a lapsed grant is reported as expired, not as never-granted', () => {
  const store = new GrantStore();
  store.grant('shell', 'execute', 'local', 'approved', 0); // already expired on arrival
  // The prune that discovers the expiry is what records it.
  assert.equal(store.isGranted('shell'), false);
  const now = Date.now();
  assert.notEqual(store.expiredRecently('shell', 60 * 60_000, now), null);
  assert.equal(store.expiredRecently('shell', 1, now + 10_000), null, 'outside the window it is silent');
  assert.equal(store.expiredRecently('neverGranted', 60 * 60_000, now), null);
});
