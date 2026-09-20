/**
 * safeJsonParse: arguments that are not a JSON object come back as `{ _raw: <text> }`, never `{}` —
 * the chat loop echoes that text to the model instead of running the tool with empty input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJsonParse } from '../src/llm-adapter.js';
import { rawArgumentsLeak } from '../src/format_recovery.js';

test('valid object arguments parse as before', () => {
  assert.deepEqual(safeJsonParse('{"path":"a.txt"}'), { path: 'a.txt' });
  assert.deepEqual(safeJsonParse(''), {});
});

test('malformed JSON keeps the raw text under _raw and the loop can see it', () => {
  const broken = '{"path": "a.txt", "content": "x",}';
  const input = safeJsonParse(broken);
  assert.deepEqual(input, { _raw: broken });
  assert.equal(rawArgumentsLeak(input), broken);
});

test('JSON that parses but is not an object (array / scalar) is a leak too', () => {
  assert.deepEqual(safeJsonParse('[1,2]'), { _raw: '[1,2]' });
  assert.deepEqual(safeJsonParse('"just a string"'), { _raw: '"just a string"' });
});
