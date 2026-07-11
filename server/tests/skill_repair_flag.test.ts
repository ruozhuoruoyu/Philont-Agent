/**
 * H3 skill self-repair — registration gate.
 *
 * SkillRepairDriver is DEFAULT ON (2026-07-11, after two clean dogfood runs), but it is the only
 * autonomous driver whose outcome REWRITES a reusable artifact, so it keeps its own kill switch:
 * PHILONT_SKILL_REPAIR=0/off/false/no disables. This file asserts the shipped default (on) and that
 * the kill switch actually removes it.
 *
 * The env var is read at module load, so the DISABLED path is verified in a subprocess below rather
 * than by mutating process.env after chat-handler has already been imported (which would be a no-op
 * and would silently pass). This test file itself must NOT set PHILONT_SKILL_REPAIR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { autonomousDriverNames, skillRepairEnabled } from '../src/chat-handler.js';

test('skillRepairEnabled: default ON; only explicit falsy values disable it', () => {
  const saved = process.env.PHILONT_SKILL_REPAIR;
  try {
    for (const on of [undefined, '', '1', 'on', 'true', 'yes', 'anything-else']) {
      if (on === undefined) delete process.env.PHILONT_SKILL_REPAIR;
      else process.env.PHILONT_SKILL_REPAIR = on;
      assert.equal(skillRepairEnabled(), true, `${JSON.stringify(on)} must leave skill repair on`);
    }
    for (const off of ['0', 'off', 'false', 'no', 'OFF', ' No ']) {
      process.env.PHILONT_SKILL_REPAIR = off;
      assert.equal(skillRepairEnabled(), false, `${JSON.stringify(off)} must disable skill repair`);
    }
  } finally {
    if (saved === undefined) delete process.env.PHILONT_SKILL_REPAIR;
    else process.env.PHILONT_SKILL_REPAIR = saved;
  }
});

test('AUTONOMOUS_DRIVERS: skill_repair IS registered by default, alongside the baseline drivers', () => {
  assert.ok(
    autonomousDriverNames.includes('skill_repair'),
    `default driver set must include skill_repair, got: ${autonomousDriverNames.join(', ')}`,
  );
  // the three long-standing drivers are still there — the conditional spread didn't eat them
  for (const name of ['gap', 'curiosity', 'pursuit']) {
    assert.ok(autonomousDriverNames.includes(name), `missing baseline driver ${name}`);
  }
});

test('AUTONOMOUS_DRIVERS: PHILONT_SKILL_REPAIR=0 actually removes the driver (fresh process)', () => {
  // A fresh process is the only honest way to test the kill switch: chat-handler reads the env at
  // module load, so mutating process.env after this file's own import would be a no-op.
  const script =
    `import('./src/chat-handler.js').then(m => {` +
    `  console.log(m.autonomousDriverNames.includes('skill_repair') ? 'REGISTERED' : 'MISSING');` +
    `  process.exit(0);` +
    `});`;
  const out = execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PHILONT_SKILL_REPAIR: '0', PHILONT_AUTONOMOUS: '0' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.match(out, /MISSING/, `expected skill_repair to be gone under =0; output: ${out}`);
});
