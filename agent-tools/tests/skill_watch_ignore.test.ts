/**
 * What a skill directory watcher must ignore.
 *
 * Production 2026-07-22: installing one skill's dependencies produced a single batch of 46 fs events and
 * reloaded every skill in the directory. A skill is defined by its SKILL.md and its scripts — never by the
 * internals of its dependencies — so none of those events could have changed anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredSkillPath } from '../src/index.js';

test('dependency trees are ignored at any depth, on either separator', () => {
  // The exact paths from the production batch.
  assert.ok(isIgnoredSkillPath('ocr-local\\node_modules'));
  assert.ok(isIgnoredSkillPath('ocr-local\\node_modules\\bmp-js\\lib'));
  assert.ok(isIgnoredSkillPath('ocr-local/node_modules/idb-keyval'));
  assert.ok(isIgnoredSkillPath('ocr-local\\.clawhub'.replace('.clawhub', '.git')));
});

test('caches, build output and editor droppings are ignored', () => {
  for (const p of ['s/__pycache__/x.pyc', 's/.venv/bin', 's/dist/main.js', 's/.vscode/settings.json', 's/SKILL.md~', 's/.SKILL.md.swp']) {
    assert.ok(isIgnoredSkillPath(p), p);
  }
});

test('what actually defines a skill is NOT ignored', () => {
  for (const p of ['ocr-local\\SKILL.md', 'ocr-local/scripts/run.py', 'mycox-service/spec.json', 'paper-research-quick']) {
    assert.equal(isIgnoredSkillPath(p), false, p);
  }
});

test('a directory merely NAMED like a dependency dir is still matched (segment-exact, not substring)', () => {
  assert.equal(isIgnoredSkillPath('my-node_modules-helper/SKILL.md'), false, 'substring must not match');
  assert.ok(isIgnoredSkillPath('a/node_modules/b'));
});
