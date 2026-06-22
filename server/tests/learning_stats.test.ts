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
