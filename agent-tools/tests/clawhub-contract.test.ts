/**
 * clawhub source: identifier parsing + a REAL contract check against the installed CLI.
 *
 * Why a contract test at all: the previous availability probe asserted `clawhub --version` exits 0.
 * clawhub 0.23.3 spells it `-V`, so the probe reported "not installed" for an installed CLI and the
 * whole source went dark — silently, with every unit test green, because no test ever touched the
 * external binary. The rule that follows: anything built on another project's CLI contract needs a
 * test that runs the actual binary. When the binary is absent the test SKIPS (never fake-passes), so
 * CI without clawhub stays honest instead of green-by-omission.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  parseClawhubIdentifier,
  sanitizeQuery,
  clawhubAvailable,
  resetClawhubProbe,
  clawhubSource,
  findSkillMd,
  listFiles,
  parseSearchTable,
} from '../src/skills/registry/sources/clawhub.js';

describe('parseClawhubIdentifier', () => {
  it('keeps a publisher-scoped slug intact (regression: split("@") ate the whole slug)', () => {
    assert.deepEqual(parseClawhubIdentifier('@kcns008/kubernetes'), { slug: '@kcns008/kubernetes' });
    assert.deepEqual(parseClawhubIdentifier('@openclaw/demo'), { slug: '@openclaw/demo' });
  });

  it('splits a trailing version', () => {
    assert.deepEqual(parseClawhubIdentifier('kubernetes@2.1.0'), { slug: 'kubernetes', version: '2.1.0' });
    assert.deepEqual(parseClawhubIdentifier('@openclaw/demo@1.2.3'), { slug: '@openclaw/demo', version: '1.2.3' });
  });

  it('strips the clawhub: prefix and surrounding whitespace', () => {
    assert.deepEqual(parseClawhubIdentifier('clawhub:kubernetes'), { slug: 'kubernetes' });
    assert.deepEqual(parseClawhubIdentifier('  clawhub:@o/p@1.0  '), { slug: '@o/p', version: '1.0' });
  });

  it('leaves path-shaped identifiers alone', () => {
    assert.deepEqual(parseClawhubIdentifier('skills-sh:owner/repo/slug'), { slug: 'skills-sh:owner/repo/slug' });
  });
});

describe('sanitizeQuery', () => {
  it('drops shell metacharacters and collapses whitespace', () => {
    assert.equal(sanitizeQuery('k8s && rm -rf /'), 'k8s rm -rf /');
    assert.equal(sanitizeQuery('a `b` $(c) | d'), 'a b c d');
    assert.equal(sanitizeQuery('  kubernetes   yaml  '), 'kubernetes yaml');
  });
});

describe('parseSearchTable', () => {
  const sample = [
    'kubernetes         @kcns008      Kubernetes Agent Swarm  6 installs / 60d',
    'k8s                @ivangdavila  Kubernetes              3 installs / 60d',
    'kubernetes-devops  @wpank        Kubernetes              1 installs / 60d',
  ].join('\n');

  it('reads slug, publisher and description out of the human-readable table', () => {
    const rows = parseSearchTable(sample);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { slug: 'kubernetes', publisher: '@kcns008', description: 'Kubernetes Agent Swarm' });
    assert.equal(rows[2].slug, 'kubernetes-devops');
  });

  it('drops the install-count column rather than treating it as description text', () => {
    assert.ok(!parseSearchTable(sample).some((r) => /installs/.test(r.description)));
  });

  it('returns nothing for empty output or banner-only text', () => {
    assert.deepEqual(parseSearchTable(''), []);
    assert.deepEqual(parseSearchTable('🦞 ClawHub CLI v0.23.3\n\nUsage: clawhub search [options]\n'), []);
  });

  it('skips rows that do not match the expected shape instead of guessing', () => {
    const rows = parseSearchTable('weird line without columns\nslug-ok  @pub  fine\n');
    assert.deepEqual(rows.map((r) => r.slug), ['slug-ok']);
  });
});

/** Resolve the clawhub binary the same way a user would; null = not installed here. */
function whichClawhub(): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, ['clawhub'], { timeout: 10_000 }, (err, stdout) => {
      const first = (stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(err || !first ? null : first);
    });
  });
}

