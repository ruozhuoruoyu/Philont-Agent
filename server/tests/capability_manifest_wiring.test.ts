/**
 * Capability manifest — live wiring. Proves the manifest reads the REAL runtime state (not a hardcoded
 * blurb), and specifically that the 2026-07-11 stale-self-model bug is now fixed: with skill self-repair
 * default-on, the agent's ground-truth capability state reports it as available, so a self-evaluation
 * can no longer mark it ❌ from stale memory.
 *
 * Imports chat-handler (which boots the runtime once at module load); PHILONT_AUTONOMOUS=0 in the env keeps
 * the idle loop from doing work during the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentCapabilityState } from '../src/chat-handler.js';
import { renderCapabilityManifest } from '../src/capability_manifest.js';

test('currentCapabilityState: reflects live defaults — skill self-repair on, drivers include skill_repair', () => {
  const s = currentCapabilityState();
  // These are the exact axes a stale self-model reported as ❌ in prod on 2026-07-11.
  assert.equal(s.skillSelfRepair, true, 'skill self-repair is default-on — the manifest must say so');
  assert.equal(s.skillVersioning, true);
  assert.equal(s.recipeReuseVerify, true);
  assert.ok(s.autonomousDrivers.includes('skill_repair'), 'skill_repair driver is registered by default');
  assert.ok(s.toolCount > 0, 'tool count is read from the live registry');
});

test('renderCapabilityManifest(live): the injected block now advertises the just-shipped features as ON', () => {
  const block = renderCapabilityManifest(currentCapabilityState());
  assert.match(block, /skill self-repair ON/);
  assert.match(block, /skill versioning ON/);
  // and the standing instruction that prevents answering from a stale self-image
  assert.match(block, /do NOT answer from a remembered older version/);
});
