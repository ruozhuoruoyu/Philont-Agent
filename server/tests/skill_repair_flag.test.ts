/**
 * H3 skill self-repair — registration gate.
 *
 * SkillRepairDriver is the only autonomous driver whose outcome REWRITES a reusable artifact
 * (a callable recipe's steps), so it must stay off unless PHILONT_SKILL_REPAIR is explicitly set.
 * This file must NOT set that env var: it asserts the shipped default.
 *
 * The env var is read at module load, so the enabled path is verified in a subprocess below rather
 * than by mutating process.env after chat-handler has already been imported (which would be a no-op
 * and would silently pass).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { autonomousDriverNames, skillRepairEnabled } from '../src/chat-handler.js';

test('skillRepairEnabled: default OFF; only explicit truthy values enable it', () => {
  const saved = process.env.PHILONT_SKILL_REPAIR;
  try {
    for (const off of [undefined, '', '0', 'off', 'false', 'no', 'maybe']) {
      if (off === undefined) delete process.env.PHILONT_SKILL_REPAIR;
      else process.env.PHILONT_SKILL_REPAIR = off;
      assert.equal(skillRepairEnabled(), false, `${JSON.stringify(off)} must not enable skill repair`);
    }
    for (const on of ['1', 'on', 'true', 'yes', 'YES', ' On ']) {
      process.env.PHILONT_SKILL_REPAIR = on;
      assert.equal(skillRepairEnabled(), true, `${JSON.stringify(on)} must enable skill repair`);
    }
  } finally {
    if (saved === undefined) delete process.env.PHILONT_SKILL_REPAIR;
    else process.env.PHILONT_SKILL_REPAIR = saved;
  }
});

test('AUTONOMOUS_DRIVERS: skill_repair is NOT registered by default (self-rewriting stays opt-in)', () => {
  assert.ok(
    !autonomousDriverNames.includes('skill_repair'),
    `default driver set must not include skill_repair, got: ${autonomousDriverNames.join(', ')}`,
  );
  // the three long-standing drivers are still there — the conditional spread didn't eat them
  for (const name of ['gap', 'curiosity', 'pursuit']) {
    assert.ok(autonomousDriverNames.includes(name), `missing baseline driver ${name}`);
  }
});

test('AUTONOMOUS_DRIVERS: PHILONT_SKILL_REPAIR=1 actually registers the driver (fresh process)', () => {
  // A fresh process is the only honest way to test this: chat-handler reads the env at module load.
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
      env: { ...process.env, PHILONT_SKILL_REPAIR: '1', PHILONT_AUTONOMOUS: '0' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.match(out, /REGISTERED/, `expected skill_repair to register under the flag; output: ${out}`);
});
