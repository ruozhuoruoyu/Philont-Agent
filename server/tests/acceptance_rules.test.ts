/** acceptance_rules (2026-10-08): distillation prompt, rule-line parsing, prompt section rendering. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distilPrompt, parseRules, renderConventions, MAX_RULES_PER_FAILURE } from '../src/acceptance_rules.js';

test('parseRules: bullet/numbered lines, dedupe, NONE and headers dropped, bounded count and length', () => {
  const text = 'Rules:\n- When asked to record status, write it to status.txt in the target directory.\n* when asked to record status, write it to status.txt in the target directory.\n1) Created directories must be owned by the named group with mode 2775.\n- Third rule that should be cut by the cap because only two are kept.\n';
  const rules = parseRules(text);
  assert.equal(rules.length, MAX_RULES_PER_FAILURE);
  assert.match(rules[0], /^When asked to record status/);
  assert.match(rules[1], /^Created directories/);
  assert.deepEqual(parseRules('NONE'), []);
  assert.deepEqual(parseRules('- none.'), []);
  assert.deepEqual(parseRules(''), []);
  assert.deepEqual(parseRules(null), []);
  assert.deepEqual(parseRules('- short'), [], 'too short to be a rule');
  assert.deepEqual(parseRules('- ' + 'x'.repeat(400)), [], 'too long');
});

test('distilPrompt: carries task and failing clauses, asks for at most N environment-general rules', () => {
  const p = distilPrompt('Count ERROR lines and write an inventory file.', ["test -f /opt/tool/logs/inventory.txt", "grep -q '^3$' <(grep -o '[0-9]\\+' /opt/tool/logs/inventory.txt)"], '');
  assert.match(p, /Count ERROR lines/);
  assert.match(p, /inventory\.txt/);
  assert.match(p, new RegExp(`at most ${MAX_RULES_PER_FAILURE} rules`));
  const q = distilPrompt('t', [], 'exit 1\nmissing file');
  assert.match(q, /Acceptance check output/);
  assert.match(q, /missing file/);
});

test('renderConventions: empty for no rules; shows rule text with +helpful/−harmful', () => {
  assert.equal(renderConventions([]), '');
  const out = renderConventions([{ id: '1', envKey: 'e', rule: 'Name the inventory file inventory.txt.', source: null, trigger: 'inventory', helpful: 3, harmful: 1, seen: 2, createdAt: 0, updatedAt: 0, score: 0.5 }]);
  assert.match(out, /## Acceptance conventions learned in this environment/);
  assert.match(out, /- Name the inventory file inventory\.txt\. \(\+3\/−1\)/);
});
