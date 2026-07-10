/**
 * H3 — skillRevisionWriter OutcomeHook: applySkillRevision 各分支 + 真实写回 SkillStore。
 * 这是自进化回路的最后一跳:诊断结果 → reviseRecipe(存旧版本 + 回落 draft)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  applySkillRevision,
  skillRevisionWriter,
  parseSkillTargetRef,
} from '../src/index.js';
import type { Initiative, InitiativeRunResult, SkillStore } from '../src/index.js';
import { REPAIR_REASON_PREFIX } from '../src/skill_repair.js';

// ── parseSkillTargetRef ──────────────────────────────────────────────────

test('parseSkillTargetRef: skill:<name> → name;非 skill 形状 → null', () => {
  assert.equal(parseSkillTargetRef('skill:docx-recipe'), 'docx-recipe');
  assert.equal(parseSkillTargetRef('skill:has:colons'), 'has:colons');
  assert.equal(parseSkillTargetRef('fact:f1'), null);
  assert.equal(parseSkillTargetRef('skill:'), null);
});

// ── fixtures ─────────────────────────────────────────────────────────────

function repairInit(over: Partial<Initiative> = {}): Initiative {
  return {
    id: 'init-repair-1',
    kind: 'skill_repair',
    driver: 'skill_repair',
    targetRef: 'skill:docx-recipe',
    rationale: 'failed its own reuse verification',
    utility: 0.55,
    budgetEstimate: 2500,
    status: 'running',
    budgetActual: null,
    outcomeSummary: null,
    outcomeRefs: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    ...over,
  };
}

function doneResult(over: Partial<InitiativeRunResult> = {}): InitiativeRunResult {
  return {
    status: 'done',
    outcomeSummary: 'pandoc missing',
    skillRevision: {
      actionTemplate: 'check pandoc exists, then convert',
      diagnosis: 'pandoc binary absent',
    },
    llmTokensSpent: 100,
    toolCallsSpent: 0,
    ...over,
  };
}

/** A demoted callable recipe — exactly what recordLinkedSkillOutcomes leaves behind. */
function seedDemotedRecipe(skills: SkillStore, name = 'docx-recipe') {
  skills.createSkill({
    name,
    description: 'convert to docx',
    triggerKeywords: ['docx'],
    actionTemplate: 'run pandoc then readFile',
    verification: { kind: 'tool_result_ok', check: 'readFile' },
    toolPolicy: ['shell', 'readFile'],
    maturity: 'playbook',
  });
}

// ── applySkillRevision ───────────────────────────────────────────────────

test('applySkillRevision: 正常路径 — 改写内容 + 存旧版本 + 回落 draft', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);

  const r = applySkillRevision(h.skills, repairInit(), doneResult());
  assert.deepEqual(r, { applied: true, reason: 'applied' });

  const after = h.skills.getByName('docx-recipe')!;
  assert.equal(after.actionTemplate, 'check pandoc exists, then convert');
  assert.equal(after.maturity, 'draft', '改写后必须重新赚信任,不能停在 playbook');
  assert.equal(after.revisionHistory.length, 1);
  assert.equal(after.revisionHistory[0].actionTemplate, 'run pandoc then readFile', '存的是旧版本');
  // reason 必须带 repair marker,否则 repairAttemptsExhausted 的上限形同虚设
  assert.ok(after.revisionHistory[0].reason.startsWith(REPAIR_REASON_PREFIX));
  assert.match(after.revisionHistory[0].reason, /init-repair-1/);
  assert.match(after.revisionHistory[0].reason, /pandoc binary absent/);
  h.close();
});

test('applySkillRevision: 带 verification 的改写会一起落库', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);

  applySkillRevision(h.skills, repairInit(), doneResult({
    skillRevision: {
      actionTemplate: 'new steps',
      verification: { kind: 'assert', check: 'output file exists' },
      diagnosis: 'wrong check',
    },
  }));

  const after = h.skills.getByName('docx-recipe')!;
  assert.deepEqual(after.verification, { kind: 'assert', check: 'output file exists' });
  // 旧 verification 也进了历史
  assert.deepEqual(after.revisionHistory[0].verification, { kind: 'tool_result_ok', check: 'readFile' });
  h.close();
});

