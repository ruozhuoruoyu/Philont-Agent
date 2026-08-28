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
  let now = 10_000;
  const store = new GrantStore(() => now);
  store.grant('z3Verify', 'execute', 'local', 'approved', 1_000);

  // Asking is not using: isGranted must leave the clock alone.
  assert.equal(store.isGranted('z3Verify'), true);
  const beforeUse = store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt;
  assert.equal(store.isGranted('z3Verify'), true);
  assert.equal(store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt, beforeUse);

  // Using it late in the window pushes expiry one full TTL from actual use.
  now += 900;
  assert.equal(store.useGrant('z3Verify'), true);
  assert.equal(store.list().find((g) => g.toolName === 'z3Verify')!.expiresAt, now + 1_000);
});

test('renewal is bounded by a multiple of the window the caller asked for', () => {
  let now = 10_000;
  const store = new GrantStore(() => now);
  const ttl = 60_000;
  store.grant('pariGp', 'execute', 'local', 'approved', ttl);
  const issued = store.list().find((g) => g.toolName === 'pariGp')!;
  const ceiling = issued.issuedAt + ttl * RENEWAL_CEILING_FACTOR;
  for (let i = 0; i < 4; i++) {
    now += 50_000;
    assert.equal(store.useGrant('pariGp'), true);
  }
  assert.equal(store.list().find((g) => g.toolName === 'pariGp')!.expiresAt, ceiling);
  now = ceiling;
  assert.equal(store.useGrant('pariGp'), false, 'the hard ceiling eventually closes continuous use');
});

test('a lapsed grant is reported as expired, not as never-granted', () => {
  const store = new GrantStore();
  store.grant('shell', 'execute', 'local', 'approved', 0); // already expired on arrival
  // The prune that discovers the expiry is what records it.
  assert.equal(store.isGranted('shell'), false);
  const now = Date.now();
  assert.notEqual(store.expiredRecently('shell', 60 * 60_000, undefined, 'tool', undefined, now), null);
  assert.equal(store.expiredRecently('shell', 1, undefined, 'tool', undefined, now + 10_000), null, 'outside the window it is silent');
  assert.equal(store.expiredRecently('neverGranted', 60 * 60_000, undefined, 'tool', undefined, now), null);
});

test('expiry diagnostics match the same command scope and audience', () => {
  let now = 1_000;
  const store = new GrantStore(() => now);
  store.grant({
    toolName: 'shell', scope: 'command', pattern: 'lake *', capability: 'execute', domain: 'local',
    reason: 'Lean workflow', ttlMs: 100, audience: 'research:lrc',
  });
  now = 1_101;
  assert.equal(store.isGranted('shell', { command: 'lake build' }, 'command', 'research:lrc'), false);
  assert.notEqual(
    store.expiredRecently('shell', 1_000, { command: 'lake build' }, 'command', 'research:lrc'),
    null,
  );
  assert.equal(
    store.expiredRecently('shell', 1_000, { command: 'git push' }, 'command', 'research:lrc'),
    null,
    'an unrelated command was never covered by the expired approval',
  );
  assert.equal(
    store.expiredRecently('shell', 1_000, { command: 'lake build' }, 'command', 'research:other'),
    null,
    'an approval for another audience must not be attributed to this caller',
  );
});
