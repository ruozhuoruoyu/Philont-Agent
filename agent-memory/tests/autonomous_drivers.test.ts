/**
 * GapDriver / CuriosityDriver propose() 单测。
 *
 * 测试是纯函数(driver 不写 DB,不调 LLM),用手工构造 MemorySnapshot 喂入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GapDriver,
  CuriosityDriver,
  DEFAULT_CURIOSITY_CONFIG,
  SkillRepairDriver,
  extractSpecificTokens,
  type MemorySnapshot,
} from '../src/index.js';
import type { Fact, Pursuit, Skill } from '../src/types.js';
import type { RoutingRule } from '../src/routing_rules.js';
import { REPAIR_REASON_PREFIX, type SkillRevision } from '../src/skill_repair.js';

const NOW = 1_750_000_000_000; // 固定时刻方便复现

function snap(partial: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    facts: [],
    routingRules: [],
    skills: [],
    activePursuits: [],
    recentTimelineTokens: [],
    recentDoneTargetRefs: new Set(),
    now: NOW,
    ...partial,
  };
}

function fact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'f1',
    namespace: 'project',
    key: 'foo',
    value: { text: 'bar' },
    confidence: 1.0,
    supersededBy: null,
    supersedes: null,
    createdAt: NOW - 60_000,
    occurredAt: null,
    validFrom: null,
    validUntil: null,
    lastAccessedAt: null,
    decayTauDays: null,
    forgottenAt: null,
    factKind: 'state',
    ...over,
  };
}

function rule(over: Partial<RoutingRule> = {}): RoutingRule {
  return {
    id: 1,
    taskSignature: 'pdf-to-word',
    triggerCondition: '',
    preferSkill: null,
    avoidSkills: [],
    carveout: 'x',
    evidence: 'y',
    confidence: 'provisional',
    successCount: 0,
    failureCount: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    contextKeywords: [],
    reflectionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: 's1',
    name: 'web-research',
    description: '',
    whenToUse: '',
    triggerKeywords: [],
    actionTemplate: '',
    useCount: 0, offeredCount: 0,
    lastUsedAt: null,
    createdAt: NOW - 86_400_000,
    successCount: 0,
    failureCount: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    maturity: 'draft',
    kind: 'positive',
    source: null,
    verification: null,
    toolPolicy: null,
    revisionHistory: [],
    ...over,
  };
}

function pursuit(over: Partial<Pursuit> = {}): Pursuit {
  return {
    id: 'p1',
    parentPursuitId: 'default',
    rootPursuitId: 'default',
    title: 'investigate something',
    intent: '',
    status: 'active',
    isEvergreen: false,
    stake: 'high',
    deadline: null,
    origin: 'system',
    openQuestions: [],
    resolutionCriteria: null,
    evidenceRefs: [],
    progressMarkers: [],
    lastProgressTurn: 0,
    values: null,
    redLines: null,
    driveBounds: null,
    pursuitGovernance: null,
    lastTouchedAt: NOW - 30 * 86_400_000,
    stakeWeight: 8,
    isActiveResearch: false,
    researchIterations: 0,
    createdAt: NOW - 60 * 86_400_000,
    updatedAt: NOW - 30 * 86_400_000,
    ...over,
  };
}

// ── extractSpecificTokens 复用旧测试场景 ─────────────────────────────────

test('extractSpecificTokens: arxiv / CVE / RFC / lib@version / URL', () => {
  assert.ok(extractSpecificTokens('arxiv 2507.21046').some((t) => /2507\.21046/.test(t)));
  assert.ok(extractSpecificTokens('CVE-2024-12345').some((t) => /CVE-2024/i.test(t)));
  assert.ok(extractSpecificTokens('RFC 9234').some((t) => /9234/.test(t)));
  assert.ok(extractSpecificTokens('react@18.3').some((t) => /react@18/.test(t)));
  assert.ok(extractSpecificTokens('https://x.com/foo').length > 0);
});

test('extractSpecificTokens: 普通对话 → 空', () => {
  assert.deepEqual(extractSpecificTokens('你好,今天天气怎么样?'), []);
});

test('extractSpecificTokens: 引号包裹的纯中文短语 → 滤掉(无结构化信号)', () => {
  // 防 CuriosityDriver 把"工具调用" / "上下文" 等元概念词当 specific token
  assert.deepEqual(extractSpecificTokens('模型在做"工具调用"时'), []);
  assert.deepEqual(extractSpecificTokens('上下文"指代"问题'), []);
  assert.deepEqual(extractSpecificTokens('「记忆」是关键'), []);
  assert.deepEqual(extractSpecificTokens('"智能体"概念在演进'), []);
});

test('extractSpecificTokens: 引号包裹含英文/数字 → 保留', () => {
  // 真正的具体名词应该过
  assert.ok(extractSpecificTokens('叫做"Hermes-2"的模型').some((t) => /Hermes-2/.test(t)));
  assert.ok(extractSpecificTokens('"GPT-4" 表现').some((t) => /GPT-4/.test(t)));
  assert.ok(extractSpecificTokens('「v1.2.3」版本').some((t) => /v1\.2\.3/.test(t)));
});

test('extractSpecificTokens: 书名号《》→ 即使纯中文也保留(书名/作品名)', () => {
  assert.ok(extractSpecificTokens('《动手学深度学习》一书').some((t) => /动手学深度学习/.test(t)));
  assert.ok(extractSpecificTokens('参考《人月神话》').some((t) => /人月神话/.test(t)));
});

// ── GapDriver ───────────────────────────────────────────────────────────

test('GapDriver: 低 confidence fact 命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.2, value: { x: 1, sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'fact_gap');
  assert.equal(ps[0].targetRef, 'fact:f1');
  assert.ok(ps[0].utility >= 0.7);
});

test('GapDriver: sourceRefs 空命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.9, value: { x: 1 } })], // 无 sourceRefs
  }));
  assert.equal(ps.length, 1);
  assert.match(ps[0].rationale, /no sourceRefs/);
});

test('GapDriver: 高 confidence + 有 sourceRefs → 不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.9, value: { x: 1, sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: self.* / system.* 不在范围', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [
      fact({ namespace: 'self', confidence: 0.1 }),
      fact({ namespace: 'system', confidence: 0.1 }),
    ],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: 老 fact(超出 recent 窗口)不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ confidence: 0.1, createdAt: NOW - 30 * 86_400_000 })], // 30 天前
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: routing dispute + ≥2 连败命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    routingRules: [rule({ confidence: 'disputed', consecutiveFailures: 3 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'routing_dispute');
  assert.equal(ps[0].targetRef, 'routing:1');
});

test('GapDriver: routing dispute 但连败 < 阈值 → 不命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    routingRules: [rule({ confidence: 'disputed', consecutiveFailures: 1 })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: draft skill + ≥2 连败命中', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    skills: [skill({ maturity: 'draft', consecutiveFailures: 2 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'skill_failing');
  assert.equal(ps[0].targetRef, 'skill:web-research');
});

test('GapDriver: stable skill 不在范围', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    skills: [skill({ maturity: 'stable', consecutiveFailures: 5 })],
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: 24h 已 done 的 targetRef 跳过', () => {
  const d = new GapDriver();
  const ps = d.propose(snap({
    facts: [fact({ id: 'f1', confidence: 0.1 })],
    recentDoneTargetRefs: new Set(['fact:f1']),
  }));
  assert.equal(ps.length, 0);
});

test('GapDriver: maxProposals 截断', () => {
  const d = new GapDriver({
    factConfidenceThreshold: 0.3,
    factRecentDays: 7,
    routingMinConsecutiveFailures: 2,
    skillMinConsecutiveFailures: 2,
    maxProposals: 2,
  });
  const facts = Array.from({ length: 5 }, (_, i) =>
    fact({ id: `f${i}`, confidence: 0.1 - i * 0.01 }),
  );
  const ps = d.propose(snap({ facts }));
  assert.equal(ps.length, 2);
});

// ── CuriosityDriver ─────────────────────────────────────────────────────

test('CuriosityDriver: token 未被任何 fact 引用 → 命中', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ key: 'something-else', value: { sourceRefs: ['url'] } })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'curiosity_token');
  assert.equal(ps[0].targetRef, 'token:CVE-2026-0001');
});

test('CuriosityDriver: isSystemStuck=true → token-curiosity 被抑制(doom-loop 不喂死话题)', () => {
  const d = new CuriosityDriver({
    minTokenMentions: 1,
    pursuitAgingDays: 14,
    pursuitMinStakeWeight: 7,
    maxProposals: 3,
    isSystemStuck: () => true,
  });
  const ps = d.propose(snap({
    recentTimelineTokens: ['素数 R 是否对所有 p 有效', 'CVE-2026-0001'],
    facts: [],
  }));
  assert.equal(ps.filter((p) => p.kind === 'curiosity_token').length, 0);
});

test('CuriosityDriver: isSystemStuck=false → 正常提议(回归)', () => {
  const d = new CuriosityDriver({
    minTokenMentions: 1,
    pursuitAgingDays: 14,
    pursuitMinStakeWeight: 7,
    maxProposals: 3,
    isSystemStuck: () => false,
  });
  const ps = d.propose(snap({ recentTimelineTokens: ['CVE-2026-0001'], facts: [] }));
  assert.equal(ps.filter((p) => p.kind === 'curiosity_token').length, 1);
});

test('CuriosityDriver: token 在某 fact.sourceRefs 字符串里 → 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ value: { sourceRefs: ['https://x.com/CVE-2026-0001'] } })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: token 在某 fact.key 命中 → 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    facts: [fact({ key: 'CVE-2026-0001', value: {} })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 已 done targetRef 跳过', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001'],
    recentDoneTargetRefs: new Set(['token:CVE-2026-0001']),
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: dormant high-stake pursuit → promote to goal-loop (S4, default)', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, lastTouchedAt: NOW - 30 * 86_400_000 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'promote_goal_loop');
  assert.equal(ps[0].targetRef, 'goal-loop:pursuit:p1');
  assert.equal(ps[0].plan?.[0].tool, 'deep_explore', 'promotion starts a deep_explore goal-loop');
});

test('CuriosityDriver: promoteToGoalLoop=false → legacy one-shot dormant lookup', () => {
  const d = new CuriosityDriver({ ...DEFAULT_CURIOSITY_CONFIG, promoteToGoalLoop: false });
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, lastTouchedAt: NOW - 30 * 86_400_000 })],
  }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'curiosity_dormant_pursuit');
  assert.equal(ps[0].targetRef, 'pursuit:p1');
});

test('CuriosityDriver: low stake pursuit 不命中', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 5 })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: pursuit 有 evidenceRefs → 不算"许愿没碰"', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, evidenceRefs: ['some-ref'] })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 最近触碰过的 pursuit 不算 dormant', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    activePursuits: [pursuit({ stakeWeight: 8, lastTouchedAt: NOW - 1 * 86_400_000 })],
  }));
  assert.equal(ps.length, 0);
});

test('CuriosityDriver: 学术 ID utility > 普通 token utility', () => {
  const d = new CuriosityDriver();
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-2026-0001', 'RANDOMACRO'],
  }));
  // utility 排序后 CVE 在前
  assert.equal(ps[0].targetRef, 'token:CVE-2026-0001');
  assert.ok(ps[0].utility > ps[1].utility);
});

test('CuriosityDriver: maxProposals 截断', () => {
  const d = new CuriosityDriver({
    minTokenMentions: 1,
    pursuitAgingDays: 14,
    pursuitMinStakeWeight: 7,
    maxProposals: 2,
  });
  const ps = d.propose(snap({
    recentTimelineTokens: ['CVE-1', 'CVE-2', 'CVE-3', 'CVE-4'],
  }));
  assert.equal(ps.length, 2);
});

// ── SkillRepairDriver (H3, skill_self_repair.md) ─────────────────────────

function demotedRecipeSkill(over: Partial<Skill> = {}): Skill {
  return skill({
    maturity: 'playbook',
    verification: { kind: 'tool_result_ok', check: 'readFile' },
    toolPolicy: ['shell', 'readFile'],
    actionTemplate: 'call shell then readFile',
    failureCount: 2,
    ...over,
  });
}

test('SkillRepairDriver: demoted recipe (playbook + verification) 命中', () => {
  const d = new SkillRepairDriver();
  const ps = d.propose(snap({ skills: [demotedRecipeSkill()] }));
  assert.equal(ps.length, 1);
  assert.equal(ps[0].kind, 'skill_repair');
  assert.equal(ps[0].targetRef, 'skill:web-research');
});

test('SkillRepairDriver: 不发 plan — 证据在本地账本,executor 直接读,不需要工具调用', () => {
  const d = new SkillRepairDriver();
  const ps = d.propose(snap({ skills: [demotedRecipeSkill()] }));
  // A plan referencing a tool outside DEFAULT_TOOL_WHITELIST (e.g. deep_explore) would be rejected
  // by StandardExecutor before the LLM ever runs — and a repair needs no lookup anyway.
  assert.equal(ps[0].plan, undefined);
});

test('SkillRepairDriver: demoted prose lesson(无 verification)不命中 — 那是 GapDriver skill_failing 的范围', () => {
  const d = new SkillRepairDriver();
  const ps = d.propose(snap({
    skills: [skill({ maturity: 'playbook', verification: null })],
  }));
  assert.equal(ps.length, 0);
});

test('SkillRepairDriver: 未被降级的 recipe(draft/confirmed/stable)不命中', () => {
  const d = new SkillRepairDriver();
  for (const maturity of ['draft', 'confirmed', 'stable'] as const) {
    const ps = d.propose(snap({
      skills: [demotedRecipeSkill({ maturity })],
    }));
    assert.equal(ps.length, 0, `maturity=${maturity} 不该命中`);
  }
});

test('SkillRepairDriver: 修复次数达上限(MAX_REPAIR_ATTEMPTS)后不再提案 — 防抖', () => {
  const d = new SkillRepairDriver();
  const revisionHistory: SkillRevision[] = Array.from({ length: 3 }, (_, i) => ({
    at: NOW - i, actionTemplate: 'x', verification: null, toolPolicy: null,
    reason: `${REPAIR_REASON_PREFIX}sess-${i}`,
  }));
  const ps = d.propose(snap({
    skills: [demotedRecipeSkill({ revisionHistory })],
  }));
  assert.equal(ps.length, 0);
});

test('SkillRepairDriver: 非修复来源的 revision 不计入上限', () => {
  const d = new SkillRepairDriver();
  const revisionHistory: SkillRevision[] = Array.from({ length: 3 }, () => ({
    at: NOW, actionTemplate: 'x', verification: null, toolPolicy: null, reason: 'manual edit',
  }));
  const ps = d.propose(snap({
    skills: [demotedRecipeSkill({ revisionHistory })],
  }));
  assert.equal(ps.length, 1);
});

test('SkillRepairDriver: 24h 已 done 的 targetRef 跳过', () => {
  const d = new SkillRepairDriver();
  const ps = d.propose(snap({
    skills: [demotedRecipeSkill()],
    recentDoneTargetRefs: new Set(['skill:web-research']),
  }));
  assert.equal(ps.length, 0);
});

test('SkillRepairDriver: maxProposals 截断,按 utility 排序', () => {
  const d = new SkillRepairDriver({ maxProposals: 2 });
  const skills = Array.from({ length: 5 }, (_, i) =>
    demotedRecipeSkill({ name: `recipe-${i}` }),
  );
  const ps = d.propose(snap({ skills }));
  assert.equal(ps.length, 2);
});

// ── The 2026-07-23 night, as a regression ────────────────────────────────────
//
// Seven idle hours produced 45 research targets and ~48k tokens: POST, CST, UTC, ZERO, HIGH, USERS,
// "body", "...", "great point", "post_id". Every one became a real webSearch. Zero came from the
// ID/URL rules; all 45 came from the acronym rule and from a quoted rule whose "structural signal" test
// was satisfied by any ASCII character. The fix is not a longer blacklist — the acronym rule is gone
// (nothing distinguishes "DSML" from "USERS" by shape), and the quoted rule is narrowed to the shape of
// a product/model/version name, which is the case it was actually written for.

test('extractSpecificTokens: 那一夜的 45 个垃圾 token 一个都不再产生', () => {
  const lines = [
    'I will POST to the endpoint and set "community_id" and "parent_id" in the body',
    'Times are shown in CST, the server uses UTC',
    'The response had "great point" as the comment text',
    'Fields: "post_id", "body", "..." and handle',
    'Endpoints: USERS, COMMUNITIES, AGENTS',
    'Part 0: read SOUL.md and handle the flow',
    'severity was HIGH and the result was ZERO',
    'wrote "2篇原创帖" and "~50次投票" and "11+次心跳"',
    'the id format is "<8-char-hex>" or "<hex>"',
    'note said "CONFIRMED: p=571 has NO solution!"',
    'topics: "Empirical Convergence of Failure", "Computational Surrogates"',
  ];
  for (const l of lines) assert.deepEqual(extractSpecificTokens(l), [], l);
});

test('extractSpecificTokens: 凭证形状的 token 永不外流(它会变成 webSearch query)', () => {
  // The driver's plan for a token is webSearch({query: token}); a key reaching that is not recoverable.
  assert.deepEqual(extractSpecificTokens('the key is "mycox-api-key" for now'), []);
  assert.deepEqual(extractSpecificTokens('community 7362d16f-cd31-4eab-a02e-1891fa888c66 was used'), []);
  assert.deepEqual(extractSpecificTokens('token "sk-ant-api03-abcdefghijklmnop12345"'), []);
});

// ── compass focus vs incidental pursuit: two clocks ─────────────────────────
//
// Production 2026-07-23: the owner's single declared focus (stake 8) was seeded 07-16 and therefore
// ineligible until 07-30 under the 14-day dormancy gate, so for a fortnight the background loop had
// nothing owner-directed to do and spent every night on token curiosity. The gate was doing double duty —
// anti-startup-storm AND staleness filter — and one number could not serve both.

function compassPursuit(over: Record<string, unknown> = {}) {
  return {
    id: 'compass-philont-itself-abc12345',
    title: 'philont itself',
    stakeWeight: 8,
    origin: 'compass',
    evidenceRefs: [],
    lastTouchedAt: Date.now() - 2 * 86_400_000,
    updatedAt: Date.now() - 2 * 86_400_000,
    ...over,
  } as never;
}

function proposeWith(pursuits: unknown[], now = Date.now()) {
  const d = new CuriosityDriver({ ...DEFAULT_CURIOSITY_CONFIG, promoteToGoalLoop: false });
  return d.propose({
    facts: [], routingRules: [], skills: [],
    activePursuits: pursuits as never,
    recentTimelineTokens: [], recentDoneTargetRefs: new Set<string>(), now,
  } as never);
}

test('compass 焦点闲置一天就被后台捡起(不必等 14 天)', () => {
  const props = proposeWith([compassPursuit()]);
  assert.ok(props.some((p) => p.targetRef.includes('compass-philont-itself')), '主人声明的焦点必须进入夜间回路');
});

test('刚播种的 compass 焦点当天不触发 —— 防启动风暴的性质保留', () => {
  const props = proposeWith([compassPursuit({ lastTouchedAt: Date.now() - 3600_000, updatedAt: Date.now() - 3600_000 })]);
  assert.deepEqual(props, [], '声明五个焦点不该在启动瞬间点燃五个会话');
});

test('已有产出的 compass 焦点仍会被推进 —— 持续关注正是它的承诺', () => {
  const props = proposeWith([compassPursuit({ evidenceRefs: ['note:1', 'note:2'] })]);
  assert.ok(props.length > 0, '「做过一次就再也不碰」正是 compass 要防的');
});

test('普通 pursuit 的判据不变:14 天 + 无产出', () => {
  const incidental = compassPursuit({ id: 'p-incidental', origin: 'reflector', title: 'something I noticed' });
  assert.deepEqual(proposeWith([incidental]), [], '闲置 2 天的顺带 pursuit 不该被当成紧急');

  const stale = compassPursuit({
    id: 'p-stale', origin: 'reflector', title: 'old',
    lastTouchedAt: Date.now() - 20 * 86_400_000, updatedAt: Date.now() - 20 * 86_400_000,
  });
  assert.ok(proposeWith([stale]).length > 0, '真正陈旧的仍然会被捡起');

  const staleWithOutput = compassPursuit({
    id: 'p-out', origin: 'reflector', title: 'old with output', evidenceRefs: ['note:1'],
    lastTouchedAt: Date.now() - 20 * 86_400_000, updatedAt: Date.now() - 20 * 86_400_000,
  });
  assert.deepEqual(proposeWith([staleWithOutput]), [], '有产出的顺带 pursuit 判据保持不变');
});

test('extractSpecificTokens: 《》里的自造小节标题不再成为研究目标', () => {
  // 生产 2026-07-23:agent 在自己的回复里用《》标小节,于是去"研究"自己刚写的标题。
  assert.deepEqual(extractSpecificTokens('本轮产出了《Barrier Survey》与《ES Quadratic Obstruction》两节'), []);
  // 真正的作品名仍然保留 —— 中文作品,以及以单词命名的外文刊物。
  assert.ok(extractSpecificTokens('参考《人月神话》').includes('人月神话'));
  assert.ok(extractSpecificTokens('发表在《Nature》上').includes('Nature'));
});
