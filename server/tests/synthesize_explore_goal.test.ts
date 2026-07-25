/**
 * What a force-started deep_explore session is aimed at.
 *
 * Production 2026-07-24 17:34: "找别人的论文有什么用呢？即使复现也是在别人的路线上而且肯定没有解决问题。"
 * — a critique of the current approach — passed the ≥12-char "self-contained goal" length proxy and was
 * transcribed VERBATIM as the session goal. The engine spent forty minutes researching the sociology of
 * literature review instead of returning to the Gyárfás problem with an original strategy. Route right,
 * goal literal. Length measures neither "does this stand alone" nor "is this a goal at all".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeExploreGoal } from '../src/chat-handler.js';

const CRITIQUE = '找别人的论文有什么用呢？即使复现也是在别人的路线上而且肯定没有解决问题。';
const COMPOSED = '不复现已有论文路线，用原创构造继续攻克 Gyárfás 路径染色问题：是否存在 r(G)=3 但 χ(G)≥5 的反例图';
const transcript = () => [
  { role: 'user', content: '继续攻克 Gyárfás 路径染色问题' },
  { role: 'assistant', content: '本轮我深入阅读了 Cameron-Clow 2025 论文…' },
];

test('the production shape: a critique of ongoing work becomes ongoing-task + new constraint', async () => {
  const asked: string[] = [];
  const goal = await synthesizeExploreGoal('s', CRITIQUE, {
    configured: true,
    transcript,
    ask: async (req) => {
      asked.push(req.user);
      return COMPOSED;
    },
  });
  assert.equal(goal, COMPOSED);
  assert.match(asked[0], /Gyárfás/, 'the aux must see the ongoing task, not just the sentence');
  assert.match(asked[0], /找别人的论文/, 'and the user message itself');
});

test('a message the aux judges to BE the goal comes back verbatim — precision preserved', async () => {
  const msg = '攻克 Erdős #287：单位分数间隙猜想，max(nᵢ₊₁−nᵢ) ≥ 3 是否必然成立';
  const goal = await synthesizeExploreGoal('s', msg, {
    configured: true,
    transcript,
    ask: async () => msg,
  });
  assert.equal(goal, msg);
});

test('UNSUITABLE (our enum, exact-matched on our own slot) suppresses the force-start', async () => {
  const goal = await synthesizeExploreGoal('s', '你这个分析是怎么做出来的？', {
    configured: true,
    transcript,
    ask: async () => 'UNSUITABLE',
  });
  assert.equal(goal, null, 'a meta-question must not become a session goal — the 9.5-minute precedent');
});

test('aux failure degrades to the pre-aux behavior, never blocks the turn', async () => {
  const boom = async () => {
    throw new Error('aux 404');
  };
  assert.equal(
    await synthesizeExploreGoal('s', CRITIQUE, { configured: true, transcript, ask: boom }),
    CRITIQUE,
    'long message → verbatim (the old behavior, imperfect but functional)',
  );
  assert.equal(
    await synthesizeExploreGoal('s', '深入点', { configured: true, transcript, ask: boom }),
    null,
    'short context-dependent message → no goal, no force-start',
  );
  assert.equal(await synthesizeExploreGoal('s', CRITIQUE, { configured: false }), CRITIQUE, 'no aux at all');
});

test('garbage aux output falls back instead of becoming a one-word goal', async () => {
  const goal = await synthesizeExploreGoal('s', CRITIQUE, {
    configured: true,
    transcript,
    ask: async () => '好的',
  });
  assert.equal(goal, CRITIQUE, 'a <12-char answer is not a goal; keep the verbatim fallback');
});

// ── Anchoring (2026-07-25 23:06) ────────────────────────────────────────────
//
// One day after this function replaced a length test, it shipped a goal that passed on length and named
// nothing: "还有其它方向可以尝试吗？" → "探索其他可能的研究方向或解决方案。" The engine then spent three minutes on
// "how to find novel research directions" and "science slowdown publish or perish", and hung ZERO nodes —
// the same sociology-of-research detour this function exists to prevent, arriving through the function.
import { longestCommonRun } from '../src/chat-handler.js';

const REAL_TRANSCRIPT = () => [
  { role: 'user', content: '继续攻克 Gyárfás 路径染色问题：是否存在 r(G)=3 但 χ(G)≥5 的反例图' },
  { role: 'assistant', content: '本轮穷举了 House of Graphs 的 80 个 4-临界 P₆-自由图' },
  { role: 'user', content: '还有其它方向可以尝试吗？' },
];

test('the production failure: a goal that names no object of study is refused outright', async () => {
  const goal = await synthesizeExploreGoal('s', '还有其它方向可以尝试吗？', {
    configured: true,
    transcript: REAL_TRANSCRIPT,
    ask: async () => '探索其他可能的研究方向或解决方案。',
  });
  assert.equal(goal, null, 'no session at all beats three minutes on a void');
});

test('a goal anchored in the conversation still passes', async () => {
  const good = '不复现已有论文路线，用原创构造继续攻克 Gyárfás 路径染色问题';
  const goal = await synthesizeExploreGoal('s', '还有其它方向可以尝试吗？', {
    configured: true,
    transcript: REAL_TRANSCRIPT,
    ask: async () => good,
  });
  assert.equal(goal, good);
});

test('a legitimate PIVOT anchors on the new subject, not the old one', async () => {
  const pivot = '放下 Gyárfás，改攻 Goldbach 猜想的奇偶性障碍';
  const goal = await synthesizeExploreGoal('s', '换个问题', {
    configured: true,
    transcript: () => [...REAL_TRANSCRIPT(), { role: 'assistant', content: '之前的 Goldbach 猜想 CRT 尝试' }],
    ask: async () => pivot,
  });
  assert.equal(goal, pivot);
});

test('longestCommonRun works on CJK, where word tokenisation does not', () => {
  assert.ok(longestCommonRun('攻克 Gyárfás 路径染色问题', '继续攻克 Gyárfás 路径染色问题的反例') >= 10);
  assert.ok(longestCommonRun('探索其他可能的研究方向或解决方案', '还有其它方向可以尝试吗') < 4);
  assert.equal(longestCommonRun('', 'abc'), 0);
});
