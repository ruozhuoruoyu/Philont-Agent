import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTION_TEMPLATE_WARN_SIZE } from '../src/skills/loader.js';

const SKILL = fileURLToPath(new URL('../bundled-skills/service-onboarding/SKILL.md', import.meta.url));
const src = readFileSync(SKILL, 'utf8');

test('service-onboarding carries no concrete-service shape (endpoint completeness moved to the spec mechanism)', () => {
  // The skill used to teach one service's document structure — "Part 1 / Part 4 / Part 5", counts tuned to
  // that service ("≥ 5 endpoints / ≥ 3 categories"), and its name outright. That is what the compiled spec
  // now owns deterministically; leaving it here re-teaches a small model one service's shape. Test the
  // shape, not just the word (the same blind spot that let the compile prompt ship a real service's spec).
  assert.doesNotMatch(src, /mycox/i, 'no concrete service name');
  assert.doesNotMatch(src, /\bPart\s+\d/i, 'no "Part N" document-structure assumption');
  assert.doesNotMatch(src, /(?:fewer than|≥|>=|at least)\s*\d+\s*(?:endpoints|categories)/i, 'no service-tuned count thresholds');
});

test('service-onboarding stays under the action-template warn size', () => {
  assert.ok(
    Buffer.byteLength(src, 'utf8') < ACTION_TEMPLATE_WARN_SIZE,
    `SKILL.md is ${Buffer.byteLength(src, 'utf8')}B, over the ${ACTION_TEMPLATE_WARN_SIZE}B action-template warn threshold`,
  );
});

test('service-onboarding still owns what the spec does NOT — scheduling + credentials', () => {
  // The de-customization must not have gutted the half the spec mechanism does not cover.
  assert.match(src, /autonomous_turn/, 'heartbeat scheduling guidance must remain');
  assert.match(src, /saveCredential/, 'credential-storage guidance must remain');
  assert.match(src, /heartbeat_priority/, 'behavioral priority capture must remain');
});
