import assert from 'node:assert/strict';
import test from 'node:test';

import { DEEP_EXPLORE_VERIFY_TOOL_NAMES } from '../src/chat-handler.js';

test('deep_explore can produce every native proof evidence accepted by honesty gate', () => {
  assert.ok(DEEP_EXPLORE_VERIFY_TOOL_NAMES.has('leanCheck'));
  assert.ok(DEEP_EXPLORE_VERIFY_TOOL_NAMES.has('z3Verify'));
});
