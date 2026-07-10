/**
 * H3 端到端:一次真实 tick 从 driver → executor → OutcomeHook 走通,配方真的被改写。
 *
 * 前面三个文件分别单测了 driver.propose / executor / applySkillRevision,但没有任何一条测试
 * 证明"三段真的接得上"——这正是最容易断的地方(比如 driver 发了个白名单外的 plan,或
 * OutcomeHook 没被 loop 调到)。这里用真 DB + 真 loop + 假 LLM 把管道跑通。
 *
 * 假 LLM 是刻意的:本文件验证"管道通不通",不验证"真模型诊断得准不准"——后者需要真 key,
 * 见 scripts/skill-repair-dogfood.ts。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  startAutonomousLoop,
  StandardExecutor,
  SkillRepairDriver,
  skillRevisionWriter,
  isRepairCandidate,
  type ExtractorLlmClient,
  type SkillRepairContext,
  type ToolRunner,
} from '../src/index.js';

function noTools(): ToolRunner {
  return {
    async run(name) {
      throw new Error(`a skill_repair initiative must call no tools, but called: ${name}`);
    },
  };
}

const DIAGNOSIS_OUT = JSON.stringify({
  summary: 'pandoc is not installed on this host',
  facts: [],
  notes: [],
  shouldEscalate: false,
  skillRevision: {
    actionTemplate: 'shell `command -v pandoc` first; if absent, report. Then convert + readFile.',
    diagnosis: 'pandoc binary absent',
  },
});

/** Wire the same three pieces the server wires, against an in-memory DB. */
function harness(llmOut: string) {
  const h = openMemoryDb(':memory:');

  // A callable recipe, demoted to playbook exactly as recordLinkedSkillOutcomes would leave it
  h.skills.createSkill({
    name: 'docx-recipe',
    description: 'convert md to docx',
    triggerKeywords: ['docx'],
    actionTemplate: 'run `pandoc in.md -o out.docx` then readFile out.docx',
    verification: { kind: 'tool_result_ok', check: 'readFile' },
    toolPolicy: ['shell', 'readFile'],
    maturity: 'playbook',
  });
  // ...and its real failed runs in the execution ledger (what the diagnosis reads)
  for (let i = 0; i < 2; i++) {
    h.actions.log({
      sessionId: 's1',
      toolName: 'shell',
      params: { cmd: 'pandoc in.md -o out.docx' },
      result: 'bash: pandoc: command not found',
      success: false,
      linkedSkill: 'docx-recipe',
    });
  }

  const llm: ExtractorLlmClient = { async complete() { return { text: llmOut, tokensUsed: 300 }; } };

  // Mirrors server/src/chat-handler.ts's skillRepairContext wiring
  const skillRepairContext = (skillName: string): SkillRepairContext | null => {
    const s = h.skills.getByName(skillName);
    if (!s || !isRepairCandidate(s) || !s.verification) return null;
    return {
      actionTemplate: s.actionTemplate,
      verification: s.verification,
      toolPolicy: s.toolPolicy,
      failures: h.actions
        .getBySkill(skillName, { onlyFailed: true, limit: 5 })
        .map((a) => ({ toolName: a.toolName, result: a.result, timestamp: a.timestamp })),
    };
  };

  const loop = startAutonomousLoop({
    db: h.db,
    facts: h.facts,
    notes: h.notes,
    raw: h.raw,
    skills: h.skills,
    routingRules: h.routingRules,
    pursuits: h.pursuits,
    drivers: [new SkillRepairDriver()],
    executor: new StandardExecutor({
      facts: h.facts,
      notes: h.notes,
      llm,
      tools: noTools(),
      skillRepairContext,
    }),
    onOutcome: skillRevisionWriter(h.skills, { log: () => {}, warn: () => {} }),
    enabled: true,
  });

  return { h, loop };
}

test('e2e: 一次 tick 走完 driver→executor→writer,坏配方被真的改写并回落 draft', async () => {
  const { h, loop } = harness(DIAGNOSIS_OUT);

  const ev = await loop.tickOnce();
  assert.equal(ev.proposalsCollected, 1, 'driver 应提出这一个坏配方');
  assert.equal(ev.initiativesRun, 1, 'initiative 应跑完并 done');
  assert.equal(ev.failed, 0);
  assert.equal(ev.toolCallsSpent, 0, '修复不该调任何工具(证据在本地账本)');

  const after = h.skills.getByName('docx-recipe')!;
  assert.match(after.actionTemplate, /command -v pandoc/, '配方内容真的被改写了');
  assert.equal(after.maturity, 'draft', '改写后回落 draft,重新赚信任');
  assert.equal(after.revisionHistory.length, 1);
  assert.match(after.revisionHistory[0].actionTemplate, /pandoc in\.md/, '旧版本被存进历史');
  assert.match(after.revisionHistory[0].reason, /^skill_repair:/, '带 marker,计入修复上限');
  assert.match(after.revisionHistory[0].reason, /pandoc binary absent/);

  await loop.stop();
  h.close();
});

