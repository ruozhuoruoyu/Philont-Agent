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

test('a credential-shaped tool output line is withheld, not published to the channel', () => {
  // The deterministic path has no model in between to leave things out: whatever it quotes, it sends.
  for (const leak of [
    'OPENAI_API_KEY=sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGG',
    'export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    '{"api_key": "AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6"}',
  ]) {
    const text = renderHonestyFallback([{ toolName: 'readFile', content: `✓ TOOL OK\n${leak}` }], 'en');
    assert.match(text, /withheld/);
    assert.ok(!text.includes('sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGG'), leak);
    assert.ok(!text.includes('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), leak);
    assert.ok(!text.includes('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6'), leak);
  }
  // Ordinary output still comes through — the point is a report, not a redaction exercise.
  const ok = renderHonestyFallback([{ toolName: 'shell', content: '✓ TOOL OK\nBuilt Lrc.K13.Region3Sum' }], 'en');
  assert.match(ok, /Built Lrc\.K13\.Region3Sum/);
});
