import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHonestyFallback } from '../src/honesty_fallback.js';

test('honesty fallback contains only ledger counts and tool names', () => {
  const text = renderHonestyFallback([
    { toolName: 'leanCheck', content: '✓ TOOL OK\nexit 0' },
    { toolName: 'pariGp', content: '⚠ TOOL FAILED — timeout' },
  ], 'zh');
  assert.match(text, /成功 1（leanCheck）/);
  assert.match(text, /失败 1（pariGp）/);
  assert.doesNotMatch(text, /证明已完成|全部通过/);
});

test('honesty fallback does not invent detail when there were no tools', () => {
  const text = renderHonestyFallback([], 'en');
  assert.match(text, /0 succeeded \(none\)/);
  assert.match(text, /No unsupported/);
});
