/**
 * H3 — skill self-repair: pure repair-candidate gate + thrash-guard helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRevisionHistory,
  isRepairCandidate,
  repairAttemptsExhausted,
  MAX_REPAIR_ATTEMPTS,
  REPAIR_REASON_PREFIX,
  type SkillRevision,
} from '../src/skill_repair.js';

// ── parseRevisionHistory ───────────────────────────────────────────────

test('parseRevisionHistory: null/undefined/empty -> []', () => {
  assert.deepEqual(parseRevisionHistory(null), []);
  assert.deepEqual(parseRevisionHistory(undefined), []);
  assert.deepEqual(parseRevisionHistory(''), []);
});

test('parseRevisionHistory: malformed JSON -> [] (never throws)', () => {
  assert.deepEqual(parseRevisionHistory('{not json'), []);
  assert.deepEqual(parseRevisionHistory('"a string, not an array"'), []);
  assert.deepEqual(parseRevisionHistory('{"not": "an array"}'), []);
});

test('parseRevisionHistory: valid array round-trips', () => {
  const entries: SkillRevision[] = [
    { at: 100, actionTemplate: 'do X', verification: null, toolPolicy: null, reason: 'r1' },
  ];
  assert.deepEqual(parseRevisionHistory(JSON.stringify(entries)), entries);
});

// ── isRepairCandidate ────────────────────────────────────────────────────

test('isRepairCandidate: demoted recipe (playbook + verification) -> true', () => {
  assert.equal(
    isRepairCandidate({ maturity: 'playbook', verification: { kind: 'assert', check: 'x' } }),
    true,
  );
});

test('isRepairCandidate: demoted prose lesson (playbook, no verification) -> false', () => {
  assert.equal(isRepairCandidate({ maturity: 'playbook', verification: null }), false);
});

test('isRepairCandidate: recipe not yet demoted (stable/confirmed/draft) -> false', () => {
  for (const maturity of ['draft', 'confirmed', 'stable', 'deprecated']) {
    assert.equal(
      isRepairCandidate({ maturity, verification: { kind: 'assert', check: 'x' } }),
      false,
      `maturity=${maturity} should not be a repair candidate`,
    );
  }
});

// ── repairAttemptsExhausted ──────────────────────────────────────────────

function revision(reason: string): SkillRevision {
  return { at: 0, actionTemplate: '', verification: null, toolPolicy: null, reason };
}

test('repairAttemptsExhausted: fewer than the ceiling -> false', () => {
  const history = [revision(`${REPAIR_REASON_PREFIX}sess1`), revision(`${REPAIR_REASON_PREFIX}sess2`)];
  assert.equal(history.length < MAX_REPAIR_ATTEMPTS, true);
  assert.equal(repairAttemptsExhausted(history), false);
});

test('repairAttemptsExhausted: reaching the ceiling -> true', () => {
  const history = Array.from({ length: MAX_REPAIR_ATTEMPTS }, (_, i) =>
    revision(`${REPAIR_REASON_PREFIX}sess${i}`),
  );
  assert.equal(repairAttemptsExhausted(history), true);
});

test('repairAttemptsExhausted: revisions from other sources (manual edit) do not count', () => {
  const history = Array.from({ length: MAX_REPAIR_ATTEMPTS }, () => revision('manual edit'));
  assert.equal(repairAttemptsExhausted(history), false);
});

test('repairAttemptsExhausted: empty history -> false', () => {
  assert.equal(repairAttemptsExhausted([]), false);
});
