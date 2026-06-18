/**
 * Skill marketplace registry: lockStore round-trip + shared helpers + router dedupe/sort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, normalizeName } from '../src/skills/registry/shared.js';
import { readLock, upsertLock, getProvenance, removeLock, appendAudit } from '../src/skills/registry/lockStore.js';
import type { ProvenanceRecord } from '../src/skills/registry/types.js';

function withTmpCwd(fn: () => void) {
  const prev = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'philont-reg-'));
  try {
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shared: sha256 is stable hex', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('shared: normalizeName produces a valid skill name', () => {
  assert.equal(normalizeName('My Cool Skill.md'), 'my-cool-skill');
  assert.equal(normalizeName('owner/repo'), 'owner-repo');
  assert.equal(normalizeName('---weird___'), 'weird');
  assert.equal(normalizeName(''), 'skill');
  assert.match(normalizeName('a'.repeat(100)), /^[a-z0-9_-]{1,64}$/);
});

test('lockStore: upsert / read / getProvenance / remove', () => {
  withTmpCwd(() => {
    assert.deepEqual(readLock(), {});
    const rec: ProvenanceRecord = {
      name: 'demo', sourceId: 'git', identifier: 'o/r', sourceTag: 'github:o/r@abc1234',
      trust: 'community', contentHash: 'deadbeef', verdict: 'safe', decision: 'allow',
      confirmedBy: null, installedAt: '2026-06-18T00:00:00Z', paths: ['/x/.philont/skills/demo/SKILL.md'],
    };
    upsertLock(rec);
    assert.deepEqual(getProvenance('demo'), rec);
    assert.ok(existsSync(join(process.cwd(), '.philont', 'skills.lock.json')));

    removeLock('demo');
    assert.equal(getProvenance('demo'), null);
    assert.deepEqual(readLock(), {});
  });
});

test('lockStore: appendAudit writes JSONL', () => {
  withTmpCwd(() => {
    appendAudit({ ts: '2026-06-18T00:00:00Z', action: 'install', name: 'demo', sourceTag: 'github:o/r@abc', verdict: 'safe', decision: 'allow', actor: 'user' });
    const log = readFileSync(join(process.cwd(), '.philont', 'skills-audit.log'), 'utf-8');
    const parsed = JSON.parse(log.trim());
    assert.equal(parsed.action, 'install');
    assert.equal(parsed.name, 'demo');
  });
});

test('lockStore: malformed lock file degrades to empty map', () => {
  withTmpCwd(() => {
    // write garbage then read
    upsertLock({
      name: 'x', sourceId: 'git', identifier: 'a/b', sourceTag: 'github:a/b@1', trust: 'community',
      contentHash: 'h', verdict: 'safe', decision: 'allow', confirmedBy: null, installedAt: 't', paths: [],
    });
    // overwrite with junk
    const lock = join(process.cwd(), '.philont', 'skills.lock.json');
    writeFileSync(lock, '{not json', 'utf-8');
    assert.deepEqual(readLock(), {});
  });
});
