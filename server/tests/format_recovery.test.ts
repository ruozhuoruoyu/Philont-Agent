/**
 * format_recovery unit tests: the echo-and-escalate ladder for calls rejected before execution,
 * and closest-name suggestions for unknown tools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormatFixReminder,
  buildInputRejection,
  buildUnknownToolFeedback,
  isFormatFailureSignature,
  isFormatFailureText,
  priorFormatFailures,
  rawArgumentsLeak,
  schemaShapeHint,
  suggestToolNames,
} from '../src/format_recovery.js';
import type { InTurnToolRecord } from '../src/in_turn_reflection.js';

const writeFileSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    content: { type: 'string' },
    mode: { type: 'string', enum: ['overwrite', 'append'] },
  },
  required: ['path', 'content'],
};

test('rawArgumentsLeak: only the exact {_raw: string} shape is a leak', () => {
  assert.equal(rawArgumentsLeak({ _raw: '{"path": ' }), '{"path": ');
  assert.equal(rawArgumentsLeak({ _raw: 1 }), null);
  assert.equal(rawArgumentsLeak({ _raw: 'x', path: 'y' }), null);
  assert.equal(rawArgumentsLeak({}), null);
  assert.equal(rawArgumentsLeak(null), null);
});

test('rung 0: the rejection echoes what the model sent', () => {
  const text = buildInputRejection({
    toolName: 'writeFile',
    detail: 'missing required field(s): path',
    received: { content: 'hello' },
    schema: writeFileSchema,
    priorFailures: 0,
  });
  assert.match(text, /^tool input format error, blocked before authorization: missing required field\(s\): path/);
  assert.match(text, /You sent: \{"content":"hello"\}/);
  assert.doesNotMatch(text, /Expected input shape/, 'rung 0 does not spell the schema yet');
  assert.doesNotMatch(text, /STRICT FORMAT/);
  assert.equal(isFormatFailureText(text), true);
});

test('rung 0 for unparseable JSON says so and quotes the raw text', () => {
  const text = buildInputRejection({
    toolName: 'writeFile',
    detail: 'missing required field(s): path, content',
    received: '{"path": "a.txt", "content": "x",}',
    schema: writeFileSchema,
    priorFailures: 0,
  });
  assert.match(text, /arguments were not valid JSON/);
  assert.match(text, /You sent: \{"path": "a\.txt", "content": "x",\}/);
  assert.match(text, /did not parse as a JSON object/);
});

test('rung 1 adds the expected shape, required keys first, optional keys marked', () => {
  const text = buildInputRejection({
    toolName: 'writeFile',
    detail: 'missing required field(s): path',
    received: { content: 'hello' },
    schema: writeFileSchema,
    priorFailures: 1,
  });
  assert.match(text, /Expected input shape for writeFile: \{"path": <string>, "content": <string>, "mode"\?: <"overwrite" \| "append">\}/);
  assert.doesNotMatch(text, /STRICT FORMAT/);
});

test('rung 2 switches to the strict template and names the way out', () => {
  const text = buildInputRejection({
    toolName: 'writeFile',
    detail: 'missing required field(s): path',
    received: { content: 'hello' },
    schema: writeFileSchema,
    priorFailures: 2,
  });
  assert.match(text, /STRICT FORMAT — this is format error #3 on writeFile this turn/);
  assert.match(text, /exactly ONE tool call to writeFile/);
  assert.match(text, /stop calling this tool and tell the user/);
});

test('long inputs are echoed truncated, never dropped', () => {
  const text = buildInputRejection({
    toolName: 'shell',
    detail: 'missing required field(s): command',
    received: { cmd: 'x'.repeat(2000) },
    priorFailures: 0,
  });
  assert.match(text, /You sent: \{"cmd":"x{100}/);
  assert.match(text, /… \(\d+ more chars\)/);
  assert.ok(text.length < 700);
});

test('schemaShapeHint: no properties → no hint; caps at 8 keys', () => {
  assert.equal(schemaShapeHint(undefined), null);
  assert.equal(schemaShapeHint({ type: 'object' }), null);
  const wide = { properties: Object.fromEntries([...'abcdefghijkl'].map((k) => [k, { type: 'number' }])), required: ['l'] };
  const hint = schemaShapeHint(wide)!;
  assert.match(hint, /^\{"l": <number>, "a"\?: <number>/);
  assert.equal((hint.match(/<number>/g) ?? []).length, 8);
});

test('priorFormatFailures counts only this tool and only format-class failures', () => {
  const records: InTurnToolRecord[] = [
    { toolName: 'writeFile', success: false, resultText: 'tool input format error, blocked before authorization: missing required field(s): path' },
    { toolName: 'writeFile', success: false, resultText: '⚠ TOOL FAILED — EACCES' },
    { toolName: 'readFile', success: false, resultText: 'tool input format error, blocked before authorization: x' },
    { toolName: 'writeFile', success: true, resultText: '✓ TOOL OK' },
    { toolName: 'read_file', success: false, resultText: "Error: Unknown tool 'read_file'." },
  ];
  assert.equal(priorFormatFailures(records, 'writeFile'), 1);
  assert.equal(priorFormatFailures(records, 'readFile'), 1);
  assert.equal(priorFormatFailures(records, 'read_file'), 1);
  assert.equal(priorFormatFailures(records, 'shell'), 0);
});

const KNOWN = ['readFile', 'writeFile', 'listDir', 'grep', 'glob', 'webFetch', 'webSearch', 'shell', 'pariGp', 'search_skills', 'get_fact'];

test('suggestToolNames: the snake/camel/case split resolves to the exact tool', () => {
  assert.deepEqual(suggestToolNames('read_file', KNOWN), ['readFile']);
  assert.deepEqual(suggestToolNames('ReadFile', KNOWN), ['readFile']);
  assert.deepEqual(suggestToolNames('web-fetch', KNOWN), ['webFetch']);
  assert.deepEqual(suggestToolNames('searchSkills', KNOWN), ['search_skills']);
});

test('suggestToolNames: near misses rank by similarity, unrelated names give nothing', () => {
  const s = suggestToolNames('readFiles', KNOWN);
  assert.equal(s[0], 'readFile');
  assert.deepEqual(suggestToolNames('sendEmail', KNOWN), []);
  assert.deepEqual(suggestToolNames('', KNOWN), []);
  assert.ok(suggestToolNames('file', KNOWN).length <= 3);
});

test('unknown-tool feedback keeps the classifiable prefix, suggests, and escalates on rung 2', () => {
  const r0 = buildUnknownToolFeedback('read_file', KNOWN, 0);
  assert.match(r0, /^Error: Unknown tool 'read_file'\./);
  assert.match(r0, /Did you mean: readFile\?/);
  assert.doesNotMatch(r0, /STRICT/);
  assert.equal(isFormatFailureText(r0), true);
  const r2 = buildUnknownToolFeedback('read_file', KNOWN, 2);
  assert.match(r2, /STRICT — this is unknown-tool error #3 this turn/);
  assert.match(r2, /Call `readFile` with its documented input/);
  const none = buildUnknownToolFeedback('sendEmail', KNOWN, 0);
  assert.match(none, /No tool with a similar name exists/);
});

test('isFormatFailureSignature recognises both classes and nothing else', () => {
  assert.equal(isFormatFailureSignature('writeFile:input-format'), true);
  assert.equal(isFormatFailureSignature('read_file:unknown-tool'), true);
  assert.equal(isFormatFailureSignature('writeFile:enoent'), false);
  assert.equal(isFormatFailureSignature('shell:other:tool input format error, block'), false);
  assert.equal(isFormatFailureSignature(undefined), false);
});

test('the format reminder stands the strategic gates down and names the fix', () => {
  const fmt = buildFormatFixReminder('writeFile:input-format', 2, {
    toolName: 'writeFile',
    shapeHint: schemaShapeHint(writeFileSchema),
  });
  assert.match(fmt, /\[drive format-recovery\] 2 calls to `writeFile`/);
  assert.match(fmt, /Do NOT research, do NOT make a plan, do NOT switch tools/);
  assert.match(fmt, /Send exactly this shape: \{"path": <string>/);
  const unk = buildFormatFixReminder('read_file:unknown-tool', 2, { toolName: 'read_file', suggestions: ['readFile'] });
  assert.match(unk, /The tool name is wrong, not the plan/);
  assert.match(unk, /Use the exact name `readFile`/);
});
