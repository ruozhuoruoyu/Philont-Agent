/**
 * StandardExecutor 单测:工具白名单 / LLM 解析 / sourceRefs 强制 / 写回 memory。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  StandardExecutor,
  parseExecutorOutput,
  SKILL_REPAIR_KIND,
  type ExtractorLlmClient,
  type Initiative,
  type SkillRepairContext,
  type ToolRunner,
  type ToolRunResult,
} from '../src/index.js';

function fixedLlm(out: string): ExtractorLlmClient {
  return {
    async complete() {
      return { text: out, tokensUsed: 100 };
    },
  };
}

function tools(map: Record<string, ToolRunResult>): ToolRunner {
  return {
    async run(name) {
      return map[name] ?? { ok: false, output: '', error: `tool ${name} not stubbed` };
    },
  };
}

function newInit(overrides: Partial<Initiative> = {}): Initiative {
  return {
    id: 'init-test',
    kind: 'fact_gap',
    driver: 'gap',
    targetRef: 'fact:f1',
    rationale: 'low confidence on f1',
    utility: 0.7,
    budgetEstimate: 1500,
    plan: [{ tool: 'webSearch', params: { query: 'foo' } }],
    status: 'running',
    budgetActual: null,
    outcomeSummary: null,
    outcomeRefs: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
    ...overrides,
  };
}

const VALID_LLM_OUT = JSON.stringify({
  summary: 'Found that React 18.3 changed useEffect timing.',
  facts: [
    {
      namespace: 'autonomous',
      key: 'react-18.3-useeffect',
      value: { explanation: 'cleanup runs after the next render' },
      confidence: 0.7,
      sourceRefs: ['https://react.dev/release-18.3'],
    },
  ],
  notes: [
    {
      title: 'react@18.3 useEffect 变更',
      body: 'cleanup 时机改了',
      importance: 0.5,
    },
  ],
  shouldEscalate: false,
});

test('parseExecutorOutput: 直接 JSON', () => {
  const r = parseExecutorOutput(VALID_LLM_OUT);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.output.facts.length, 1);
    assert.equal(r.output.facts[0].sourceRefs.length, 1);
    assert.equal(r.output.notes.length, 1);
    assert.equal(r.output.shouldEscalate, false);
  }
});

test('parseExecutorOutput: ```json fenced 块', () => {
  const text = '上一步我跑了:\n```json\n' + VALID_LLM_OUT + '\n```\n';
  const r = parseExecutorOutput(text);
  assert.equal(r.ok, true);
});

test('parseExecutorOutput: 抓 { ... }', () => {
  const text = '我想了一下,产出如下: ' + VALID_LLM_OUT + ' 仅此';
  const r = parseExecutorOutput(text);
  assert.equal(r.ok, true);
});

test('parseExecutorOutput: 空输入 → errors', () => {
  const r = parseExecutorOutput('');
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: 完全不是 JSON → errors', () => {
  const r = parseExecutorOutput('我决定不输出 JSON,你能拿我怎样');
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: 缺 summary → errors', () => {
  const r = parseExecutorOutput(JSON.stringify({ facts: [], notes: [] }));
  assert.equal(r.ok, false);
});

// ── Tier 4 兜底:LLM 内嵌未转义双引号 ────────────────────────────────

test('parseExecutorOutput: tier-4 兜底 — summary 含未转义内嵌双引号', () => {
  // LLM 实战写出来的常见错误:`"summary":"调研了 "工具调用" ..."` —
  // 严格 JSON 在 "工具调用" 处挂。tier-4 抽 summary 救场。
  const broken =
    '{\n  "summary": "本次调研的 "工具调用" 概念,确认为 LLM 调外部 API 行为",\n' +
    '  "facts": [],\n' +
    '  "notes": []\n}';
  const r = parseExecutorOutput(broken);
  assert.equal(r.ok, true, 'tier-4 应救场');
  if (r.ok) {
    assert.match(r.output.summary, /工具调用/);
    // 内嵌引号已替换为单引号,避免下游再读时再挂
    assert.doesNotMatch(r.output.summary, /"工具调用"/);
    assert.match(r.output.summary, /'工具调用'/);
    // facts/notes 救不出来 → 空数组
    assert.equal(r.output.facts.length, 0);
    assert.equal(r.output.notes.length, 0);
    assert.equal(r.output.shouldEscalate, false);
  }
});

test('parseExecutorOutput: tier-4 完全没 summary 字段 → 仍然 errors', () => {
  // LLM 输出连 summary 都没,无救
  const noSummary = '{"foo": "bar baz", "x": 1}';
  const r = parseExecutorOutput(noSummary);
  // 这个其实严格 JSON 能 parse,后续校验缺 summary → ok=false
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: tier-4 summary 太短 → 拒收', () => {
  // 抽出来 < 5 字符,认为没救出来
  const broken = '{"summary":"  hi  ","facts":';
  const r = parseExecutorOutput(broken);
  // 严格 parse 失败 + 抽出来太短 → ok=false
  assert.equal(r.ok, false);
});

test('parseExecutorOutput: tier-4 summary 超长 → 截 1000 字', () => {
  const long = 'A'.repeat(2000);
  const broken = `{"summary":"${long}", "broken":}`;
  const r = parseExecutorOutput(broken);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.output.summary.length <= 1000);
  }
});

// ── Executor 行为 ───────────────────────────────────────────────────────

test('executor: happy path 写 facts + notes', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({
      webSearch: { ok: true, output: 'react 18.3 changed useEffect cleanup timing' },
    }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.ok(result.outcomeRefs);
  assert.equal(result.outcomeRefs!.facts.length, 1);
  assert.equal(result.outcomeRefs!.notes.length, 1);
  assert.equal(result.toolCallsSpent, 1);

  // 验真:facts 表里有那条 fact
  const got = handle.facts.getFact('autonomous', 'react-18.3-useeffect');
  assert.ok(got);
  // value 包了 sourceRefs + via
  const v = got!.value as { sourceRefs: string[]; via: string };
  assert.deepEqual(v.sourceRefs, ['https://react.dev/release-18.3']);
  assert.equal(v.via, 'autonomous:init-test');
  handle.close();
});

test('executor: 工具白名单拦截 — 非白名单工具直接 fail', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({}),
  });

  const init = newInit({ plan: [{ tool: 'shell', params: { cmd: 'rm -rf /' } }] });
  const result = await exe.run(init);
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /autonomous whitelist/);
  // 没调 LLM,token 应是 0
  assert.equal(result.llmTokensSpent, 0);
  handle.close();
});

test('executor: sourceRefs 空的 fact 被丢弃', async () => {
  const handle = openMemoryDb(':memory:');
  const out = JSON.stringify({
    summary: 'something',
    facts: [
      { key: 'good', value: { x: 1 }, sourceRefs: ['url'] },
      { key: 'bad-no-source', value: { x: 1 }, sourceRefs: [] },
    ],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(out),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });
  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.equal(result.outcomeRefs!.facts.length, 1); // bad-no-source 被丢
  handle.close();
});

test('executor: namespace=self 的 fact 被丢弃', async () => {
  const handle = openMemoryDb(':memory:');
  const out = JSON.stringify({
    summary: 'something',
    facts: [
      { namespace: 'self', key: 'summary', value: { x: 1 }, sourceRefs: ['url'] },
      { namespace: 'autonomous', key: 'good', value: { x: 1 }, sourceRefs: ['url'] },
    ],
    notes: [],
    shouldEscalate: false,
  });
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(out),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });
  const result = await exe.run(newInit());
  assert.equal(result.status, 'done');
  assert.equal(result.outcomeRefs!.facts.length, 1);
  handle.close();
});

test('executor: 工具失败但不抛 → executor 继续到 LLM 摘要', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({
      webSearch: { ok: false, output: '', error: 'network' },
    }),
  });

  const result = await exe.run(newInit());
  // LLM 仍跑(可以基于"工具失败"写笔记),所以 status=done
  assert.equal(result.status, 'done');
  assert.equal(result.toolCallsSpent, 1);
  handle.close();
});

test('executor: LLM 解析失败 → status=failed', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm('我不输出 JSON,我就是不'),
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /parse failed/);
  handle.close();
});

test('executor: LLM 抛错 → status=failed 不污染 memory', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: {
      async complete() {
        throw new Error('llm down');
      },
    },
    tools: tools({ webSearch: { ok: true, output: 'res' } }),
  });

  const result = await exe.run(newInit());
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /llm down/);
  // memory 没新增 fact
  assert.equal(handle.facts.count(), 0);
  handle.close();
});

test('executor: 无 plan → 直接走 LLM(零工具调用)', async () => {
  const handle = openMemoryDb(':memory:');
  const exe = new StandardExecutor({
    facts: handle.facts,
    notes: handle.notes,
    llm: fixedLlm(VALID_LLM_OUT),
    tools: tools({}),
  });

  const result = await exe.run(newInit({ plan: [] }));
  assert.equal(result.status, 'done');
  assert.equal(result.toolCallsSpent, 0);
  handle.close();
});

test('executor WS6: shouldEscalate is threaded into InitiativeRunResult.escalate', async () => {
  const handle = openMemoryDb(':memory:');
  const mk = (shouldEscalate: boolean) =>
    new StandardExecutor({
      facts: handle.facts,
      notes: handle.notes,
      llm: fixedLlm(
        JSON.stringify({
          summary: 'finding',
          facts: [],
          notes: [{ title: 'n', body: 'evidence body', importance: 0.5 }],
          shouldEscalate,
        }),
      ),
      tools: tools({}),
    });

  const up = await mk(true).run(newInit({ plan: [] }));
  assert.equal(up.status, 'done');
  assert.equal(up.escalate, true);

  const down = await mk(false).run(newInit({ id: 'init-test-2', plan: [] }));
  assert.equal(down.status, 'done');
  assert.equal(down.escalate, false);
  handle.close();
});

// ── H3 skill_repair path (skill_self_repair.md) ─────────────────────────

const REPAIR_CTX: SkillRepairContext = {
  actionTemplate: 'run shell `pandoc in.md -o out.docx` then readFile out.docx',
  verification: { kind: 'tool_result_ok', check: 'readFile' },
  toolPolicy: ['shell', 'readFile'],
  failures: [
    { toolName: 'shell', result: 'pandoc: command not found', timestamp: 1000 },
  ],
};

function repairInit(overrides: Partial<Initiative> = {}): Initiative {
  return newInit({
    id: 'init-repair',
    kind: SKILL_REPAIR_KIND,
    driver: 'skill_repair',
    targetRef: 'skill:docx-convert',
    rationale: 'demoted after failing reuse verification',
    plan: undefined,
    ...overrides,
  });
}

const REPAIR_LLM_OUT = JSON.stringify({
  summary: 'pandoc missing; install check added',
  facts: [],
  notes: [],
  shouldEscalate: false,
  skillRevision: {
    actionTemplate: 'check pandoc exists, then run shell `pandoc in.md -o out.docx`, then readFile out.docx',
    diagnosis: 'pandoc is not installed on this host; the recipe assumed it was',
  },
});

test('executor(skill_repair): 用 skillRepairContext 的证据诊断,返回 skillRevision', async () => {
  const h = openMemoryDb(':memory:');
  const ex = new StandardExecutor({
    facts: h.facts, notes: h.notes, llm: fixedLlm(REPAIR_LLM_OUT), tools: tools({}),
    skillRepairContext: () => REPAIR_CTX,
  });
  const r = await ex.run(repairInit());
  assert.equal(r.status, 'done');
  assert.ok(r.skillRevision, 'must surface the proposed fix');
  assert.match(r.skillRevision!.actionTemplate, /check pandoc exists/);
  assert.match(r.skillRevision!.diagnosis, /not installed/);
  assert.equal(r.toolCallsSpent, 0, 'a repair calls no tools — evidence is local');
  h.close();
});

test('executor(skill_repair): 诊断给出的证据真的进了 prompt(否则等于让 LLM 瞎猜)', async () => {
  const h = openMemoryDb(':memory:');
  let seenPrompt = '';
  const spyLlm: ExtractorLlmClient = {
    async complete(p: string) { seenPrompt = p; return { text: REPAIR_LLM_OUT, tokensUsed: 10 }; },
  };
  const ex = new StandardExecutor({
    facts: h.facts, notes: h.notes, llm: spyLlm, tools: tools({}),
    skillRepairContext: () => REPAIR_CTX,
  });
  await ex.run(repairInit());
  assert.match(seenPrompt, /pandoc: command not found/, '失败轨迹必须出现在 prompt 里');
  assert.match(seenPrompt, /pandoc in\.md -o out\.docx/, '当前配方内容必须出现在 prompt 里');
  assert.match(seenPrompt, /OMIT skillRevision/, '必须明确告诉 LLM "证据不足就别改" 是合法答案');
  h.close();
});

test('executor(skill_repair): context 解析不到(技能已消失/已修好)→ failed,不去乱改', async () => {
  const h = openMemoryDb(':memory:');
  let llmCalled = false;
  const llm: ExtractorLlmClient = {
    async complete() { llmCalled = true; return { text: REPAIR_LLM_OUT, tokensUsed: 10 }; },
  };
  const ex = new StandardExecutor({
    facts: h.facts, notes: h.notes, llm, tools: tools({}),
    skillRepairContext: () => null,
  });
  const r = await ex.run(repairInit());
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /no repair context/);
  assert.equal(llmCalled, false, '拿不到证据就不该烧 LLM');
  h.close();
});

test('executor(skill_repair): LLM 省略 skillRevision(证据不足)→ done 但无修订', async () => {
  const h = openMemoryDb(':memory:');
  const out = JSON.stringify({
    summary: 'cannot tell why it failed from these trajectories',
    facts: [], notes: [], shouldEscalate: false,
  });
  const ex = new StandardExecutor({
    facts: h.facts, notes: h.notes, llm: fixedLlm(out), tools: tools({}),
    skillRepairContext: () => REPAIR_CTX,
  });
  const r = await ex.run(repairInit());
  assert.equal(r.status, 'done');
  assert.equal(r.skillRevision, undefined, '证据不足时必须不产出修订');
  h.close();
});

test('executor: 非 skill_repair 的 initiative 即使 LLM 硬塞 skillRevision 也不会被带出', async () => {
  const h = openMemoryDb(':memory:');
  const sneaky = JSON.stringify({
    summary: 'ok', facts: [], notes: [], shouldEscalate: false,
    skillRevision: { actionTemplate: 'rm -rf /', diagnosis: 'evil' },
  });
  const ex = new StandardExecutor({
    facts: h.facts, notes: h.notes, llm: fixedLlm(sneaky),
    tools: tools({ webSearch: { ok: true, output: 'result' } }),
    skillRepairContext: () => REPAIR_CTX,
  });
  const r = await ex.run(newInit()); // kind='fact_gap'
  assert.equal(r.status, 'done');
  assert.equal(r.skillRevision, undefined, 'curiosity/gap initiative 绝不能改技能');
  h.close();
});

test('parseExecutorOutput: skillRevision 校验 — 缺 actionTemplate 丢弃;verification kind 非法则丢 verification 保留改写', () => {
  const noTemplate = parseExecutorOutput(JSON.stringify({
    summary: 's', skillRevision: { diagnosis: 'd' },
  }));
  assert.ok(noTemplate.ok);
  assert.equal(noTemplate.ok && noTemplate.output.skillRevision, undefined);

  const badVerification = parseExecutorOutput(JSON.stringify({
    summary: 's',
    skillRevision: { actionTemplate: 'steps', diagnosis: 'd', verification: { kind: 'bogus', check: 'x' } },
  }));
  assert.ok(badVerification.ok);
  const rev = badVerification.ok ? badVerification.output.skillRevision : undefined;
  assert.ok(rev);
  assert.equal(rev!.actionTemplate, 'steps');
  assert.equal(rev!.verification, undefined, '非法 kind → 丢弃 verification,沿用原校验');

  const good = parseExecutorOutput(JSON.stringify({
    summary: 's',
    skillRevision: { actionTemplate: 'steps', diagnosis: 'd', verification: { kind: 'assert', check: 'exists' } },
  }));
  assert.ok(good.ok);
  assert.deepEqual(good.ok && good.output.skillRevision?.verification, { kind: 'assert', check: 'exists' });
});

test('parseExecutorOutput: skillRevision 省略 diagnosis → 回落到 summary', () => {
  const r = parseExecutorOutput(JSON.stringify({
    summary: 'the root cause summary', skillRevision: { actionTemplate: 'steps' },
  }));
  assert.ok(r.ok);
  assert.equal(r.ok && r.output.skillRevision?.diagnosis, 'the root cause summary');
});
