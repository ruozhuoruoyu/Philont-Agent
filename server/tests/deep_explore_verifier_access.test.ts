import assert from 'node:assert/strict';
import test from 'node:test';
import { FORMAL_VERIFIER_TOOLS } from '@agent/memory';

import { DEEP_EXPLORE_VERIFY_TOOL_NAMES } from '../src/chat-handler.js';

test('deep_explore can produce every native proof evidence accepted by honesty gate', () => {
  for (const toolName of FORMAL_VERIFIER_TOOLS) {
    assert.ok(DEEP_EXPLORE_VERIFY_TOOL_NAMES.has(toolName), toolName);
  }
});
