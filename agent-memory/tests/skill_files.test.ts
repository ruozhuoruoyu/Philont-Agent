/**
 * use_skill must tell the agent where the skill's files are.
 *
 * A marketplace SKILL.md is written relative to its own directory ("read FORMS.md", "run
 * scripts/fill_fillable_fields.py"). use_skill returned only the markdown body, so those instructions
 * pointed at nothing the agent could resolve — the loader knew the path all along (ParsedSkill.
 * sourcePath) but no consumer ever used it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSkillDir, listSkillFiles, skillFilesSection } from '../src/skill_files.js';

function withSkillOnDisk<T>(name: string, files: Record<string, string>, fn: (dir: string) => T): T {
  const prev = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'philont-skillfiles-'));
  const dir = join(root, '.philont', 'skills', name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  process.chdir(root);
  try {
    return fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
}

test('resolveSkillDir finds an installed skill and ignores a bogus name', () => {
  withSkillOnDisk('pdf', { 'SKILL.md': '---\nname: pdf\n---\nbody' }, (dir) => {
    assert.equal(resolveSkillDir('pdf'), dir);
    assert.equal(resolveSkillDir('missing'), null);
    // Never build a path out of model-supplied junk.
    assert.equal(resolveSkillDir('../../etc'), null);
    assert.equal(resolveSkillDir('a/b'), null);
  });
});

test('listSkillFiles lists companions recursively and excludes SKILL.md', () => {
  withSkillOnDisk(
    'pdf',
    {
      'SKILL.md': 'x',
      'forms.md': 'y',
      'scripts/fill.py': 'z',
      'scripts/util/helper.py': 'w',
    },
    (dir) => {
      assert.deepEqual(listSkillFiles(dir), ['forms.md', 'scripts/fill.py', 'scripts/util/helper.py']);
    },
  );
});

test('skillFilesSection names the absolute directory and every installed companion', () => {
  withSkillOnDisk('pdf', { 'SKILL.md': 'x', 'forms.md': 'y', 'scripts/fill.py': 'z' }, (dir) => {
    const section = skillFilesSection('pdf');
    assert.ok(section.includes('## Files'));
    assert.ok(section.includes(dir), 'the absolute install directory must be stated');
    assert.ok(section.includes('scripts/fill.py'));
    assert.ok(!section.includes('- SKILL.md'));
  });
});

test('skillFilesSection stays empty for a skill with no companion files', () => {
  withSkillOnDisk('selflearned', { 'SKILL.md': 'x' }, () => {
    assert.equal(skillFilesSection('selflearned'), '');
  });
  // and for a skill that only exists in the DB
  assert.equal(skillFilesSection('not-on-disk'), '');
});
