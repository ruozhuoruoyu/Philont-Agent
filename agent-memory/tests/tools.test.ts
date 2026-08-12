/**
 * 记忆工具测试
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, createMemoryTools } from '../src/index.js';

test('store_fact tool stores and returns success', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'name',
    value: 'alice',
  });

  assert.equal(r.success, true);
  assert.ok(r.output?.includes('user.name'));
  assert.equal(facts.getFact('user', 'name')?.value, 'alice');
});

test('get_fact tool returns value', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });

  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'age' });
  assert.equal(r.success, true);
  // output 现在带时间元数据前缀（见 formatFactTimes）
  assert.ok(r.output?.startsWith('30 ['), `unexpected output: ${r.output}`);
  assert.ok(r.output?.includes('recorded '));
});

test('get_fact returns error when missing', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'ghost' });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Not found'));
});

test('list_facts tool returns formatted list', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({ namespace: 'user', key: 'name', value: 'a' });
  facts.storeFact({ namespace: 'user', key: 'age', value: 30 });

  const tools = createMemoryTools(facts, notes);
  const listFacts = tools.find((t) => t.name === 'list_facts')!;

  const r = await listFacts.execute({ namespace: 'user' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('user.name'));
  assert.ok(r.output?.includes('user.age'));
});

test('search_notes tool finds matching content', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: '用户讨论了缓存策略' });
  notes.storeNote({ content: '项目使用 Redis' });

  const tools = createMemoryTools(facts, notes);
  const searchNotes = tools.find((t) => t.name === 'search_notes')!;

  const r = await searchNotes.execute({ query: '缓存' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('缓存'));
});

test('store_fact rejects invalid namespace', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({ namespace: '', key: 'x', value: 1 });
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('namespace'));
});

test('store_fact accepts ISO8601 time fields for event kind', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'lunch',
    value: '饺子',
    fact_kind: 'event',
    occurred_at: '2026-04-22T12:00:00+08:00',
  });

  assert.equal(r.success, true);
  const fact = facts.getFact('user', 'lunch')!;
  assert.equal(fact.factKind, 'event');
  assert.equal(fact.occurredAt, Date.parse('2026-04-22T12:00:00+08:00'));
  // output 带 event@ 标签
  assert.ok(r.output?.includes('event@'), `output missing event tag: ${r.output}`);
});

test('store_fact accepts valid_until for state kind (with expiry)', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  const r = await storeFact.execute({
    namespace: 'user',
    key: 'status',
    value: 'on_leave',
    fact_kind: 'state',
    valid_from: '2026-04-22T00:00:00+08:00',
    valid_until: '2026-04-26T23:59:59+08:00',
  });

  assert.equal(r.success, true);
  const fact = facts.getFact('user', 'status')!;
  assert.equal(fact.factKind, 'state');
  assert.equal(fact.validFrom, Date.parse('2026-04-22T00:00:00+08:00'));
  assert.equal(fact.validUntil, Date.parse('2026-04-26T23:59:59+08:00'));
  assert.ok(r.output?.includes('state '));
});

test('get_fact output embeds event timestamp and recorded time', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({
    namespace: 'user',
    key: 'meeting',
    value: 'weekly review',
    factKind: 'event',
    occurredAt: Date.parse('2026-04-22T15:00:00+08:00'),
  });

  const tools = createMemoryTools(facts, notes);
  const getFact = tools.find((t) => t.name === 'get_fact')!;

  const r = await getFact.execute({ namespace: 'user', key: 'meeting' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('event@'));
  assert.ok(r.output?.includes('2026-04-22T07:00:00.000Z')); // 15:00 +08 → 07:00 UTC
  assert.ok(r.output?.includes('recorded '));
});

// ── v6: recall_sessions tool ────────────────────────────────────────────

test('recall_sessions: aggregates message hits by session + attaches summary', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const a = raw.startSession();
  raw.appendMessage({ sessionId: a.id, role: 'user', content: '讨论数据库迁移策略' });
  raw.appendMessage({ sessionId: a.id, role: 'assistant', content: '建议跑影子表 backfill' });
  notes.upsertNote(`session-summary-${a.id}`, {
    content: '本次会话决定先建影子表再切流量',
    importance: 1.0,
    sessionId: a.id,
  });

  const b = raw.startSession();
  raw.appendMessage({ sessionId: b.id, role: 'user', content: '今晚要做迁移演练' });

  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions');
  assert.ok(recall, 'recall_sessions 应被注册');

  const r = await recall!.execute({ query: '迁移' });
  assert.equal(r.success, true);
  const data = r.data as Array<{
    sessionId: string;
    summary: string | null;
    topHits: Array<{ snippet: string }>;
  }>;
  assert.equal(data.length, 2, '两个 session 都有命中');
  const aEntry = data.find((d) => d.sessionId === a.id)!;
  assert.ok(aEntry.summary?.includes('影子表'));
  assert.ok(aEntry.topHits.length >= 1);
});

test('recall_sessions: without RawStore the tool is not registered', () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes);
  assert.equal(tools.find((t) => t.name === 'recall_sessions'), undefined);
});

test('recall_sessions: empty query is rejected', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions')!;
  const r = await recall.execute({ query: '   ' });
  assert.equal(r.success, false);
});

test('recall_sessions: since / until filter scopes results', async () => {
  const { facts, notes, raw } = openMemoryDb(':memory:');
  const s = raw.startSession();
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '旧消息 project alpha' });
  await new Promise((r) => setTimeout(r, 10));
  const boundary = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  raw.appendMessage({ sessionId: s.id, role: 'user', content: '新消息 project alpha' });

  const tools = createMemoryTools(facts, notes, undefined, undefined, undefined, raw);
  const recall = tools.find((t) => t.name === 'recall_sessions')!;

  const older = await recall.execute({
    query: 'alpha',
    until: new Date(boundary).toISOString(),
  });
  assert.equal(older.success, true);
  const olderData = older.data as Array<{ topHits: Array<{ snippet: string }> }>;
  assert.equal(olderData.length, 1);
  assert.ok(olderData[0].topHits.some((h) => h.snippet.startsWith('旧消息')));

  const newer = await recall.execute({
    query: 'alpha',
    since: new Date(boundary).toISOString(),
  });
  const newerData = newer.data as Array<{ topHits: Array<{ snippet: string }> }>;
  assert.ok(newerData[0].topHits.some((h) => h.snippet.startsWith('新消息')));
});

test('list_facts output shows time label per fact', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  facts.storeFact({
    namespace: 'user',
    key: 'lunch',
    value: '面条',
    factKind: 'event',
    occurredAt: Date.parse('2026-04-21T12:00:00+08:00'),
  });
  facts.storeFact({
    namespace: 'user',
    key: 'role',
    value: 'engineer',
    factKind: 'state',
  });

  const tools = createMemoryTools(facts, notes);
  const listFacts = tools.find((t) => t.name === 'list_facts')!;

  const r = await listFacts.execute({ namespace: 'user' });
  assert.equal(r.success, true);
  assert.ok(r.output?.includes('event@2026-04-21T04:00:00.000Z'));
  assert.ok(r.output?.includes('state '));
  const lines = r.output!.split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.ok(/\[.*recorded .*\]/.test(line), `line missing time tag: ${line}`);
  }
});

test('store_fact rejects secret-shaped values (credential hygiene gate)', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);

  // Regression shape: service-prefixed long hex under a credential-named key.
  const r1 = await storeFact.execute({
    namespace: 'project',
    key: 'example_service.api_key',
    value: 'exampleservice_a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  });
  assert.equal(r1.success, false);
  assert.match(r1.error ?? '', /saveCredential/);
  assert.equal(facts.getFact('project', 'example_service.api_key'), null);

  // Known token prefixes are rejected regardless of key name.
  const r2 = await storeFact.execute({ namespace: 'project', key: 'notes', value: 'ghp_abcdef1234567890abcdef1234567890abcd' });
  assert.equal(r2.success, false);

  // Bare token-like value under a credential-named key.
  const r3 = await storeFact.execute({ namespace: 'user', key: 'service_token', value: 'AbCdEfGh1234567890.xyz_-AbCd' });
  assert.equal(r3.success, false);

  // Legit values pass: tombstone JSON, prose, short ids, hex under a non-credential key.
  const ok1 = await storeFact.execute({ namespace: 'project', key: 'example_service.auth', value: '{"status":"cleared","reason":"user requested deletion"}' });
  assert.equal(ok1.success, true);
  const ok2 = await storeFact.execute({ namespace: 'project', key: 'commit', value: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0' });
  assert.equal(ok2.success, true, ok2.error);
  const ok3 = await storeFact.execute({ namespace: 'user', key: 'name', value: 'alice' });
  assert.equal(ok3.success, true);
});

test('store_fact rejects secrets wrapped in object values (regression)', async () => {
  const { facts, notes } = openMemoryDb(':memory:');
  const [storeFact] = createMemoryTools(facts, notes);
  const r = await storeFact.execute({
    namespace: 'project',
    key: 'example_service.credentials',
    value: {
      actor_id: '00000000-0000-4000-8000-000000000000',
      handle: 'example-agent',
      api_key: 'exampleservice_b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    },
  });
  assert.equal(r.success, false);
  assert.match(r.error ?? '', /saveCredential/);
  // Objects without secret leaves still store fine (nested prefix strings are not keys).
  const ok = await storeFact.execute({
    namespace: 'project',
    key: 'example_service.credentials_status',
    value: { handle: 'example-agent', api_key_prefix: 'exampleservice_b2b2b2', status: 'saved-in-credential-store' },
  });
  assert.equal(ok.success, true, ok.error);
});

test('grant_research_tool ratifies a pending request — it cannot mint authorization', async () => {
  const { openMemoryDb, createResearchTools } = await import('../src/index.js');
  const db = openMemoryDb(':memory:') as unknown as { pursuits: any };
  const minted: unknown[] = [];
  const tools = createResearchTools(db.pursuits, { grant: (g: unknown) => minted.push(g) } as never);
  const grant = tools.find((t) => t.name === 'grant_research_tool')! as unknown as {
    execute: (p: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
  };

  // It is write × self, which the read-only matrix permits — so it raises no card of its own, and
  // the only thing standing between a model and an arbitrary capability is this validation.
  const invented = await grant.execute({ pursuitId: 'no-such-pursuit', tool: 'shell' });
  assert.equal(invented.success, false, 'a fabricated pursuit id must not mint a grant');
  assert.equal(minted.length, 0);

  const pid = db.pursuits.createRoot({ title: 'a research', intent: 'find out', origin: 'user' }).id;
  const qid = db.pursuits.addOpenQuestion(pid, 'needs a numeric check', 1);

  const nothingPending = await grant.execute({ pursuitId: pid, tool: 'shell' });
  assert.equal(nothingPending.success, false, 'a real pursuit with nothing pending is not an approval');

  db.pursuits.setQuestionPendingTool(pid, qid, { tool: 'pariGp', why: 'needs to compute' });
  const wrongTool = await grant.execute({ pursuitId: pid, tool: 'shell' });
  assert.equal(wrongTool.success, false, 'approving a DIFFERENT tool than the one requested');
  assert.equal(minted.length, 0, 'nothing was granted along the way');

  const real = await grant.execute({ pursuitId: pid, tool: 'pariGp' });
  assert.equal(real.success, true, 'the flow it exists for still works');
  assert.equal(minted.length, 1);
});

test('reachability: a self-domain tool must not be able to mint authorization unchecked', async () => {
  // grant_research_tool is write × self, which the read-only matrix permits — so it raises no
  // approval card of its own, and the ONLY thing between a model and an arbitrary capability is the
  // validation inside it. That validation is therefore a security control, not a niceness, and this
  // asserts it is still in the source rather than only in a behaviour test that could be rewritten
  // around. (The behaviour itself is pinned by the test above.)
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  // Package root: the suite runs from dist/tests when compiled and from tests/ under tsx, so an
  // import.meta-relative path resolves differently in the two. npm runs both from here.
  const src = readFileSync(join(process.cwd(), 'src', 'research_tools.ts'), 'utf8');
  assert.match(src, /pursuits\.get\(p\.pursuitId\)/, 'the pursuit must be looked up');
  assert.match(src, /pendingTool\?\.tool === p\.tool/, 'the pending request must match the tool asked for');
  const grantCall = src.indexOf('grantStore.grant({');
  assert.ok(grantCall > src.indexOf('pendingTool?.tool === p.tool'), 'validation must precede the grant');
});

test('a research approval is stamped for the research that asked, and cannot be cashed twice', async () => {
  const { openMemoryDb, createResearchTools, researchGrantAudience } = await import('../src/index.js');
  const db = openMemoryDb(':memory:') as unknown as { pursuits: any };
  const issued: Array<{ audience?: string }> = [];
  const tools = createResearchTools(db.pursuits, { grant: (g: { audience?: string }) => issued.push(g) } as never);
  const grant = tools.find((t) => t.name === 'grant_research_tool')! as unknown as {
    execute: (p: Record<string, unknown>) => Promise<{ success: boolean }>;
  };

  const pid = db.pursuits.createRoot({ title: 'r', intent: 'find out', origin: 'user' }).id;
  const qid = db.pursuits.addOpenQuestion(pid, 'needs shell', 1);
  db.pursuits.setQuestionPendingTool(pid, qid, { tool: 'shell', why: 'to run it' });

  assert.equal((await grant.execute({ pursuitId: pid, tool: 'shell' })).success, true);
  // Grants are matched by tool NAME; the audience is the only thing that says who the yes was for,
  // and "all background research" was still wider than the research that asked.
  assert.equal(issued[0]!.audience, researchGrantAudience(pid));

  // THE REQUEST SURVIVES THE APPROVAL. PursuitDriver recognises the post-approval replay by
  // `pendingTool && isGranted(tool)` — clearing it here writes the grant and strands the research,
  // which is what clearing means on the DENY path.
  const after = db.pursuits.get(pid).openQuestions.find((q: any) => q.id === qid);
  assert.equal(after.pendingTool?.tool, 'shell', 'the request must still be visible to the driver');
  assert.ok(after.pendingTool?.approvedAt, 'and marked answered');

  // Answered once. A second call would just buy a fresh window off the same yes.
  assert.equal((await grant.execute({ pursuitId: pid, tool: 'shell' })).success, false);
  assert.equal(issued.length, 1);
});

test('one research being authorized does not authorize another', async () => {
  const { openMemoryDb, createResearchTools, researchGrantAudience } = await import('../src/index.js');
  const db = openMemoryDb(':memory:') as unknown as { pursuits: any };
  const issued: Array<{ audience?: string }> = [];
  const tools = createResearchTools(db.pursuits, { grant: (g: { audience?: string }) => issued.push(g) } as never);
  const grant = tools.find((t) => t.name === 'grant_research_tool')! as unknown as {
    execute: (p: Record<string, unknown>) => Promise<{ success: boolean }>;
  };

  const a = db.pursuits.createRoot({ title: 'A', intent: 'a', origin: 'user' }).id;
  const b = db.pursuits.createRoot({ title: 'B', intent: 'b', origin: 'user' }).id;
  const qa = db.pursuits.addOpenQuestion(a, 'needs shell', 1);
  db.pursuits.setQuestionPendingTool(a, qa, { tool: 'shell', why: 'to run it' });
  await grant.execute({ pursuitId: a, tool: 'shell' });

  assert.equal(issued[0]!.audience, researchGrantAudience(a));
  assert.notEqual(issued[0]!.audience, researchGrantAudience(b), "B's loop must not be able to spend A's approval");
});

test('a research authorization has a ceiling, not just a default', async () => {
  const { openMemoryDb, createResearchTools, MAX_RESEARCH_GRANT_TTL_MS } = await import('../src/index.js');
  const db = openMemoryDb(':memory:') as unknown as { pursuits: any };
  const issued: Array<{ ttlMs?: number }> = [];
  const tools = createResearchTools(db.pursuits, { grant: (g: { ttlMs?: number }) => issued.push(g) } as never);
  const grant = tools.find((t) => t.name === 'grant_research_tool')! as unknown as {
    execute: (p: Record<string, unknown>) => Promise<{ success: boolean }>;
  };
  const pid = db.pursuits.createRoot({ title: 'r', intent: 'find out', origin: 'user' }).id;
  const qid = db.pursuits.addOpenQuestion(pid, 'needs shell', 1);
  db.pursuits.setQuestionPendingTool(pid, qid, { tool: 'shell', why: 'to run it' });

  // A year, asked for politely. "Default two hours" was never "at most two hours".
  await grant.execute({ pursuitId: pid, tool: 'shell', ttlMs: 365 * 24 * 60 * 60_000 });
  assert.equal(issued[0]!.ttlMs, MAX_RESEARCH_GRANT_TTL_MS);
});
