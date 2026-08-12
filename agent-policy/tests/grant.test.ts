/**
 * GrantStore scope semantics.
 *
 * A grant is looked up by tool NAME — capability and domain are recorded but not compared — so
 * "who is this yes for" had no representation at all until `audience`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrantStore } from '../src/index.js';


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
