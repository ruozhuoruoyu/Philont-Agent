/**
 * computeViability unit tests (Phase 18 ViabilityGate — the actuator).
 *
 * Verifies the verdict math: multi-signal accumulation, the progress veto, barrier-needs-stall,
 * and the no-active-session inert path. Pure function, no DB.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeViability,
  CONTINUATION_PITCH_RE,
  buildViabilityDirective,
  decideTurnAnchors,
  type ViabilityInput,
} from '../src/viability_gate.js';

function base(overrides: Partial<ViabilityInput> = {}): ViabilityInput {
  return {
    hasActiveSession: true,
    barrierApplies: false,
    goalIsOpenProblem: false,
    noProgressRounds: 0,
    status: 'active',
    provedCount: 0,
    openFrontierCount: 3,
    sameRootCause: 0,
    turnCount: 2,
    recommendStop: false,
    madeProgressThisTurn: false,
    repeatedPivotCount: 0,
    // Default: the episode HAS been worked (≥ MIN_EPISODE_ATTEMPTS settled nodes), so the attempt-floor
    // does not interfere with the pre-existing scoring tests. The floor is exercised explicitly below.
    attemptsThisEpisode: 3,
    ...overrides,
  };
}

test('session-less with no repeated failures → continue (near-zero false positives)', () => {
  // No reasoning session, no same_root_cause signal: barrier/stall fields are ignored without a session.
  const v = computeViability(base({ hasActiveSession: false, barrierApplies: true, noProgressRounds: 9 }));
  assert.equal(v.verdict, 'continue');
});

test('session-less doom-loop: same_root_cause scales by magnitude', () => {
  // The prod gap: doom-loop moved into raw shell/patch grinding (no deep_explore session). same_root_cause
  // is global, so it still fires — and a runaway count must escalate pivot→stop.
  assert.equal(computeViability(base({ hasActiveSession: false, sameRootCause: 3 })).verdict, 'pivot');
  assert.equal(computeViability(base({ hasActiveSession: false, sameRootCause: 6 })).verdict, 'pivot');
  const severe = computeViability(base({ hasActiveSession: false, sameRootCause: 9 }));
  assert.equal(severe.verdict, 'stop_and_report'); // score 4 — would have stopped the 4-hour prod loop
  assert.ok(severe.reasons.includes('same_root_cause_severe'));
  assert.match(severe.evidence, /9×/);
});

test('same_root_cause=6 + long churny session-less turn → stop (3+1)', () => {
  const v = computeViability(base({ hasActiveSession: false, sameRootCause: 6, turnCount: 25 }));
  assert.equal(v.verdict, 'stop_and_report');
});

test('barrier applies but NOT stalled → does not stop (barrier alone is not enough)', () => {
  const v = computeViability(base({ barrierApplies: true, noProgressRounds: 0 }));
  assert.equal(v.verdict, 'continue');
});

test('barrier applies AND stalled ≥3 rounds → stop_and_report (score 3+1=4)', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 3, barrierTitle: 'Parity problem', barrierCircumvention: 'weaken target' }),
  );
  assert.equal(v.verdict, 'stop_and_report');
  assert.ok(v.reasons.includes('barrier_applies_and_stalled'));
  assert.ok(v.reasons.includes('no_progress_rounds'));
  assert.equal(v.recommendedReframe, 'weaken target');
  assert.match(v.evidence, /Parity problem/);
});

test('empty frontier with 0 proved → stop (frontier_empty_no_proof, score 3) needs one more for stop; pivot at 3', () => {
  // status stuck + 0 proved = +3 → that is >= PIVOT(2) but < STOP(4) → pivot
  const v = computeViability(base({ status: 'stuck', provedCount: 0, openFrontierCount: 0 }));
  assert.equal(v.verdict, 'pivot');
  assert.ok(v.reasons.includes('frontier_empty_no_proof'));
});

test('stuck + same_root_cause cluster → stop (3+2=5)', () => {
  const v = computeViability(base({ status: 'stuck', provedCount: 0, sameRootCause: 4 }));
  assert.equal(v.verdict, 'stop_and_report');
});

test('episode-attempt floor: a would-be stop on an under-attempted session → continue (the prod redirect bug)', () => {
  // The smoking gun: user redirects to a fresh direction; the global same_root_cause (6) + a stale
  // recommend_stop carry over and score a stop — but the new direction has 0 settled nodes. It must NOT be
  // declared a wall before it's been tried.
  const v = computeViability(base({ sameRootCause: 6, recommendStop: true, attemptsThisEpisode: 0 }));
  assert.equal(v.verdict, 'continue');
  assert.ok(v.reasons.includes('insufficient_episode_attempts'));
});

test('episode-attempt floor: stuck+cluster but only 1 attempt → continue; ≥2 attempts → stop', () => {
  assert.equal(
    computeViability(base({ status: 'stuck', provedCount: 0, sameRootCause: 4, attemptsThisEpisode: 1 })).verdict,
    'continue',
  );
  assert.equal(
    computeViability(base({ status: 'stuck', provedCount: 0, sameRootCause: 4, attemptsThisEpisode: 2 })).verdict,
    'stop_and_report',
  );
});

test('episode-attempt floor does NOT apply session-less (global doom-loop still stops)', () => {
  const v = computeViability(base({ hasActiveSession: false, sameRootCause: 9, attemptsThisEpisode: 0 }));
  assert.equal(v.verdict, 'stop_and_report');
});

test('episode-attempt floor does NOT rescue an intractable open-problem goal', () => {
  // A known open problem is out of reach regardless of attempts — intractable returns before the floor.
  const v = computeViability(base({ goalIsOpenProblem: true, status: 'stuck', attemptsThisEpisode: 0 }));
  assert.equal(v.verdict, 'intractable');
});

test('progress this turn vetoes everything → continue', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 5, sameRootCause: 9, recommendStop: true, madeProgressThisTurn: true }),
  );
  assert.equal(v.verdict, 'continue');
  assert.deepEqual(v.reasons, ['progress_this_turn']);
});

test('reflection recommend_stop alone → pivot (score 3), with any stall → stop', () => {
  assert.equal(computeViability(base({ recommendStop: true })).verdict, 'pivot');
  assert.equal(
    computeViability(base({ recommendStop: true, noProgressRounds: 3 })).verdict,
    'stop_and_report',
  );
});

test('ratchet: a fresh pivot after 3 prior pivots escalates to stop (de-facto exhausted)', () => {
  // score=2 → base verdict pivot (no curated barrier, no open-problem flag — the untracked long tail)
  const single = computeViability(base({ sameRootCause: 3, repeatedPivotCount: 0 }));
  assert.equal(single.verdict, 'pivot');
  // same signals, but the gate has already pivoted 3 turns running → escalate to stop
  const ratcheted = computeViability(base({ sameRootCause: 3, repeatedPivotCount: 3 }));
  assert.equal(ratcheted.verdict, 'stop_and_report');
  assert.ok(ratcheted.reasons.includes('repeated_pivot_ratchet'));
  assert.match(ratcheted.evidence, /turns running with no improvement/);
});

test('ratchet does not fire while verdict is continue (streak is about non-continue turns)', () => {
  const v = computeViability(base({ sameRootCause: 0, repeatedPivotCount: 9 }));
  assert.equal(v.verdict, 'continue'); // no red signal this turn → continue regardless of prior streak
});

test('healthy long task (proved nodes, advancing) → continue', () => {
  const v = computeViability(base({ turnCount: 30, provedCount: 5, noProgressRounds: 0 }));
  assert.equal(v.verdict, 'continue');
});

test('continuation-pitch regex matches the pitch, not the bare instruction', () => {
  assert.match('要我继续吗？', CONTINUATION_PITCH_RE);
  assert.match('要不要我继续推进第2轮', CONTINUATION_PITCH_RE);
  assert.match('Shall I continue?', CONTINUATION_PITCH_RE);
  assert.match('要我开始吗', CONTINUATION_PITCH_RE);
  // bare instruction "reply 继续 to keep going" must NOT match
  assert.doesNotMatch('回复"继续"我会再跑一轮', CONTINUATION_PITCH_RE);
  assert.doesNotMatch('this round saved the tree', CONTINUATION_PITCH_RE);
});

test('open problem + stuck → intractable (no path, categorical no-go)', () => {
  const v = computeViability(
    base({
      goalIsOpenProblem: true,
      barrierApplies: true,
      barrierTitle: 'Parity problem (Selberg) — sieves cannot prove binary Goldbach',
      barrierCircumvention: 'Chen / bilinear input',
      turnCount: 18,
      provedCount: 0, // long_barren ⇒ reallyStuck
    }),
  );
  assert.equal(v.verdict, 'intractable');
  assert.ok(v.reasons.includes('goal_is_open_problem'));
  assert.equal(v.recommendedReframe, undefined); // MUST NOT hand the user a path
  assert.match(v.evidence, /open problem/i);
});

test('open problem but NOT stuck (progressing on sub-lemmas) → not intractable', () => {
  const v = computeViability(
    base({ goalIsOpenProblem: true, barrierApplies: true, provedCount: 4, noProgressRounds: 0, turnCount: 18 }),
  );
  assert.notEqual(v.verdict, 'intractable'); // still proving sub-results → don't declare hopeless
});

test('intractable directive: states categorical truth, offers NO path, forbids 继续 invitation', () => {
  const v = computeViability(
    base({ goalIsOpenProblem: true, barrierApplies: true, barrierTitle: 'Erdős–Straus — Jacobi barrier', status: 'stuck' }),
  );
  const d = buildViabilityDirective(v, { provedCount: 2, openProblemNote: 'BlEl22 modular reduction' });
  assert.match(d, /known open problem|categorically out of reach/i);
  assert.match(d, /do NOT list approaches to try/i);
  assert.match(d, /genuinely new idea/i);
  assert.match(d, /BlEl22 modular reduction/); // named only as "itself unsolved", not as a path
  // must NOT contain the soft "reply 继续 to keep probing" door that the pivot/stop directive has
  assert.doesNotMatch(d, /reply 继续 only if you want me to keep probing/);
});

test('method barrier WITHOUT open-problem flag → pivot offers the reframe (real alternative)', () => {
  const v = computeViability(
    base({ goalIsOpenProblem: false, barrierApplies: true, noProgressRounds: 3, barrierCircumvention: 'use a different decomposition' }),
  );
  assert.notEqual(v.verdict, 'intractable');
  assert.equal(v.recommendedReframe, 'use a different decomposition'); // legitimate pivot still offers a path
});

test('directive forbids the pitch and credits banked lemmas', () => {
  const v = computeViability(
    base({ barrierApplies: true, noProgressRounds: 4, barrierTitle: 'Jacobi barrier', barrierCircumvention: 'inject non-sieve input' }),
  );
  const d = buildViabilityDirective(v, { provedCount: 3 });
  assert.match(d, /要我继续吗/);
  assert.match(d, /3 proved lemma/);
  assert.match(d, /inject non-sieve input/);
});

// ── decideTurnAnchors (commit-on-affirm + stay-on-target) ───────────────────────────────────────

test('commit: prior offer-pitch + user pushes forward → commit + anchor', () => {
  const d = decideTurnAnchors({
    lastAssistantText: '我建议并行扫描 Eq1、Eq3、Eq5。要我开这个搜索吗？',
    userMessage: '继续',
    hadDoom: false,
  });
  assert.equal(d.commit, true);
  assert.equal(d.anchor, true);
});

test('commit recognizes the real prod pitches, not just "要继续吗"', () => {
  for (const pitch of ['要不要我列几个适合反例搜索的猜想？', '选哪个？或者我并行开两个？', '要继续这个方向吗？']) {
    const d = decideTurnAnchors({ lastAssistantText: pitch, userMessage: '启动', hadDoom: false });
    assert.equal(d.commit, true, `should commit for pitch: ${pitch}`);
  }
});

test('no commit when there was no pitch (a plain wall-report)', () => {
  const d = decideTurnAnchors({
    lastAssistantText: '这条路死了，建议整合论文。回复继续只在你坚持时。',
    userMessage: '继续',
    hadDoom: true,
  });
  assert.equal(d.commit, false); // no offer-question → nothing concrete to execute
});

test('redirect: substantive new instruction after doom → doomReset + anchor (no commit)', () => {
  const d = decideTurnAnchors({
    lastAssistantText: '这条路死了，建议停在这里。',
    userMessage: '专注 Erdős 问题集中的长尾题',
    hadDoom: true,
  });
  assert.equal(d.doomReset, true);
  assert.equal(d.anchor, true);
  assert.equal(d.commit, false);
});

test('bare "ok" after doom is too ambiguous → no reset, no anchor', () => {
  const d = decideTurnAnchors({ lastAssistantText: '建议停在这里。', userMessage: 'ok', hadDoom: true });
  assert.equal(d.doomReset, false);
  assert.equal(d.anchor, false);
});

test('acceptance ("算了，换个框架") → no doomReset (confirms the stop)', () => {
  const d = decideTurnAnchors({ lastAssistantText: '建议停。', userMessage: '算了，换个框架吧', hadDoom: true });
  assert.equal(d.doomReset, false);
});

test('no accumulated doom → no reset even on a redirect (nothing to clear)', () => {
  const d = decideTurnAnchors({ lastAssistantText: '好的。', userMessage: '做个新方向', hadDoom: false });
  assert.equal(d.doomReset, false);
});

test('commit: "整理论文吧"-style verb+吧 imperatives now trigger after a pitch', () => {
  for (const msg of ['整理论文吧', '做这个吧', '去做', '开搞', '动手', '去整理']) {
    const d = decideTurnAnchors({ lastAssistantText: '要继续整理论文吗？', userMessage: msg, hadDoom: false });
    assert.equal(d.commit, true, `should commit for: ${msg}`);
  }
});

test('"算了吧"/"放弃吧" are acceptance, never commit even after a pitch', () => {
  for (const msg of ['算了吧', '放弃吧', '不做了']) {
    const d = decideTurnAnchors({ lastAssistantText: '要继续整理吗？', userMessage: msg, hadDoom: true });
    assert.equal(d.commit, false, `should NOT commit for acceptance: ${msg}`);
    assert.equal(d.doomReset, false, `acceptance must not reset doom: ${msg}`);
  }
});
