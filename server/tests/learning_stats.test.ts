/**
 * renderLearningStats — aggregates counters + derived table state into a report. Smoke test: it must
 * render on an empty DB and reflect counters/rows when present, never throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '@agent/memory';
import { renderLearningStats } from '../src/learning_stats.js';

test('renders on a fresh empty DB without throwing', () => {
  const h = openMemoryDb(':memory:');
  const out = renderLearningStats(h);
  assert.match(out, /Learning instrumentation/);
  assert.match(out, /routing rule injected in 0\/0 turns/);
  h.close();
});

test('reflects counters and a routing rule', () => {
  const h = openMemoryDb(':memory:');
  h.metrics.increment('turn.total', 10);
  h.metrics.increment('routing.inject.turns', 3);
  h.metrics.increment('inturn.fire', 7);
  h.routingRules.createRule({
    taskSignature: 'sig',
    triggerCondition: 'when X',
    preferSkill: null,
    avoidSkills: [],
    carveout: 'not Y',
    evidence: 'turn 3',
    confidence: 'provisional',
    contextKeywords: ['x'],
    reflectionId: null,
  });
  const out = renderLearningStats(h);
  assert.match(out, /routing rule injected in 3\/10 turns \(30%\)/);
  assert.match(out, /in-turn reminders fired=7/);
  assert.match(out, /routing_rules \(stored\)/);
  assert.match(out, /total=1/);
  h.close();
});

test('a mechanism saying stop is not a failure signature', () => {
  // Production 2026-09-10: the first line of the system's own health readout was
  // `deep_explore:other:rejected_by_in_turn_reflection×120` — a control working as designed, reported
  // as philont's largest defect, above every real wall. groupFailures had excluded these since
  // 2026-06-09; this reader never applied the same rule.
  const h = openMemoryDb(':memory:');
  for (let i = 0; i < 5; i++) {
    h.actions.log({
      sessionId: 'global', toolName: 'deep_explore', params: {},
      result: 'rejected_by_in_turn_reflection', success: false,
    });
  }
  for (let i = 0; i < 2; i++) {
    h.actions.log({
      sessionId: 'global', toolName: 'leanCheck', params: {},
      result: 'unsolved goals', success: false,
    });
  }
  const out = renderLearningStats(h);
  const topLine = out.split('\n').find((l) => l.includes('top failure signatures'))!;
  assert.ok(topLine, 'the report must still have a top-failure line');
  assert.doesNotMatch(topLine, /rejected_by_/,
    'a deliberate mechanism stop must not outrank the real walls it is reported above');
  assert.match(topLine, /leanCheck:lean-unsolved×2/, 'the real failure is still counted');
  // Not hidden — 5 calls into a tool a mechanism had already disabled is worth knowing.
  const rejectionLine = out.split('\n').find((l) => l.includes('mechanism rejections'))!;
  assert.match(rejectionLine, /deep_explore:other:rejected_by_in_turn_reflection×5/);
  h.close();
});

test('the frontier shadow counter is rendered with what it means', () => {
  // Raw, `frontier_shadow disagree=144 agree=7` reads as the model and the tree disagreeing 95% of the
  // time. It is the value scorer overriding the naive frontier order — its job. The report has to say so.
  const h = openMemoryDb(':memory:');
  h.metrics.increment('deep_explore.frontier_shadow.agree', 1);
  h.metrics.increment('deep_explore.frontier_shadow.disagree', 3);
  const out = renderLearningStats(h);
  assert.match(out, /value-guided frontier overrode the naive order in 3 of 4 scored rounds/);
  assert.match(out, /not a disagreement about the tree/);
  h.close();
});
