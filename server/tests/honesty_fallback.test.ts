import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHonestyFallback } from '../src/honesty_fallback.js';

test('the fallback carries the section heading the channels require', () => {
  // Prod 2026-09-01 09:13: the fallback fired correctly and then logged `sectionHit: false`, because a
  // mechanism-authored reply was the one reply in the system that ignored the output contract.
  assert.match(renderHonestyFallback([], 'zh'), /^## 给用户/);
  assert.match(renderHonestyFallback([], 'en'), /^## For User/);
});

test('honesty fallback reports what the tools returned, not just how many ran', () => {
  const text = renderHonestyFallback([
    { toolName: 'leanCheck', content: '✓ TOOL OK\nBuilt Lrc.K13.Region3Sum\nexit 0' },
    { toolName: 'pariGp', content: '⚠ TOOL FAILED — [exitCode=1] PARI/GP computation timed out' },
  ], 'zh');
  assert.match(text, /成功 1（leanCheck）/);
  assert.match(text, /失败 1（pariGp）/);
  assert.match(text, /Built Lrc\.K13\.Region3Sum/, 'the actual result line, not only the tool name');
  assert.match(text, /timed out/);
  assert.doesNotMatch(text, /证明已完成|全部通过/);
});

test('honesty fallback does not invent detail when there were no tools', () => {
  const text = renderHonestyFallback([], 'en');
  assert.match(text, /0 succeeded \(none\)/);
  assert.doesNotMatch(text, /Last \d+ tool results/, 'no empty section when there is nothing to list');
});

test('duplicate tool names are listed once, and long output lines are truncated', () => {
  const long = 'x'.repeat(400);
  const text = renderHonestyFallback([
    { toolName: 'shell', content: `✓ TOOL OK\n${long}` },
    { toolName: 'shell', content: '✓ TOOL OK\nsecond' },
  ], 'en');
  assert.match(text, /2 succeeded \(shell\)/);
  assert.ok(!text.includes(long), 'the 400-char line is not pasted whole');
  assert.match(text, /…/);
});