describe('clawhub CLI contract (skipped when the CLI is not installed)', () => {
  it('availability does not depend on any version-flag spelling', async (t) => {
    const bin = await whichClawhub();
    if (!bin) return t.skip('clawhub not on PATH'); // skip, never a fake pass

    resetClawhubProbe();
    assert.equal(
      await clawhubAvailable(),
      true,
      'clawhub is on PATH but the probe says unavailable — the probe is coupled to a CLI flag again',
    );

    // The specific historical break: this flag does NOT exist on clawhub 0.23.3. Whatever it does,
    // it must not decide availability.
    const versionFlagExits = await new Promise<number>((resolve) => {
      execFile(bin, ['--version'], { timeout: 10_000 }, (err) => resolve(err ? 1 : 0));
    });
    assert.equal(
      await clawhubAvailable(),
      true,
      `availability flipped with --version exit=${versionFlagExits}; it must be flag-independent`,
    );
  });

  it('rejects an empty slug instead of shelling out with one', async (t) => {
    const bin = await whichClawhub();
    if (!bin) return t.skip('clawhub not on PATH');
    resetClawhubProbe();
    await assert.rejects(() => clawhubSource.fetch('clawhub:'), /empty slug/);
  });

  it('keyword search returns what the CLI itself found', async (t) => {
    const bin = await whichClawhub();
    if (!bin) return t.skip('clawhub not on PATH');

    // Ask the CLI directly first. If IT finds nothing (offline, registry down), there is nothing to
    // assert about our parsing — skip. If it DOES find results and our source returns none, that is
    // the exact failure that went unnoticed for months.
    const raw = await new Promise<string>((resolve) => {
      execFile(bin, ['search', 'kubernetes', '--limit', '3'], { timeout: 30_000 }, (_e, stdout) => resolve(stdout || ''));
    });
    if (!parseSearchTable(raw).length) return t.skip('clawhub returned no results (offline?)');

    resetClawhubProbe();
    const results = await clawhubSource.search('kubernetes', 3);
    assert.ok(results.length > 0, 'the CLI found skills but the source returned none');
    assert.ok(results.every((r) => r.sourceId === 'clawhub' && r.slug));
    // The identifier we hand back must be installable as-is.
    assert.ok(results.some((r) => r.slug.includes('/')), `expected @publisher/slug identifiers, got ${results.map((r) => r.slug).join(', ')}`);
  });

  it('refuses to pass shell metacharacters through to the CLI', async (t) => {
    const bin = await whichClawhub();
    if (!bin) return t.skip('clawhub not on PATH');
    resetClawhubProbe();
    // The allowlist must reject this before any shell sees it (Windows spawns the .cmd shim through one).
    await assert.rejects(() => clawhubSource.fetch('foo" & echo pwned'), /unsafe argument/);
  });
});

describe('bundle handling', () => {
  /** A fixture laid out like a real clawhub package: root SKILL.md + nested sub-skills + companions. */
  async function bundleFixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'philont-bundle-test-'));
    await mkdir(join(dir, 'skills', 'observability'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: root\n---\nbody\n');
    await writeFile(join(dir, 'skills', 'observability', 'SKILL.md'), '---\nname: obs\n---\nnested\n');
    await writeFile(join(dir, 'README.md'), '# readme');
    await writeFile(join(dir, 'scripts', 'run.py'), 'print(1)');
    return dir;
  }

  it('findSkillMd picks the shallowest SKILL.md, not whatever readdir yielded first', async () => {
    const dir = await bundleFixture();
    try {
      const found = await findSkillMd(dir);
      assert.equal(found, join(dir, 'SKILL.md'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('listFiles enumerates every companion file (the basis of the PARTIAL warning)', async () => {
    const dir = await bundleFixture();
    try {
      const files = (await listFiles(dir)).sort();
      assert.deepEqual(files, [
        'README.md',
        'SKILL.md',
        'scripts/run.py',
        'skills/observability/SKILL.md',
      ]);
      // What fetch() would report as not-installed: everything except the chosen entry.
      assert.deepEqual(files.filter((f) => f !== 'SKILL.md').length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
