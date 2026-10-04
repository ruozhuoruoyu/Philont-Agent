/**
 * Keep-best revision acceptance (skill_repair.ts + SkillStore.recordSkillOutcome), 2026-10-04.
 * Pure decision on reconstructed per-version records; store applies it only in mode `on`; shadow reports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, versionRecords, keepBestDecision, REPAIR_REASON_PREFIX, KEEP_BEST_REASON_PREFIX, type SkillRevision } from '../src/index.js';

const rev = (reason: string, s?: number, f?: number): SkillRevision => ({ at: 1, actionTemplate: 'old', verification: { kind: 'tool_result_ok', check: 'readFile' } as never, toolPolicy: null, reason, successCount: s, failureCount: f });

test('versionRecords: per-version record from cumulative totals; old snapshots without totals break the chain', () => {
  // v0 ran 4/1, superseded; v1 ran 1/3, superseded; live v2 ran 2/0
  const recs = versionRecords({ successCount: 7, failureCount: 4, revisionHistory: [rev('a', 4, 1), rev('b', 5, 4)] });
  assert.deepEqual(recs.map((r) => [r.index, r.successes, r.failures]), [[0, 4, 1], [1, 1, 3], [-1, 2, 0]]);
  // a legacy snapshot (no totals) makes its own and the next record unknown; the live record is known again
  const legacy = versionRecords({ successCount: 7, failureCount: 4, revisionHistory: [rev('a'), rev('b', 5, 4)] });
  assert.deepEqual(legacy.map((r) => r.index), [-1]);
  const legacyLast = versionRecords({ successCount: 7, failureCount: 4, revisionHistory: [rev('a', 4, 1), rev('b')] });
  assert.deepEqual(legacyLast.map((r) => r.index), [0]);
});

test('keepBestDecision: judged only when live version came from repair; reverts when worse than the best prior', () => {
  const ver = { kind: 'tool_result_ok', check: 'readFile' };
  // live version from repair, 0/3 after a prior 4/1 → revert
  const d = keepBestDecision({ verification: ver, successCount: 4, failureCount: 4, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 4, 1)] });
  assert.equal(d.action, 'revert');
  assert.equal(d.best!.index, 0);
  // same but only 2 outcomes so far → keep (under min)
  const under = keepBestDecision({ verification: ver, successCount: 4, failureCount: 3, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 4, 1)] });
  assert.equal(under.action, 'keep');
  // live version better → keep
  const better = keepBestDecision({ verification: ver, successCount: 7, failureCount: 1, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 4, 1)] });
  assert.equal(better.action, 'keep');
  // live version restored by keep-best → not judged (no ping-pong)
  const restored = keepBestDecision({ verification: ver, successCount: 4, failureCount: 4, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 4, 1), rev(`${KEEP_BEST_REASON_PREFIX}y`, 4, 1)] });
  assert.equal(restored.action, 'not_applicable');
  // prior version too thin (1 outcome) → not applicable
  const thin = keepBestDecision({ verification: ver, successCount: 1, failureCount: 3, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 1, 0)] });
  assert.equal(thin.action, 'not_applicable');
  // prose lesson (no verification) → not applicable
  assert.equal(keepBestDecision({ verification: null, successCount: 0, failureCount: 9, revisionHistory: [rev(`${REPAIR_REASON_PREFIX}x`, 4, 1)] }).action, 'not_applicable');
});

function seed(mode: string) {
  process.env.PHILONT_SKILL_KEEP_BEST = mode;
  const h = openMemoryDb(':memory:');
  const seen: { decision: string; applied: boolean }[] = [];
  h.skills.setLearningHooks({ onKeepBest: (i) => seen.push({ decision: i.decision.action, applied: i.applied }) });
  h.skills.createSkill({ name: 'r', description: 'd', triggerKeywords: ['x'], actionTemplate: 'good steps', verification: { kind: 'tool_result_ok', check: 'readFile' } as never });
  for (let i = 0; i < 4; i++) h.skills.recordSkillOutcome('r', true);
  h.skills.recordSkillOutcome('r', false);
  const revised = h.skills.reviseRecipe('r', { actionTemplate: 'bad steps', reason: `${REPAIR_REASON_PREFIX}s1` });
  assert.ok(revised);
  assert.equal(revised!.revisionHistory[0].successCount, 4);
  assert.equal(revised!.revisionHistory[0].failureCount, 1);
  return { h, seen };
}

test('store, mode on: after 3 failures on the repaired version the best prior version is restored', () => {
  const { h, seen } = seed('on');
  h.skills.recordSkillOutcome('r', false);
  h.skills.recordSkillOutcome('r', false);
  assert.equal(h.skills.getByName('r')!.actionTemplate, 'bad steps', 'not yet judged under min outcomes');
  const after = h.skills.recordSkillOutcome('r', false)!;
  assert.equal(after.actionTemplate, 'good steps');
  assert.equal(after.revisionHistory.length, 2);
  assert.ok(after.revisionHistory[1].reason.startsWith(KEEP_BEST_REASON_PREFIX));
  assert.equal(after.maturity, 'draft', 'restored version re-enters the ladder');
  assert.deepEqual(seen.at(-1), { decision: 'revert', applied: true });
  // and the restored version is not judged again against the one it displaced
  h.skills.recordSkillOutcome('r', false);
  assert.equal(h.skills.getByName('r')!.actionTemplate, 'good steps');
  assert.equal(seen.length, 3, 'keep, keep, revert — nothing after the restore');
  delete process.env.PHILONT_SKILL_KEEP_BEST;
});

test('store, shadow (default): the same decision is reported but nothing is reverted', () => {
  const { h, seen } = seed('');
  for (let i = 0; i < 3; i++) h.skills.recordSkillOutcome('r', false);
  assert.equal(h.skills.getByName('r')!.actionTemplate, 'bad steps');
  assert.deepEqual(seen.at(-1), { decision: 'revert', applied: false });
  delete process.env.PHILONT_SKILL_KEEP_BEST;
});

test('store, off: no decision, no hook', () => {
  const { h, seen } = seed('off');
  for (let i = 0; i < 3; i++) h.skills.recordSkillOutcome('r', false);
  assert.equal(h.skills.getByName('r')!.actionTemplate, 'bad steps');
  assert.equal(seen.length, 0);
  delete process.env.PHILONT_SKILL_KEEP_BEST;
});
