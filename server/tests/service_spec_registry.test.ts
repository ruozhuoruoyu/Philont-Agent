/**
 * Service-spec registry tests — host lookup, text matching, graceful absence.
 * The registry is what lets mechanism guards and scheduled-turn injection consult the compiled
 * contract on ANY turn, not just inside the plan loop.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSpecForHost,
  findServiceSkillForText,
  clearSpecRegistryCache,
} from '../src/service_spec_registry.js';

const SPEC = {
  source: { contentHash: 'h' },
  service: { name: 'notably', hosts: ['notably.app'] },
  endpoints: [{ method: 'PUT', path: '/v2/agents/:id/memories/:key', requiredFields: ['contextActorId', 'value'] }],
  preconditions: [], rules: [], confidence: 1,
};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'specreg-'));
  const dir = join(root, 'notably-service');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC), 'utf8');
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: notably-service\n---\n# notably service\n- PUT …', 'utf8');
  // A non-service skill dir must be skipped silently.
  mkdirSync(join(root, 'ocr-local'), { recursive: true });
  writeFileSync(join(root, 'ocr-local', 'SKILL.md'), '---\nname: ocr-local\n---\nocr', 'utf8');
  return root;
}

beforeEach(() => clearSpecRegistryCache());

test('findSpecForHost: resolves installed spec by host; unknown host/root → null', () => {
  const root = makeRoot();
  try {
    const spec = findSpecForHost('NOTABLY.app', root);
    assert.ok(spec);
    assert.equal(spec!.endpoints[0].requiredFields?.[0], 'contextActorId');
    assert.equal(findSpecForHost('other.io', root), null);
    assert.equal(findSpecForHost('notably.app', join(root, 'no-such-dir')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findServiceSkillForText: slug or host in schedule text → SKILL.md returned', () => {
  const root = makeRoot();
  try {
    const bySlug = findServiceSkillForText('Execute Notably check-in routine for agent-x', root);
    assert.ok(bySlug);
    assert.equal(bySlug!.skillName, 'notably-service');
    assert.match(bySlug!.markdown, /# notably service/);
    assert.ok(findServiceSkillForText('payload mentions notably.app explicitly', root));
    assert.equal(findServiceSkillForText('daily goldbach reflection', root), null);
    assert.equal(findServiceSkillForText('   ', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
