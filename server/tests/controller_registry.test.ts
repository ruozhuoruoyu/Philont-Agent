/**
 * controller_registry unit tests (self-learning Phase 3a).
 *
 * Verifies the three properties the registry promises: it ENUMERATES the existing gates as
 * controllers, it can DESCRIBE each one, and it COUNTS fires per controller (in-process + forwarded
 * to an injected metrics sink). Pure — no DB, no chat-handler import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listControllers,
  getController,
  isKnownController,
  describeControllers,
  recordControllerFire,
  getControllerFireCount,
  controllerFireSnapshot,
  resetControllerFires,
  setControllerMetrics,
  fireMetricKey,
  logRegisteredControllers,
  type ControllerFireSink,
} from '../src/controller_registry.js';

// The gates the redesign says must each be covered by a registered controller.
const EXPECTED_IDS = [
  'honesty',
  'empty_conclusion',
  'half_finished',
  'output_format',
  'citation_grounding',
  'numeric_grounding',
  'viability',
  'conscience',
  'plan_protocol',
  'phase',
];

test('enumeration: every existing gate is registered exactly once', () => {
  const ids = listControllers().map((c) => c.id);
  assert.equal(ids.length, EXPECTED_IDS.length);
  for (const id of EXPECTED_IDS) {
    assert.ok(ids.includes(id), `missing controller: ${id}`);
    assert.ok(isKnownController(id));
  }
  // no duplicates
  assert.equal(new Set(ids).size, ids.length);
});

test('enumeration: each controller carries a real failure mode + source pointer', () => {
  for (const c of listControllers()) {
    assert.ok(c.failureMode.length > 10, `${c.id} failureMode too thin`);
    assert.ok(/\.ts$/.test(c.module), `${c.id} module should point at a .ts file`);
    assert.ok(c.entry.length > 0, `${c.id} missing entry`);
    assert.ok(['answer-time', 'send-time', 'tool-gate', 'phase'].includes(c.layer));
    assert.ok(['regen', 'block', 'decide', 'exempt-predicate'].includes(c.shape));
  }
});

test('enumeration: the two per-call deciders are enumerated but not fire-counted', () => {
  assert.equal(getController('plan_protocol')?.countable, false);
  assert.equal(getController('phase')?.countable, false);
  // the seven answer-time regen gates + conscience are fire-counted
  const countable = listControllers().filter((c) => c.countable).map((c) => c.id);
  assert.deepEqual(
    countable.sort(),
    [
      'citation_grounding',
      'conscience',
      'empty_conclusion',
      'half_finished',
      'honesty',
      'numeric_grounding',
      'output_format',
      'viability',
    ].sort(),
  );
});

test('describe: describeControllers mentions every id, describe() is per-controller', () => {
  const catalog = describeControllers();
  for (const id of EXPECTED_IDS) {
    assert.ok(catalog.includes(`[${id}]`), `catalog missing ${id}`);
  }
  const honesty = getController('honesty')!;
  const d = honesty.describe();
  assert.ok(d.includes('[honesty]'));
  assert.ok(d.includes('honesty_gate.ts'));
  assert.ok(d.includes('layer=answer-time'));
  assert.ok(d.includes('fires when:'));
});

test('getController returns undefined for unknown ids', () => {
  assert.equal(getController('does_not_exist'), undefined);
  assert.equal(isKnownController('does_not_exist'), false);
});

test('fire-counting: in-process counter increments per controller', () => {
  resetControllerFires();
  setControllerMetrics(null); // isolate the in-process path
  assert.equal(getControllerFireCount('honesty'), 0);
  recordControllerFire('honesty');
  recordControllerFire('honesty');
  recordControllerFire('viability');
  assert.equal(getControllerFireCount('honesty'), 2);
  assert.equal(getControllerFireCount('viability'), 1);
  assert.equal(getControllerFireCount('citation_grounding'), 0);
  const snap = controllerFireSnapshot();
  assert.deepEqual(snap, { honesty: 2, viability: 1 });
});

test('fire-counting: forwards to the injected metrics sink under controller.fire.<id>', () => {
  resetControllerFires();
  const calls: Array<{ key: string; n?: number }> = [];
  const sink: ControllerFireSink = {
    increment(key: string, n?: number) {
      calls.push({ key, n });
    },
  };
  setControllerMetrics(sink);
  recordControllerFire('empty_conclusion');
  recordControllerFire('empty_conclusion', 3);
  assert.deepEqual(calls, [
    { key: 'controller.fire.empty_conclusion', n: 1 },
    { key: 'controller.fire.empty_conclusion', n: 3 },
  ]);
  assert.equal(fireMetricKey('empty_conclusion'), 'controller.fire.empty_conclusion');
  // in-process count reflects the n as well
  assert.equal(getControllerFireCount('empty_conclusion'), 4);
  setControllerMetrics(null);
});

test('fire-counting: unknown id is still counted but never throws', () => {
  resetControllerFires();
  setControllerMetrics(null);
  assert.doesNotThrow(() => recordControllerFire('typo_gate'));
  assert.equal(getControllerFireCount('typo_gate'), 1);
});

test('fire-counting: a throwing sink does not propagate (instrumentation is inert)', () => {
  resetControllerFires();
  setControllerMetrics({
    increment() {
      throw new Error('db exploded');
    },
  });
  assert.doesNotThrow(() => recordControllerFire('honesty'));
  // in-process counter still advanced before the sink threw
  assert.equal(getControllerFireCount('honesty'), 1);
  setControllerMetrics(null);
});

test('logRegisteredControllers emits a one-line summary of the registry', () => {
  const lines: string[] = [];
  logRegisteredControllers((m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('10 controllers registered'));
  assert.ok(lines[0].includes('fire-counted:'));
  assert.ok(lines[0].includes('enumerated-only:'));
  assert.ok(lines[0].includes('plan_protocol'));
});
