/**
 * Capability manifest — pure renderers + inject flag. The point of this feature is that the manifest is
 * GENERATED, not authored, so these tests pin the shape and the on/off wiring, not any hardcoded blurb.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCapabilityManifest,
  renderCapabilityDetail,
  capabilityManifestInjectEnabled,
  type CapabilityState,
} from '../src/capability_manifest.js';

function state(over: Partial<CapabilityState> = {}): CapabilityState {
  return {
    skillSelfRepair: true,
    recipeReuseVerify: true,
    skillVersioning: true,
    selfObservations: true,
    liveTraits: true,
    constitutionProposals: true,
    deepExplore: true,
    autonomousLoop: true,
    executionLedger: true,
    autonomousDrivers: ['gap', 'curiosity', 'pursuit', 'skill_repair'],
    toolCount: 42,
    ...over,
  };
}

test('renderCapabilityManifest: reflects ON/off from state, lists drivers, tells the agent to consult it', () => {
  const on = renderCapabilityManifest(state());
  assert.match(on, /skill self-repair ON/);
  assert.match(on, /skill_repair/); // driver listed
  // the standing instruction — the whole reason it exists
  assert.match(on, /do NOT answer from a remembered older version/);
  assert.match(on, /self_capabilities/); // points to the depth tool

  // a disabled capability must read off, not vanish silently — the manifest is the source of truth
  const off = renderCapabilityManifest(state({ skillSelfRepair: false }));
  assert.match(off, /skill self-repair off/);
});

test('renderCapabilityManifest: the exact three features a stale self-model got wrong are all present', () => {
  // prod 2026-07-11: the agent reported these as ❌ days after they shipped+enabled.
  const m = renderCapabilityManifest(state());
  assert.match(m, /skill self-repair/i);
  assert.match(m, /skill versioning/i);
  assert.match(m, /revision history/i); // the versioning substance
});

test('renderCapabilityManifest: empty driver set omits the drivers line rather than printing an empty one', () => {
  const m = renderCapabilityManifest(state({ autonomousDrivers: [] }));
  assert.doesNotMatch(m, /Autonomous drivers running:/);
});

test('renderCapabilityDetail: fuller surface includes tool count + what each self-learning feature does', () => {
  const d = renderCapabilityDetail(state({ toolCount: 7 }));
  assert.match(d, /Tools available: 7/);
  assert.match(d, /diagnosed from its real failed runs/); // self-repair explanation
  assert.match(d, /revision_history/); // versioning explanation
  assert.match(d, /never amendable/); // red-lines caveat on constitution proposals
  // still generated-truth framing, not a static blurb
  assert.match(d, /read from live process state/);
});

test('capabilityManifestInjectEnabled: default ON; only explicit falsy disables (kill switch idiom)', () => {
  assert.equal(capabilityManifestInjectEnabled({} as NodeJS.ProcessEnv), true);
  for (const on of ['', '1', 'on', 'true', 'yes', 'whatever']) {
    assert.equal(capabilityManifestInjectEnabled({ PHILONT_CAPABILITY_MANIFEST: on } as NodeJS.ProcessEnv), true, `${on} → on`);
  }
  for (const off of ['0', 'off', 'false', 'no', 'OFF']) {
    assert.equal(capabilityManifestInjectEnabled({ PHILONT_CAPABILITY_MANIFEST: off } as NodeJS.ProcessEnv), false, `${off} → off`);
  }
});
