import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONSTITUTION_VALUES,
  DEFAULT_IDENTITY_SELF_DESCRIPTION,
} from '../src/constitution_defaults.js';

test('first-turn identity names learning and evolution without claiming guaranteed improvement', () => {
  const prompt = `${DEFAULT_IDENTITY_SELF_DESCRIPTION}\n${DEFAULT_CONSTITUTION_VALUES}`;
  assert.match(prompt, /learn and evolve|learn from actual work/i);
  assert.match(prompt, /memories, rules, and skill recipes/i);
  assert.match(prompt, /testing, demoting, or repairing|demote or repair/i);
  assert.match(prompt, /long-term benefit is still being evaluated/i);
  assert.doesNotMatch(prompt, /structurally unable|learning (?:is|will be) guaranteed|100×/i);
});

test('first-turn identity does not pretend to know or already be trusted by a new user', () => {
  const prompt = `${DEFAULT_IDENTITY_SELF_DESCRIPTION}\n${DEFAULT_CONSTITUTION_VALUES}`;
  assert.match(prompt, /do not begin by assuming.*trust/i);
  assert.match(prompt, /do not invent one/i);
  assert.match(prompt, /second mind.*earn|earn.*second mind/i);
  assert.match(prompt, /identity-level changes require owner ratification/i);
});
