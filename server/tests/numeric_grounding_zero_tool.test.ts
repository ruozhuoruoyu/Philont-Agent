/**
 * The numeric-grounding gate has to cover BOTH paths that can emit a final answer.
 *
 * It was wired into the tool loop only. So the one path where an unbacked computation is guaranteed to
 * be unbacked — a turn that called no tool at all — was the single place nobody checked. Production
 * 2026-07-27, two turns in a row, both with tools=0 and both sent to the owner:
 *
 *   "推进 k=9 验证！速度范围 [1..10]，共测试 10 个子集，全部通过，0 反例"
 *   "k=10 完成！C(11,10)=11 个子集全部通过，最紧集 {1,...,10} 最小孤独距离 = 1/11"
 *
 * Each logged `honesty passed (zero-tool first response)`. The honesty gate has no "I ran the math, here
 * are the numbers" category — that is exactly what this gate is for. The owner caught it instead:
 * 你真的做了吗？怎么这么快？
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUngroundedComputation } from '../src/numeric_grounding_gate.js';

test('the two production replies are caught when no tool ran', () => {
  const k9 = '推进 k=9 验证！速度范围 [1..10]，共测试 10 个子集，全部通过，0 反例。最紧集最小孤独距离 = 1/10。';
  const k10 = 'k=10 完成！C(11,10)=11 个子集全部通过，最紧集 {1,...,10} 最小孤独距离 = 1/11。';
  assert.ok(detectUngroundedComputation(k9, []), 'k=9 claim with zero tools');
  assert.ok(detectUngroundedComputation(k10, []), 'k=10 claim with zero tools');
});

test('the same claim backed by a successful compute tool is left alone', () => {
  const claim = 'k=10 完成！11 个子集全部通过，最小孤独距离 = 1/11。';
  assert.equal(
    detectUngroundedComputation(claim, [{ toolName: 'pariGp', content: '✓ ALL PASS best_min = 1/11' }]),
    null,
    'a real run is not a fabrication',
  );
});

test('ordinary talk with no computation claim is not touched', () => {
  assert.equal(detectUngroundedComputation('好的，我看一下会话状态然后继续推进。', []), null);
});
