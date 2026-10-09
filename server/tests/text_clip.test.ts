import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipAtBoundary } from '../src/text_clip.js';

test('clipAtBoundary: text within the cap is returned untouched', () => {
  assert.equal(clipAtBoundary('short', 10), 'short');
  assert.equal(clipAtBoundary('', 10), '');
});

test('clipAtBoundary: cuts at the last sentence end inside the room and appends the marker', () => {
  const text = '第一句话。第二句话比较长一些。第三句话会被切掉的那一部分。';
  const out = clipAtBoundary(text, 20, '…');
  assert.equal(out, '第一句话。第二句话比较长一些。…');
  assert.ok(out.length <= 20);
});

test('clipAtBoundary: prefers a line break, then a sentence, then whitespace, then a plain cut', () => {
  assert.equal(clipAtBoundary('line one is here\nline two is longer than that', 24, '…'), 'line one is here…');
  assert.equal(clipAtBoundary('alpha beta gamma delta epsilon zeta eta theta', 24, '…'), 'alpha beta gamma delta…');
  assert.equal(clipAtBoundary('abcdefghijklmnopqrstuvwxyz0123456789', 12, '…'), 'abcdefghijk…');
});

test('clipAtBoundary: a boundary too early (under 60% of the room) is not used', () => {
  const text = 'A. ' + 'b'.repeat(100);
  const out = clipAtBoundary(text, 40, '…');
  assert.equal(out, 'A. ' + 'b'.repeat(36) + '…');
});

test('clipAtBoundary: the marker counts against the cap', () => {
  const marker = '\n……（已截断）';
  const out = clipAtBoundary('x'.repeat(50) + '。' + 'y'.repeat(50), 60, marker);
  assert.ok(out.length <= 60);
  assert.ok(out.endsWith(marker));
});
