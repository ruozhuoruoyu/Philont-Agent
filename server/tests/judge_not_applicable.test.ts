/**
 * The daily self-check, 2026-07-29:
 *
 *   · 可验证成果:18 轮里有 0 轮(0%)拿到了"目标达成"的证据。为 0 时,我从这些轮次里什么也学不到。
 *   → judge:18 次里 0 次。我按"坏了"而不是"闲着"处理,在加新东西之前先查它。
 *
 * Seven days of it: 103 verdicts, 3 verified. The report was reading the number correctly and drawing the
 * wrong conclusion, because the denominator contained turns that were never questions:
 *
 *   'The goal "继续推进验证" is vague — no specific claim to verify is stated'
 *   'The goal "做这个方向" is vague'
 *   '"你继续尝试吧，我没有什么倾向" — a passive, non-directive statement... no objective criterion'
 *   'the goal is a philosophical/epistemic query, not a concrete task'
 *
 * The judge had been saying so in prose all week, and every one still counted as a turn it failed to
 * verify. Same shape as the two denominators already fixed in this report — 997 retired routing rules
 * counted as active, and the 0/1 doom clause. An exaggerated report gets discounted; that is how the
 * console died.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeRun,
  goalStatesCheckableOutcome,
  parseGoalCriterion,
  buildGoalCriterionPrompt,
} from '../src/learning_judge.js';
import {
  recordJudgeVerdict,
  judgeWindowTally,
  _resetJudgeTallyForTest,
  computeHealthRatios,
} from '../src/health_report.js';

const reasoningTurn = {
  goal: '分析紧集的结构',
  finalText: '从已有记录看，k=4 有两个紧集。下一步可以从 c-向量入手。',
  trace: [{ toolName: 'search_notes', ok: true, summary: '3 hits' }],
  honestyFired: false,
};

test('a goal with no checkable outcome is not_applicable, not a failure to verify', async () => {
  const v = await judgeRun({ ...reasoningTurn, goal: '继续' }, { call: async () => 'NO' });
  assert.equal(v.outcome, 'not_applicable');
  assert.match(v.evidence ?? '', /no checkable outcome/);
});

test('a goal that DOES state an outcome stays could_not_verify when nothing grounded it', async () => {
  const v = await judgeRun(reasoningTurn, { call: async () => 'YES' });
  assert.equal(v.outcome, 'could_not_verify');
  assert.match(v.evidence ?? '', /no successful execution\/verifier tool/);
});

// The rule that made the first attempt unsafe: keying the exclusion on a claim-phrase list would move
// every claim the list misses from a visible could_not_verify into an invisible excluded bucket.
// 「我跑了 pariGp，k=6 全部通过，0 反例」 is exactly such a miss — claimsAResult does not match it.
test('the exclusion never looks at what the agent claimed, so it cannot launder one', async () => {
  const seen: string[] = [];
  const v = await judgeRun(
    { ...reasoningTurn, finalText: '我跑了 pariGp，k=6 全部通过，0 反例。' },
    {
      call: async (req) => {
        seen.push(req.user);
        return 'YES';
      },
    },
  );
  assert.equal(v.outcome, 'could_not_verify');
  for (const prompt of seen) {
    assert.doesNotMatch(prompt, /全部通过/, 'the criterion check must not be shown the reply');
  }
});

test('an unreachable judge leaves the previous behaviour exactly as it was', async () => {
  const v = await judgeRun({ ...reasoningTurn, goal: '继续' }, {
    call: async () => {
      throw new Error('aux down');
    },
  });
  assert.equal(v.outcome, 'could_not_verify');
});

test('the criterion parser accepts only the two words it asked for', () => {
  assert.equal(parseGoalCriterion('YES'), 'yes');
  assert.equal(parseGoalCriterion('no\n'), 'no');
  assert.equal(parseGoalCriterion('maybe'), 'unknown');
  assert.equal(parseGoalCriterion(''), 'unknown');
});

test('the criterion prompt carries the goal and nothing else', () => {
  const p = buildGoalCriterionPrompt('继续推进验证');
  assert.match(p, /继续推进验证/);
  assert.match(p, /Judge ONLY the goal text/);
});

test('a disabled criterion check restores the old denominator wholesale', async () => {
  const prev = process.env.PHILONT_JUDGE_GOAL_CRITERION;
  process.env.PHILONT_JUDGE_GOAL_CRITERION = '0';
  try {
    assert.equal(await goalStatesCheckableOutcome('继续', async () => 'NO'), 'unknown');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_JUDGE_GOAL_CRITERION;
    else process.env.PHILONT_JUDGE_GOAL_CRITERION = prev;
  }
});

test('an honesty fire is still a failure — not_applicable must not launder one', async () => {
  const v = await judgeRun({ ...reasoningTurn, honestyFired: true }, { call: async () => 'VERDICT: success' });
  assert.equal(v.outcome, 'failure');
});

test('the tally reports not-applicable separately instead of folding it in', () => {
  _resetJudgeTallyForTest();
  for (const o of ['not_applicable', 'not_applicable', 'could_not_verify', 'success']) {
    recordJudgeVerdict(o);
  }
  const t = judgeWindowTally();
  assert.equal(t.verified, 1);
  assert.equal(t.total, 2, 'only the turns that had a checkable goal');
  assert.equal(t.notApplicable, 2);
  _resetJudgeTallyForTest();
});

test('the report names the excluded turns — a quietly shrunk denominator is worth less', () => {
  const [judge] = computeHealthRatios({ judge: { verified: 0, total: 6, notApplicable: 12 } }).filter(
    (r) => r.key === 'judge',
  );
  assert.equal(judge.denominator, 6);
  assert.match(judge.line, /12/, 'the excluded count must appear in the line');
  assert.match(judge.line, /可检验/);
});

test('with nothing left to judge the report says nothing rather than 0%', () => {
  const rows = computeHealthRatios({ judge: { verified: 0, total: 0, notApplicable: 18 } });
  assert.equal(rows.filter((r) => r.key === 'judge').length, 0, 'no judgeable turns → no verdict line');
});