test('e2e: 改好后的配方不再是修复候选,下一 tick 不再提案(不会无限自我改写)', async () => {
  const { h, loop } = harness(DIAGNOSIS_OUT);

  const t0 = Date.now();
  await loop.tickOnce(t0);
  assert.equal(h.skills.getByName('docx-recipe')!.maturity, 'draft');

  // 关键:必须跨过 24h 去重窗再 tick,否则 proposalsCollected=0 只是因为 recentDoneTargetRefs
  // 命中,而不是因为 maturity 变了 —— 那样这条测试会以错误的理由通过。
  const ev2 = await loop.tickOnce(t0 + 25 * 60 * 60_000);
  assert.equal(ev2.proposalsCollected, 0, '已修复(draft)的配方不该再被提案');
  assert.equal(h.skills.getByName('docx-recipe')!.revisionHistory.length, 1, '没有第二次改写');

  // 反证:同样跨过去重窗,但把它打回 playbook → 立刻重新成为候选。
  // 这证明上面的 0 确实来自 maturity,不是来自去重。
  h.skills.setMaturity('docx-recipe', 'playbook');
  const ev3 = await loop.tickOnce(t0 + 26 * 60 * 60_000);
  assert.equal(ev3.proposalsCollected, 1, '重新降级后必须重新被提案');

  await loop.stop();
  h.close();
});

test('e2e: LLM 诊断不出来(无 skillRevision)→ initiative 仍 done,但配方原封不动', async () => {
  const { h, loop } = harness(JSON.stringify({
    summary: 'the trajectories do not explain the failure',
    facts: [], notes: [], shouldEscalate: false,
  }));

  const ev = await loop.tickOnce();
  assert.equal(ev.initiativesRun, 1, '诊断不足不是失败');
  assert.equal(ev.failed, 0);

  const after = h.skills.getByName('docx-recipe')!;
  assert.match(after.actionTemplate, /pandoc in\.md/, '未被瞎改');
  assert.equal(after.maturity, 'playbook', '仍是降级态');
  assert.equal(after.revisionHistory.length, 0);

  await loop.stop();
  h.close();
});

test('e2e: 修复到上限后 driver 停止提案(防抖真的生效在 loop 里)', async () => {
  const { h, loop } = harness(DIAGNOSIS_OUT);

  // 跑三轮:每轮先把配方打回 playbook(模拟改完又坏),tick 一次修复
  for (let i = 0; i < 3; i++) {
    h.skills.setMaturity('docx-recipe', 'playbook');
    const ev = await loop.tickOnce(Date.now() + i * 25 * 60 * 60_000); // 越过 24h 去重窗
    assert.equal(ev.initiativesRun, 1, `第 ${i + 1} 轮修复应执行`);
  }
  assert.equal(h.skills.getByName('docx-recipe')!.revisionHistory.length, 3);

  // 第四轮:仍是 playbook,但修复次数已达上限 → driver 不再提案
  h.skills.setMaturity('docx-recipe', 'playbook');
  const ev4 = await loop.tickOnce(Date.now() + 4 * 25 * 60 * 60_000);
  assert.equal(ev4.proposalsCollected, 0, '达上限后必须停手,交给人看');
  assert.equal(h.skills.getByName('docx-recipe')!.revisionHistory.length, 3);

  await loop.stop();
  h.close();
});

test('e2e: 未注册 SkillRepairDriver 时,坏配方原封不动(默认关的实质保证)', async () => {
  const h = openMemoryDb(':memory:');
  h.skills.createSkill({
    name: 'docx-recipe', description: 'x', triggerKeywords: [], actionTemplate: 'old steps',
    verification: { kind: 'tool_result_ok', check: 'readFile' },
    toolPolicy: ['shell'], maturity: 'playbook',
  });

  const loop = startAutonomousLoop({
    db: h.db, facts: h.facts, notes: h.notes, raw: h.raw, skills: h.skills,
    routingRules: h.routingRules, pursuits: h.pursuits,
    drivers: [], // ← 默认配置下 skill_repair 不在其中
    executor: new StandardExecutor({
      facts: h.facts, notes: h.notes,
      llm: { async complete() { throw new Error('LLM must not be called'); } },
      tools: noTools(),
    }),
    onOutcome: skillRevisionWriter(h.skills, { log: () => {}, warn: () => {} }),
    enabled: true,
  });

  const ev = await loop.tickOnce();
  assert.equal(ev.proposalsCollected, 0);
  assert.equal(h.skills.getByName('docx-recipe')!.actionTemplate, 'old steps');
  assert.equal(h.skills.getByName('docx-recipe')!.revisionHistory.length, 0);

  await loop.stop();
  h.close();
});