test('applySkillRevision: 诊断不足(无 skillRevision)→ 不改,技能保持降级', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);

  const r = applySkillRevision(h.skills, repairInit(), doneResult({ skillRevision: undefined }));
  assert.deepEqual(r, { applied: false, reason: 'no_revision_proposed' });

  const after = h.skills.getByName('docx-recipe')!;
  assert.equal(after.actionTemplate, 'run pandoc then readFile', '未改写');
  assert.equal(after.maturity, 'playbook', '仍是降级态');
  assert.equal(after.revisionHistory.length, 0);
  h.close();
});

test('applySkillRevision: 非 skill_repair driver 的 initiative 一律不改技能', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);

  const r = applySkillRevision(
    h.skills,
    repairInit({ driver: 'gap', kind: 'skill_failing' }),
    doneResult(),
  );
  assert.deepEqual(r, { applied: false, reason: 'wrong_driver' });
  assert.equal(h.skills.getByName('docx-recipe')!.revisionHistory.length, 0);
  h.close();
});

test('applySkillRevision: status != done 不改', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);
  const r = applySkillRevision(h.skills, repairInit(), doneResult({ status: 'failed' }));
  assert.deepEqual(r, { applied: false, reason: 'not_done' });
  h.close();
});

test('applySkillRevision: targetRef 不是 skill 形状 → 不改', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);
  const r = applySkillRevision(h.skills, repairInit({ targetRef: 'fact:f1' }), doneResult());
  assert.deepEqual(r, { applied: false, reason: 'unparseable_target' });
  h.close();
});

test('applySkillRevision: 目标是 prose lesson(无 verification)→ 拒绝,不能借这条路改散文技能', () => {
  const h = openMemoryDb(':memory:');
  h.skills.createSkill({
    name: 'plain-lesson', description: 'a lesson', triggerKeywords: [], actionTemplate: 'do x',
  });
  const r = applySkillRevision(
    h.skills,
    repairInit({ targetRef: 'skill:plain-lesson' }),
    doneResult(),
  );
  assert.deepEqual(r, { applied: false, reason: 'skill_not_a_recipe' });
  assert.equal(h.skills.getByName('plain-lesson')!.actionTemplate, 'do x');
  h.close();
});

test('applySkillRevision: 技能已被删除 → 拒绝,不抛异常', () => {
  const h = openMemoryDb(':memory:');
  const r = applySkillRevision(h.skills, repairInit(), doneResult());
  assert.deepEqual(r, { applied: false, reason: 'skill_not_a_recipe' });
  h.close();
});

// ── 修复上限:三次后 driver 不再提案(与 repairAttemptsExhausted 闭环) ────

test('applySkillRevision: 连续三次修复后 revision_history 满足 repairAttemptsExhausted', async () => {
  const { repairAttemptsExhausted } = await import('../src/skill_repair.js');
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);

  for (let i = 0; i < 3; i++) {
    // 每次修复后技能回到 draft;模拟再次失败被降级回 playbook
    h.skills.setMaturity('docx-recipe', 'playbook');
    const r = applySkillRevision(
      h.skills,
      repairInit({ id: `init-${i}` }),
      doneResult({ skillRevision: { actionTemplate: `v${i + 2} steps`, diagnosis: `try ${i}` } }),
    );
    assert.equal(r.applied, true, `第 ${i + 1} 次修复应成功`);
  }

  const after = h.skills.getByName('docx-recipe')!;
  assert.equal(after.revisionHistory.length, 3);
  assert.equal(
    repairAttemptsExhausted(after.revisionHistory),
    true,
    '三次修复后必须触发上限,driver 不再提案 — 防止无限自我改写',
  );
  h.close();
});

// ── skillRevisionWriter (OutcomeHook 包装) ───────────────────────────────

test('skillRevisionWriter: 作为 OutcomeHook 调用会真正落库,且异常不外抛', () => {
  const h = openMemoryDb(':memory:');
  seedDemotedRecipe(h.skills);
  const logs: string[] = [];
  const hook = skillRevisionWriter(h.skills, {
    log: (m) => logs.push(`log:${m}`),
    warn: (m) => logs.push(`warn:${m}`),
  });

  hook(repairInit(), doneResult());
  assert.equal(h.skills.getByName('docx-recipe')!.actionTemplate, 'check pandoc exists, then convert');
  assert.ok(logs.some((l) => l.startsWith('log:') && /revised recipe/.test(l)));

  // 不存在的技能 → 只 warn,不抛
  assert.doesNotThrow(() => hook(repairInit({ targetRef: 'skill:ghost' }), doneResult()));
  h.close();
});
