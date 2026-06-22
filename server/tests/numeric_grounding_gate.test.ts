/**
 * Numeric / computation grounding gate — fires on "reported computed values with no successful
 * compute/exec tool", passes legitimately-backed or honestly-hedged replies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectUngroundedComputation,
  type GroundingToolResult,
} from '../src/numeric_grounding_gate.js';

const failGp: GroundingToolResult = {
  toolName: 'shell',
  content: '⚠ TOOL FAILED: PARI/GP script error (gp exited 0 but stderr reports an error)',
};
const okGp: GroundingToolResult = {
  toolName: 'pariGp',
  content: '✓ TOOL OK: r(20)=2 r(100)=6 ratio=1.32',
};
const okRead: GroundingToolResult = {
  toolName: 'readFile',
  content: '✓ TOOL OK: file contents …',
};

test('fires: the exact incident — "三轮探索跑完，全是真数据" with ratio, 0 successful compute tools', () => {
  const text =
    '## 给用户\n三轮探索跑完，全是真数据：自由卷积比值膨胀到13.6，谱半径≈12.3，交换子范数13.5。';
  const r = detectUngroundedComputation(text, [failGp, failGp]);
  assert.ok(r, 'should fire');
  assert.equal(r!.okCompute, 0);
});

test('fires: English "computed the ratio = 3.4" with no compute tool', () => {
  const text = 'I computed the ratio = 3.4 and verified numerically that it converges.';
  const r = detectUngroundedComputation(text, []);
  assert.ok(r);
});

test('does NOT fire: same claim BUT a successful pariGp result backs it', () => {
  const text = '数值验证完成：比值=1.32（见计算）。';
  const r = detectUngroundedComputation(text, [okGp]);
  assert.equal(r, null);
});

test('does NOT fire: honest hedge — "未能验证 / could not verify"', () => {
  const text =
    '## 给用户\n我没能验证这个比值——gp 脚本全部报错，本轮没有可用的计算结果。下一步我会修脚本重跑。';
  const r = detectUngroundedComputation(text, [failGp]);
  assert.equal(r, null);
});

test('does NOT fire: intention, not accomplishment ("我打算计算…")', () => {
  const text = '我打算计算 r(N) 的比值，预计在 N=100 时约为某个常数。';
  const r = detectUngroundedComputation(text, []);
  assert.equal(r, null);
});

test('does NOT fire: compute claim but NO numeric result token', () => {
  // "跑通了" with no number is a completion claim — honesty gate's lane, not this one.
  const text = '脚本跑通了，逻辑没问题。';
  const r = detectUngroundedComputation(text, []);
  assert.equal(r, null);
});

test('does NOT fire: plain conversational reply with incidental numbers', () => {
  const text = '我们有 3 个候选路径，我建议先看第 2 个。';
  const r = detectUngroundedComputation(text, []);
  assert.equal(r, null);
});

test('readFile success does NOT count as compute backing (still fires)', () => {
  const text = '实际计算得到谱半径≈12.3。';
  const r = detectUngroundedComputation(text, [okRead]);
  assert.ok(r, 'readFile is not a compute/exec tool — claim is still unbacked');
});

test('empty text → null', () => {
  assert.equal(detectUngroundedComputation('', [okGp]), null);
});
