/**
 * Who is allowed to overwrite an installed skill — driven through installFromSource, not around it.
 *
 * Two defects motivate every case here:
 *
 *   1. The decision used to read the lock file alone. `readLock()` returns {} for a missing OR
 *      malformed file by design, so one corrupt lock declared every installed skill foreign and turned
 *      each later update into "already exists but is not marketplace-managed" — wrong and unactionable.
 *   2. The first fix trusted the `source:` frontmatter instead. That is descriptive metadata: the
 *      agent-facing installSkill tool writes an arbitrary source string, so a self-learned skill can
 *      wear marketplace clothes, and ordinary metadata must never authorise destroying local work.
 *
 * So the tests exercise the real pipeline. An earlier version of this file asserted the two ingredient
 * functions and then hand-fed `replaceExisting: true` to the low-level writer — it passed while the
 * decision it claimed to cover was never executed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFromSource } from '../src/skills/registry/install.js';
import { readLock } from '../src/skills/registry/lockStore.js';
import { SOURCES } from '../src/skills/registry/router.js';
import type { SkillSource } from '../src/skills/registry/types.js';

/** A source that serves a fixed skill body, so no test touches the network. */
function stubSource(sourceId: string, sourceTag: string, body: string): SkillSource {
  return {
    sourceId,
    trustLevel: () => 'community',
    async search() { return []; },
    async inspect() { return null; },
    async fetch() {
      return {
        meta: { slug: 'demo', name: 'demo', description: 'demo', sourceId, sourceTag, trust: 'community' as const },
        content: body,
        contentHash: `hash-${body.length}`,
      };
    },
  };
}

async function withStub<T>(source: SkillSource, fn: (dir: string) => Promise<T>): Promise<T> {
  SOURCES.push(source);
  const prev = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'philont-prov-'));
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
    SOURCES.splice(SOURCES.indexOf(source), 1);
  }
}

const SKILL = (v: string) => `---\nname: demo\ndescription: demo skill\n---\n\nbody ${v}\n`;
const skillFile = () => join(process.cwd(), '.philont', 'skills', 'demo', 'SKILL.md');
const req = { sourceId: 'stub-git', identifier: 'owner/repo', actor: 'user' as const, now: '2026-08-20T00:00:00Z' };

test('the installer stamps its own marker, which is what later authorises replacing the directory', async () => {
  await withStub(stubSource('stub-git', 'github:owner/repo@v1', SKILL('v1')), async () => {
    const first = await installFromSource(req);
    assert.equal(first.status, 'installed');
    const onDisk = readFileSync(skillFile(), 'utf-8');
    assert.match(onDisk, /^installed_by: philont-marketplace$/m, 'the marker is written by this path');
    assert.match(onDisk, /^source: github:owner\/repo@v1$/m);
  });
});

test('a corrupt lock file no longer makes an installed skill unupdatable, and the install repairs it', async () => {
  await withStub(stubSource('stub-git', 'github:owner/repo@v1', SKILL('v1')), async () => {
    assert.equal((await installFromSource(req)).status, 'installed');

    // The exact production failure: the lock is unreadable, so readLock() reports nothing at all.
    writeFileSync(join(process.cwd(), '.philont', 'skills.lock.json'), '{not json', 'utf-8');
    assert.deepEqual(readLock(), {}, 'precondition: the lock really is unusable');

    const again = await installFromSource(req);
    assert.equal(again.status, 'installed', again.error);
    assert.ok(readLock().demo, 'the install rewrites the lock it stood in for');
  });
});

test('a self-learned skill wearing a marketplace source tag is NOT overwritten', async () => {
  await withStub(stubSource('stub-git', 'github:owner/repo@v1', SKILL('fromRegistry')), async () => {
    // installSkill takes an arbitrary `source` string, so this file is exactly what the agent can write.
    mkdirSync(join(process.cwd(), '.philont', 'skills', 'demo'), { recursive: true });
    writeFileSync(skillFile(), '---\nname: demo\nsource: github:owner/repo@v1\n---\n\nhand written\n', 'utf-8');

    const outcome = await installFromSource(req);
    assert.equal(outcome.status, 'error');
    assert.match(String(outcome.error), /was not written by the marketplace installer/);
    assert.match(readFileSync(skillFile(), 'utf-8'), /hand written/, 'local work survives');
  });
});

test('a marketplace skill from a DIFFERENT origin is not silently replaced either', async () => {
  await withStub(stubSource('stub-git', 'github:owner/repo@v1', SKILL('v1')), async () => {
    assert.equal((await installFromSource(req)).status, 'installed');
    rmSync(join(process.cwd(), '.philont', 'skills.lock.json'));

    // Same name, our own marker on disk, but the install now comes from somewhere else.
    const other = stubSource('stub-other', 'github:someone-else/repo@v9', SKILL('other'));
    SOURCES.push(other);
    try {
      const outcome = await installFromSource({ ...req, sourceId: 'stub-other', identifier: 'someone-else/repo' });
      assert.equal(outcome.status, 'error');
      assert.match(readFileSync(skillFile(), 'utf-8'), /body v1/, 'the original stays');
    } finally {
      SOURCES.splice(SOURCES.indexOf(other), 1);
    }
  });
});

test('a newer version of the same origin still self-heals past a lost lock', async () => {
  await withStub(stubSource('stub-git', 'github:owner/repo@v1', SKILL('v1')), async () => {
    assert.equal((await installFromSource(req)).status, 'installed');
    rmSync(join(process.cwd(), '.philont', 'skills.lock.json'));

    // Same origin, new pin — this is an update, and the pinned sha must not make it look foreign.
    const v2 = stubSource('stub-git2', 'github:owner/repo@v2', SKILL('v2'));
    SOURCES.push(v2);
    try {
      const outcome = await installFromSource({ ...req, sourceId: 'stub-git2' });
      assert.equal(outcome.status, 'installed', outcome.error);
      assert.match(readFileSync(skillFile(), 'utf-8'), /body v2/);
      assert.ok(existsSync(join(process.cwd(), '.philont', 'skills.lock.json')));
    } finally {
      SOURCES.splice(SOURCES.indexOf(v2), 1);
    }
  });
});
