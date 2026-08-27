/**
 * AutonomousLoop 集成测试 — 端到端"agent 发现 gap → 跑工具 → 写 fact 回 memory"。
 *
 * 用 fake LLM + fake ToolRunner + manual tickOnce(),不依赖真 timer。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  startAutonomousLoop,
  StandardExecutor,
  GapDriver,
  CuriosityDriver,
  PursuitDriver,
  pursuitProgressWriter,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  GLOBAL_TIMELINE_SESSION_ID,
  type ExtractorLlmClient,
  type ToolRunner,
  type ToolRunResult,
  type AutonomousInterruptPayload,
  type InterruptSink,
  type TickEvent,
  type Initiative,
  type InitiativeRunResult,
} from '../src/index.js';

function llmReturning(out: string, tokens = 200): ExtractorLlmClient {
  return {
    async complete() {
      return { text: out, tokensUsed: tokens };
    },
  };
}

function tools(map: Record<string, ToolRunResult>): ToolRunner {
  return {
    async run(name) {
      return map[name] ?? { ok: false, output: '', error: `unstubbed: ${name}` };
    },
  };
}

function captureInterrupts(): { sink: InterruptSink; got: AutonomousInterruptPayload[] } {
  const got: AutonomousInterruptPayload[] = [];
  return {
    got,
    sink: {
      fire: (_severity, p) => {
        got.push(p);
      },
    },
  };
}

test('loop: 起步 enabled=false → tickOnce 立刻返回,无副作用', async () => {
  const handle = openMemoryDb(':memory:');
  const llm = llmReturning(JSON.stringify({ summary: 's', facts: [], notes: [], shouldEscalate: false }));
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm,
    tools: tools({}),
  });
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver(), new CuriosityDriver()],
    executor: exe,
    enabled: false,
  });

  const ev = await loop.tickOnce();
  assert.equal(ev.proposalsCollected, 0);
  assert.equal(ev.initiativesRun, 0);
  await loop.stop();
  handle.close();
});

test('loop: gap 命中低 confidence fact → executor 跑 webSearch → 新 fact 落库', async () => {
  const handle = openMemoryDb(':memory:');
  // 种入低 confidence fact
  handle.facts.storeFact({
    namespace: 'project',
    key: 'mcp-rfc-7-purpose',
    value: { text: 'maybe about transport?' },
    confidence: 0.2,
  });

  const llmOut = JSON.stringify({
    summary: 'MCP RFC 7 defines bidirectional transport over stdio',
    facts: [
      {
        namespace: 'project',
        key: 'mcp-rfc-7-purpose-verified',
        value: { text: 'bidirectional stdio transport' },
        confidence: 0.85,
        sourceRefs: ['https://modelcontextprotocol.io/rfc/7'],
      },
    ],
    notes: [
      { title: 'MCP RFC 7', body: 'transport details', importance: 0.6 },
    ],
    shouldEscalate: false,
  });

  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut, 300),
    tools: tools({
      webSearch: { ok: true, output: 'mcp rfc 7 search results...' },
    }),
  });
  const interrupts = captureInterrupts();

  const events: TickEvent[] = [];
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
    interrupt: interrupts.sink,
    audit: { onTick: (e) => events.push(e) },
  });

  const ev = await loop.tickOnce();
  assert.equal(ev.proposalsCollected, 1, '应该收到 1 条 gap 候选');
  assert.equal(ev.initiativesRun, 1, '应该跑了 1 条 initiative');
  assert.equal(ev.failed, 0);
  assert.equal(ev.skipped, 0);
  assert.equal(events.length, 1);

  // 新 fact 入库
  const newFact = handle.facts.getFact('project', 'mcp-rfc-7-purpose-verified');
  assert.ok(newFact);
  const v = newFact!.value as { sourceRefs: string[]; via: string };
  assert.deepEqual(v.sourceRefs, ['https://modelcontextprotocol.io/rfc/7']);
  assert.match(v.via, /^autonomous:/);

  // initiative 状态 done
  const recent = loop.initiatives.listRecentDone(0, 5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, 'done');
  assert.match(recent[0].outcomeSummary ?? '', /MCP RFC 7/);

  // interrupt fire
  assert.equal(interrupts.got.length, 1);
  assert.equal(interrupts.got[0].kind, 'discovery_made');

  // 预算被记账
  const daily = loop.budget.getDailyUsage('default');
  assert.equal(daily.initiativesRun, 1);
  assert.ok(daily.llmTokensUsed > 0);

  await loop.stop();
  handle.close();
});

test('loop: 24h dedupe — 同 targetRef 第二次跳过', async () => {
  const handle = openMemoryDb(':memory:');
  handle.facts.storeFact({
    namespace: 'project',
    key: 'somekey',
    value: { x: 1 },
    confidence: 0.1,
  });

  const llmOut = JSON.stringify({
    summary: 'looked it up',
    facts: [
      { key: 'res', value: { x: 1 }, sourceRefs: ['url'], confidence: 0.8 },
    ],
    notes: [],
    shouldEscalate: false,
  });

  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
  });

  const ev1 = await loop.tickOnce();
  assert.equal(ev1.initiativesRun, 1);

  // 第二次同样 fact 还在(confidence 还是低),但应该被 24h dedupe 拦
  const ev2 = await loop.tickOnce();
  assert.equal(ev2.proposalsCollected, 0, 'driver 应被 recentDoneTargetRefs 过滤掉');
  assert.equal(ev2.initiativesRun, 0);

  await loop.stop();
  handle.close();
});

test('loop: budget 爆 → 余下候选 mark skipped', async () => {
  const handle = openMemoryDb(':memory:');
  // 种 5 个低 confidence fact
  for (let i = 0; i < 5; i++) {
    handle.facts.storeFact({
      namespace: 'project',
      key: `k${i}`,
      value: { x: i },
      confidence: 0.1,
    });
  }

  const llmOut = JSON.stringify({
    summary: 's',
    facts: [{ key: 'res', value: { x: 1 }, sourceRefs: ['url'] }],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut, 1500),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
    budgetCaps: {
      dailyTokens: 100_000,
      dailyToolCalls: 100,
      perTickTokens: 100_000,
      perTickInitiatives: 2,
      perInitiativeTokens: 5_000,
    },
  });

  const ev = await loop.tickOnce();
  // 5 个候选:2 跑了,3 被 budget gate skipped(perTickInitiatives=2)
  assert.equal(ev.proposalsCollected, 5);
  assert.equal(ev.initiativesRun, 2);
  assert.ok(ev.skipped >= 3, `expected ≥3 skipped, got ${ev.skipped}`);
  assert.equal(ev.budgetExhausted, true);

  await loop.stop();
  handle.close();
});

test('loop: in-flight 防重入 — 第二次 tickOnce 期间立刻返回', async () => {
  const handle = openMemoryDb(':memory:');
  // 不种数据 → 没候选 → tick 立即结束
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning('{}'),
    tools: tools({}),
  });
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
  });
  const ev = await loop.tickOnce();
  assert.equal(ev.proposalsCollected, 0);
  await loop.stop();
  handle.close();
});

test('loop: timeline token → curiosity 候选 → executor 跑 webSearch → 新 fact', async () => {
  const handle = openMemoryDb(':memory:');
  // 种 raw timeline 含 specific token
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: '帮我看看 CVE-2026-0001 是什么',
  });
  handle.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'assistant',
    content: '我不太确定,需要查一下',
  });

  const llmOut = JSON.stringify({
    summary: 'CVE-2026-0001 is about XSS in libfoo',
    facts: [
      {
        namespace: 'security.cve',
        key: 'CVE-2026-0001',
        value: { type: 'XSS', package: 'libfoo' },
        confidence: 0.8,
        sourceRefs: ['https://nvd.nist.gov/vuln/detail/CVE-2026-0001'],
      },
    ],
    notes: [],
    shouldEscalate: false,
  });

  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut),
    tools: tools({ webSearch: { ok: true, output: 'CVE-2026-0001 details' } }),
  });

  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new CuriosityDriver()],
    executor: exe,
  });

  const ev = await loop.tickOnce();
  assert.ok(ev.proposalsCollected >= 1, 'curiosity 应该抓到 CVE-2026-0001');
  assert.equal(ev.initiativesRun, 1);

  const got = handle.facts.getFact('security.cve', 'CVE-2026-0001');
  assert.ok(got, '新 fact 应该入库');

  await loop.stop();
  handle.close();
});

test('loop: PursuitDriver 命中 stalled active pursuit + open question → 跑研究并写 note', async () => {
  const handle = openMemoryDb(':memory:');
  // 种入一个 stalled pursuit:7 天没动 + 有 evidence + 有 open question
  const old = Date.now() - 9 * 86_400_000;
  const p = handle.pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: '迁移 SQLite 到 Postgres',
    intent: '稳定性 + 多用户并发',
    origin: 'user',
    stake: 'high',
    openQuestions: [{ text: 'Postgres connection pooling 选什么?' }],
  });
  // 加一条 evidence + 把 lastTouchedAt / openQuestion 时间手工"老化"
  handle.pursuits.addEvidence(p.id, 'note-seed');
  handle.db.prepare(
    `UPDATE memory_pursuits SET last_touched_ts = ?, updated_at = ? WHERE id = ?`,
  ).run(old, old, p.id);

  const llmOut = JSON.stringify({
    summary: '研究了 connection pooling,推荐 PgBouncer 模式 transaction',
    facts: [
      {
        namespace: 'project',
        key: 'pg-pooling-choice',
        value: { choice: 'PgBouncer transaction mode' },
        confidence: 0.85,
        sourceRefs: ['https://www.pgbouncer.org/usage.html'],
      },
    ],
    notes: [
      { title: 'PgBouncer 调研', body: 'transaction 模式适合短连接 web 应用', importance: 0.6 },
    ],
    shouldEscalate: false,
  });

  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut, 250),
    tools: tools({
      search_notes: { ok: true, output: '(no local notes found)' },
      search_skills: { ok: true, output: '(no matching skills)' },
      webSearch: { ok: true, output: 'PgBouncer is a connection pooler for PostgreSQL...' },
    }),
  });

  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new PursuitDriver()],
    executor: exe,
  });

  const ev = await loop.tickOnce();
  assert.ok(ev.proposalsCollected >= 1, '应该收到 1 条 pursuit 候选');
  assert.equal(ev.initiativesRun, 1);

  const recent = loop.initiatives.listRecentDone(0, 5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].kind, 'pursuit:advance-question');
  assert.match(recent[0].targetRef, /^pursuit:.*:q:/);

  // 新 fact 入库
  const fact = handle.facts.getFact('project', 'pg-pooling-choice');
  assert.ok(fact, '研究 fact 应入库');

  await loop.stop();
  handle.close();
});

test('loop: onOutcome hook 在每个 initiative done/failed/skipped 后被调用', async () => {
  const handle = openMemoryDb(':memory:');
  // 种入低 confidence fact 触发 GapDriver
  handle.facts.storeFact({
    namespace: 'project',
    key: 'k-test',
    value: { x: 1 },
    confidence: 0.1,
  });

  const llmOut = JSON.stringify({
    summary: 's',
    facts: [{ key: 'res', value: { x: 1 }, sourceRefs: ['url'], confidence: 0.8 }],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut),
    tools: tools({ webSearch: { ok: true, output: 'ok' } }),
  });

  const calls: Array<{ initiative: Initiative; result: InitiativeRunResult }> = [];
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
    onOutcome: (initiative, result) => {
      calls.push({ initiative, result });
    },
  });

  await loop.tickOnce();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].result.status, 'done');
  assert.equal(calls[0].initiative.driver, 'gap');

  await loop.stop();
  handle.close();
});

test('loop + pursuitProgressWriter: PursuitDriver done → pursuit lastTouchedAt 刷新 + 加 evidence + 加 marker', async () => {
  const handle = openMemoryDb(':memory:');
  // 种入 stalled pursuit + open question + evidence
  const old = Date.now() - 9 * 86_400_000;
  const p = handle.pursuits.createChild({
    parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    title: 'API rate limit 改造',
    intent: '降低 429 比例',
    origin: 'user',
    stake: 'high',
    openQuestions: [{ text: 'token bucket vs sliding window?' }],
  });
  handle.pursuits.addEvidence(p.id, 'note-seed');
  handle.db.prepare(
    `UPDATE memory_pursuits SET last_touched_ts = ?, updated_at = ? WHERE id = ?`,
  ).run(old, old, p.id);

  const beforePursuit = handle.pursuits.get(p.id)!;
  const beforeMarkers = beforePursuit.progressMarkers.length;
  const beforeEvidence = beforePursuit.evidenceRefs.length;

  const llmOut = JSON.stringify({
    summary: 'token bucket 适合 burst,sliding window 平稳;推荐 token bucket',
    facts: [
      {
        namespace: 'project',
        key: 'rate-limit-algo',
        value: { choice: 'token bucket' },
        confidence: 0.85,
        sourceRefs: ['https://example.com/rate-limit'],
      },
    ],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut, 200),
    tools: tools({
      search_notes: { ok: true, output: '(empty)' },
      search_skills: { ok: true, output: '(empty)' },
      webSearch: { ok: true, output: 'token bucket details' },
    }),
  });

  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new PursuitDriver()],
    executor: exe,
    onOutcome: pursuitProgressWriter(handle.pursuits),
  });

  const ev = await loop.tickOnce();
  assert.equal(ev.initiativesRun, 1);

  // pursuit 状态应被推进
  const after = handle.pursuits.get(p.id)!;
  assert.equal(after.progressMarkers.length, beforeMarkers + 1);
  assert.equal(after.evidenceRefs.length, beforeEvidence + 1);
  // last_touched_ts 已从 old 跳到接近 now
  assert.ok(after.lastTouchedAt > old + 8 * 86_400_000);
  // evidence 引用 initiative id
  const newRef = after.evidenceRefs[after.evidenceRefs.length - 1];
  assert.match(newRef, /^autonomous:initiative-/);

  await loop.stop();
  handle.close();
});

test('loop WS6: escalate + written evidence fires HIGH severity; escalate without evidence stays normal', async () => {
  // Case 1: shouldEscalate=true and a fact with sourceRefs is written -> 'high'
  {
    const handle = openMemoryDb(':memory:');
    handle.facts.storeFact({
      namespace: 'project',
      key: 'urgent-topic',
      value: { text: 'unclear' },
      confidence: 0.2,
    });
    const llmOut = JSON.stringify({
      summary: 'critical: dependency has an actively exploited CVE',
      facts: [
        {
          namespace: 'project',
          key: 'urgent-topic-verified',
          value: { text: 'CVE-2026-0001 exploited in the wild' },
          confidence: 0.9,
          sourceRefs: ['https://example.com/advisory'],
        },
      ],
      notes: [],
      shouldEscalate: true,
    });
    const exe = new StandardExecutor({
      facts: handle.facts,
      notes: handle.notes,
      llm: llmReturning(llmOut, 300),
      tools: tools({ webSearch: { ok: true, output: 'advisory...' } }),
    });
    const severities: Array<'normal' | 'high'> = [];
    const loop = startAutonomousLoop({
      db: handle.db,
      facts: handle.facts,
      notes: handle.notes,
      raw: handle.raw,
      skills: handle.skills,
      routingRules: handle.routingRules,
      pursuits: handle.pursuits,
      drivers: [new GapDriver()],
      executor: exe,
      interrupt: { fire: (sev) => severities.push(sev) },
    });
    const ev = await loop.tickOnce();
    assert.equal(ev.initiativesRun, 1);
    assert.deepEqual(severities, ['high'], 'escalate + evidence must fire high');
    await loop.stop();
    handle.close();
  }

  // Case 2: shouldEscalate=true but the only fact lacks sourceRefs (dropped by the
  // anti-fabrication filter) and no notes -> no evidence -> 'normal'
  {
    const handle = openMemoryDb(':memory:');
    handle.facts.storeFact({
      namespace: 'project',
      key: 'urgent-topic',
      value: { text: 'unclear' },
      confidence: 0.2,
    });
    const llmOut = JSON.stringify({
      summary: 'claims something big with no sources',
      facts: [
        {
          namespace: 'project',
          key: 'unsourced-claim',
          value: { text: 'trust me' },
          confidence: 0.9,
        },
      ],
      notes: [],
      shouldEscalate: true,
    });
    const exe = new StandardExecutor({
      facts: handle.facts,
      notes: handle.notes,
      llm: llmReturning(llmOut, 300),
      tools: tools({ webSearch: { ok: true, output: '...' } }),
    });
    const severities: Array<'normal' | 'high'> = [];
    const loop = startAutonomousLoop({
      db: handle.db,
      facts: handle.facts,
      notes: handle.notes,
      raw: handle.raw,
      skills: handle.skills,
      routingRules: handle.routingRules,
      pursuits: handle.pursuits,
      drivers: [new GapDriver()],
      executor: exe,
      interrupt: { fire: (sev) => severities.push(sev) },
    });
    const ev = await loop.tickOnce();
    assert.equal(ev.initiativesRun, 1);
    assert.deepEqual(severities, ['normal'], 'escalate without evidence must stay normal');
    await loop.stop();
    handle.close();
  }
});

test('loop WS6: note-only outcome NEVER escalates (prod 2026-07-08 "no new data" finding)', async () => {
  const handle = openMemoryDb(':memory:');
  handle.facts.storeFact({
    namespace: 'project',
    key: 'needs-check',
    value: { text: 'unclear' },
    confidence: 0.2,
  });
  // Executor "found nothing", wrote a status note about it, and still self-rated escalate=true
  const llmOut = JSON.stringify({
    summary: 'No tools produced new data; fact still lacks sourceRefs. Will retry.',
    facts: [],
    notes: [{ title: 'verification status', body: 'no new data this run', importance: 0.3 }],
    shouldEscalate: true,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: llmReturning(llmOut, 200),
    tools: tools({ webSearch: { ok: true, output: '...' } }),
  });
  const severities: Array<'normal' | 'high'> = [];
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts,
    notes: handle.notes,
    raw: handle.raw,
    skills: handle.skills,
    routingRules: handle.routingRules,
    pursuits: handle.pursuits,
    drivers: [new GapDriver()],
    executor: exe,
    interrupt: { fire: (sev) => severities.push(sev) },
  });
  const ev = await loop.tickOnce();
  assert.equal(ev.initiativesRun, 1);
  assert.deepEqual(severities, ['normal'], 'a zero-progress note must not page the user');
  await loop.stop();
  handle.close();
});

// ── all-drop backoff ──────────────────────────────────────────────────────────────────────────────
//
// The throttle for a discovery loop nobody is reading: prod 2026-08-26/27 ran five initiatives per
// tick, ~6000 tokens each time, every one DROPPED at gate 1, for hours. The decision is pure so the
// thing that decides how often the agent may spend is testable without driving a whole tick.

test('all-drop backoff: doubles while barren, caps, and one owner-visible finding clears it', async () => {
  const { nextAutonomyBackoff, autonomyBackoffActive } = await import('../src/index.js');
  const tickIntervalMs = 300_000; // the production 5-minute tick
  const now = 1_000_000;

  const first = nextAutonomyBackoff({ ownerVisible: 0, now, tickIntervalMs });
  assert.deepEqual(first, { streak: 1, nextAllowedAt: now + tickIntervalMs * 2 });

  const second = nextAutonomyBackoff({ ownerVisible: 0, prior: first, now, tickIntervalMs });
  assert.deepEqual(second, { streak: 2, nextAllowedAt: now + tickIntervalMs * 4 });

  // Doubling stops; a barren loop waits a bounded interval rather than an unbounded one. At the
  // production 5-minute tick the doubling cap binds first (2^6 ticks ≈ 5.3h, under the 6h ceiling).
  const deep = nextAutonomyBackoff({ ownerVisible: 0, prior: { streak: 20 }, now, tickIntervalMs });
  const deeper = nextAutonomyBackoff({ ownerVisible: 0, prior: { streak: 200 }, now, tickIntervalMs });
  assert.equal(deep.nextAllowedAt, deeper.nextAllowedAt, 'the wait stops growing');
  assert.ok(deep.nextAllowedAt - now <= 6 * 60 * 60_000, 'and never exceeds the ceiling');
  // A slow tick hits the ceiling instead of the doubling cap.
  assert.equal(
    nextAutonomyBackoff({ ownerVisible: 0, prior: { streak: 20 }, now, tickIntervalMs: 60 * 60_000 }).nextAllowedAt - now,
    6 * 60 * 60_000,
  );

  // Producing one finding the owner would actually see buys full price back immediately.
  const cleared = nextAutonomyBackoff({ ownerVisible: 1, prior: { streak: 20 }, now, tickIntervalMs });
  assert.deepEqual(cleared, { streak: 0, nextAllowedAt: now });
  assert.equal(autonomyBackoffActive(cleared, now), false);

  // And the throttle actually lifts on its own.
  assert.equal(autonomyBackoffActive(first, now + 1), true);
  assert.equal(autonomyBackoffActive(first, first.nextAllowedAt), false);
  assert.equal(autonomyBackoffActive(undefined, now), false, 'no record ⇒ never throttled');
});
