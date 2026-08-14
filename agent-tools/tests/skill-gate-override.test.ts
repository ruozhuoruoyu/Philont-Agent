/**
 * Install gate: the `block` arm and its single, user-only door.
 *
 * The gate had no way past `block`, which mattered more than it looked: the scanner is a regex
 * heuristic over documents that legitimately contain shell and python snippets, and scanning whole
 * bundles (rather than just the entry SKILL.md) pushes real packages into `dangerous` — a real clawhub
 * skill trips 'send credential env var over network' inside one of its sub-skill docs. Without a door,
 * the user's only remaining move is to copy the files in by hand, which loses the provenance, the lock
 * entry and the audit line. The door therefore exists, and these tests pin its shape:
 *   - the agent can never open it (actor 'agent' is refused and the refusal is audited);
 *   - a user override is recorded as such, both in the lock file and the audit log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateDecision } from '../src/skills/registry/gate.js';
import { installFromSource } from '../src/skills/registry/install.js';
import { readLock } from '../src/skills/registry/lockStore.js';
import { SOURCES } from '../src/skills/registry/router.js';
import type { SkillSource } from '../src/skills/registry/types.js';

/** A SKILL.md whose body trips an `rce` rule → dangerous → community+dangerous = block. */
const DANGEROUS_SKILL = [
  '---',
  'name: risky-ops',
  'description: restart services',
  '---',
  '',
  '# Risky ops',
  '',
  'Run `subprocess.run(["systemctl", "restart", "api"])` to restart the service.',
  '',
].join('\n');

/** A stub source registered into the router for the duration of a test. */
const stubSource: SkillSource = {
  sourceId: 'test-stub',
  trustLevel: () => 'community',
  async search() { return []; },
  async inspect() { return null; },
  async fetch() {
    return {
      meta: {
        slug: 'risky-ops',
        name: 'risky-ops',
        description: 'restart services',
        sourceId: 'test-stub',
        sourceTag: 'test:risky-ops',
        trust: 'community' as const,
      },
      content: DANGEROUS_SKILL,
      contentHash: 'stub-hash',
    };
  },
};

async function withStubSource<T>(fn: () => Promise<T>): Promise<T> {
  SOURCES.push(stubSource);
  const prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'philont-gate-'));
  try {
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    SOURCES.splice(SOURCES.indexOf(stubSource), 1);
  }
}

function auditLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, '.philont', 'skills-audit.log');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('gate: community + dangerous still blocks by default', () => {
  assert.equal(gateDecision('community', 'dangerous'), 'block');
  assert.equal(gateDecision('community', 'caution'), 'ask');
  assert.equal(gateDecision('community', 'safe'), 'allow');
});

test('install: a blocked skill is refused without an override', async () => {
  await withStubSource(async () => {
    const outcome = await installFromSource({
      sourceId: 'test-stub',
      identifier: 'risky-ops',
      actor: 'user',
      now: '2026-08-14T00:00:00Z',
    });
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.verdict, 'dangerous');
    assert.deepEqual(readLock(), {}, 'a blocked install must not leave a lock entry');
  });
});

test('install: the agent cannot override the gate, and the attempt is audited', async () => {
  await withStubSource(async () => {
    const outcome = await installFromSource({
      sourceId: 'test-stub',
      identifier: 'risky-ops',
      override: true,
      actor: 'agent', // the model asking for its own exemption
      now: '2026-08-14T00:00:00Z',
    });
    assert.equal(outcome.status, 'blocked', 'agent-requested override must not install');
    assert.deepEqual(readLock(), {});
    const actions = auditLines(process.cwd()).map((a) => a.action);
    assert.ok(actions.includes('override_refused'), `expected override_refused, got ${actions.join(',')}`);
  });
});

test('install: a user override installs and is marked as such', async () => {
  await withStubSource(async () => {
    const outcome = await installFromSource({
      sourceId: 'test-stub',
      identifier: 'risky-ops',
      override: true,
      actor: 'user',
      now: '2026-08-14T00:00:00Z',
    });
    assert.equal(outcome.status, 'installed');
    assert.equal(outcome.overridden, true);
    assert.equal(outcome.verdict, 'dangerous');

    const rec = readLock()['risky-ops'];
    assert.ok(rec, 'provenance recorded');
    assert.equal(rec.overridden, true);
    assert.equal(rec.confirmedBy, 'user');
    assert.equal(rec.decision, 'block', 'the verdict is preserved, not laundered into allow');

    const actions = auditLines(process.cwd()).map((a) => a.action);
    assert.ok(actions.includes('override_install'), `expected override_install, got ${actions.join(',')}`);
  });
});
