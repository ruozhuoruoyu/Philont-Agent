/**
 * Mechanism-driven plan–execute loop — unit tests.
 *
 * Verifies:
 *   1. extractSpecItems: headings / numbered steps / MUST lines, bounded, deduped.
 *   2. checkCoverage: mandatory gaps gate the verdict; loose token overlap; optional items informational.
 *   3. parseDraftJson: fenced/prose-wrapped JSON, shape validation, covers filtered to valid ids.
 *   4. runPlanExecuteLoop end-to-end with fake deps:
 *      - VERIFY gap → REVISE round → pass → EXECUTE with tool evidence → completed.
 *      - a model that "declares done" but whose step makes no tool call → deliverable FAILED (evidence
 *        computed, not declared) → partial.
 *      - guide fetch hard-fail → aborted with an honest reply (task never starts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSpecItems,
  checkCoverage,
  parseDraftJson,
  runPlanExecuteLoop,
  planLoopEnabled,
  type PlanLoopDeps,
} from '../src/plan_execute_loop.js';

const GUIDE = [
  '# MycoX Agent Guide',
  '> You MUST read SOUL.md before you register.',
  '## Part 1: Register',
  '1. POST /api/register with your invite_code',
  '## Part 2: Posting rules',
  'You must include a title and community when posting.',
].join('\n');

test('extractSpecItems: headings + numbered steps + MUST lines, mandatory flagged', () => {
  const items = extractSpecItems(GUIDE);
  assert.ok(items.length >= 4);
  assert.ok(items.some((i) => /register/i.test(i.text) && !i.mandatory === false || /register/i.test(i.text)));
  const mustItem = items.find((i) => /SOUL\.md/.test(i.text));
  assert.ok(mustItem, 'MUST line extracted');
  assert.equal(mustItem!.mandatory, true);
});

test('checkCoverage: uncovered mandatory item → gap + not covered; covered → passes', () => {
  const spec = extractSpecItems(GUIDE);
  const partial = [{ id: 'register', description: 'POST /api/register with invite_code to register' }];
  const r1 = checkCoverage(spec, partial);
  assert.equal(r1.covered, false, 'SOUL.md MUST item uncovered → fail');
  assert.ok(r1.gaps.some((g) => /SOUL\.md/.test(g.text)));
  const full = [
    ...partial,
    { id: 'read-soul', description: 'read SOUL.md in full before register' },
    { id: 'post-rules', description: 'posting must include title and community' },
  ];
  const r2 = checkCoverage(spec, full);
  assert.equal(r2.covered, true, `expected covered, gaps=${r2.gaps.map((g) => g.text).join('|')}`);
});

test('parseDraftJson: fenced JSON with prose; invalid covers filtered; bad shape → null', () => {
  const text = 'Here is my plan:\n```json\n' + JSON.stringify({
    deliverables: [{ id: 'Register Agent', description: 'register' }],
    steps: [{ id: 's1', description: 'do it', covers: ['register-agent', 'nonexistent'] }],
  }) + '\n```\nHope this helps!';
  const d = parseDraftJson(text);
  assert.ok(d);
  assert.equal(d!.deliverables[0].id, 'register-agent'); // slugified
  assert.deepEqual(d!.steps[0].covers, ['register-agent']); // invalid id dropped
  assert.equal(parseDraftJson('no json here'), null);
  assert.equal(parseDraftJson('{"deliverables":[],"steps":[]}'), null, 'empty deliverables → null');
});

test('planLoopEnabled: default ON, opt-out via env', () => {
  const prev = process.env.PHILONT_PLAN_LOOP;
  delete process.env.PHILONT_PLAN_LOOP;
  assert.equal(planLoopEnabled(), true, 'default ON');
  process.env.PHILONT_PLAN_LOOP = '0';
  assert.equal(planLoopEnabled(), false, 'kill-switch');
  process.env.PHILONT_PLAN_LOOP = 'off';
  assert.equal(planLoopEnabled(), false);
  if (prev === undefined) delete process.env.PHILONT_PLAN_LOOP;
  else process.env.PHILONT_PLAN_LOOP = prev;
});

// ── End-to-end with fake deps ────────────────────────────────────────────────

function makeDeps(overrides: Partial<PlanLoopDeps> & { drafts: string[]; execToolOk?: boolean }): PlanLoopDeps {
  let draftIdx = 0;
  const drafts = overrides.drafts;
  const execToolOk = overrides.execToolOk ?? true;
  return {
    llm: {
      async send(systemPrompt, messages, toolDefs) {
        // DRAFT/REVISE calls come with no tools; EXECUTE mini-loop calls come with toolDefs.
        if (toolDefs.length === 0) {
          const content = drafts[Math.min(draftIdx, drafts.length - 1)];
          draftIdx++;
          return { type: 'text', content };
        }
        // EXECUTE: first call → tool call; second → final text claiming completion.
        const hasToolResult = messages.some((m) => Array.isArray(m.content));
        if (!hasToolResult) {
          return {
            type: 'toolCalls',
            calls: [{ id: 't1', name: 'http', input: { url: 'https://x/api/register', method: 'POST' } }],
            assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'http', input: {} }] as never },
          };
        }
        return { type: 'text', content: 'step done.' };
      },
    },
    toolRunner: async () => (execToolOk ? { ok: true, output: 'HTTP 200 {"valid":true}' } : { ok: false, output: '', error: 'HTTP 500' }),
    toolDefs: [{ name: 'http', description: 'http', parameters: '{}' }],
    toolBlacklist: new Set<string>(),
    fetchGuide: async () => GUIDE,
    log: () => {},
    ...overrides,
  };
}

const GOOD_DRAFT = JSON.stringify({
  deliverables: [
    { id: 'read-soul', description: 'read SOUL.md in full before register' },
    { id: 'register', description: 'POST /api/register with invite_code' },
    { id: 'post-rules', description: 'posting must include title and community' },
  ],
  steps: [
    { id: 's1', description: 'read soul then register via POST /api/register', covers: ['read-soul', 'register'] },
    { id: 's2', description: 'note posting rules: title + community', covers: ['post-rules'] },
  ],
});

const GAPPY_DRAFT = JSON.stringify({
  deliverables: [{ id: 'register', description: 'POST /api/register with invite_code to register' }],
  steps: [{ id: 's1', description: 'register', covers: ['register'] }],
});

test('loop e2e: gap → REVISE → pass → EXECUTE with evidence → completed', async () => {
  const deps = makeDeps({ drafts: [GAPPY_DRAFT, GOOD_DRAFT] });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.equal(r.outcome, 'completed', `reply=${r.reply}`);
  assert.equal(r.unresolvedGaps.length, 0);
  assert.ok(r.outcomes.every((o) => o.status === 'done'));
  assert.match(r.reply, /3\/3/);
});

test('loop e2e: step tool fails → deliverable FAILED (computed, not declared) → partial', async () => {
  const deps = makeDeps({ drafts: [GOOD_DRAFT], execToolOk: false });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.equal(r.outcome, 'aborted', 'no deliverable has evidence → not completed');
  assert.ok(r.outcomes.every((o) => o.status !== 'done'), 'model prose "step done" must not count as done');
});

test('loop e2e: guide fetch hard-fail → aborted honestly, nothing executed', async () => {
  const deps = makeDeps({ drafts: [GOOD_DRAFT], fetchGuide: async () => null });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.equal(r.outcome, 'aborted');
  assert.match(r.reply, /无法读取/);
  assert.equal(r.outcomes.length, 0);
});

test('loop e2e: verify exhausted + aux-only gaps → still REPORTED (never silent)', async () => {
  // Mandatory det gaps get mechanically adopted; aux-judge extras cannot be adopted (no SpecItem)
  // and must surface in the reply.
  const deps = makeDeps({
    drafts: [GAPPY_DRAFT, GAPPY_DRAFT, GAPPY_DRAFT],
    auxJudge: async () => ['guide requires a weekly heartbeat check-in'],
  });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.ok(r.unresolvedGaps.length > 0);
  assert.match(r.reply, /未纳入本次计划/);
});

test('checkCoverage: step descriptions count as coverage (prod: vote/comment lived in steps only)', async () => {
  const spec = extractSpecItems('You must vote on posts.\nYou must comment thoughtfully.');
  const deliverables = [{ id: 'register', description: 'register the agent' }];
  const without = checkCoverage(spec, deliverables);
  assert.equal(without.covered, false);
  const withSteps = checkCoverage(spec, deliverables, 0.3, ['vote on posts after reading', 'comment thoughtfully on a post']);
  assert.equal(withSteps.covered, true);
});

test('loop e2e: verify exhausted → mechanism ADOPTS mandatory gaps as deliverables (not just reported)', async () => {
  const deps = makeDeps({ drafts: [GAPPY_DRAFT, GAPPY_DRAFT, GAPPY_DRAFT] });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.ok(r.deliverables.length > 1, 'mandatory items mechanically added to the plan');
  assert.ok(r.steps.some((s) => s.id.startsWith('fulfill-')), 'fulfilling steps added');
});

// ── Evidence criterion hardening (prod: "publish a post" ✅ off 11 ok reads, POST never succeeded) ──

test('extractSpecItems: heartbeat/periodic lines are MANDATORY even without "must"', () => {
  const items = extractSpecItems('Send a check-in heartbeat every 10 minutes to stay active.');
  const hb = items.find((i) => /heartbeat/.test(i.text));
  assert.ok(hb, 'periodic line extracted');
  assert.equal(hb!.mandatory, true);
});

test('checkCoverage: mid-band overlap (~0.4) passes at 0.3 but is a gap at 0.5 (aux dedupe threshold)', () => {
  const spec = [{ id: 'g', text: 'alpha beta gamma delta epsilon', mandatory: true }];
  const deliv = [{ id: 'd', description: 'alpha beta zzz yyy xxx' }]; // 2/5 = 0.4
  assert.equal(checkCoverage(spec, deliv, 0.3).covered, true);
  assert.equal(checkCoverage(spec, deliv, 0.5).covered, false);
});

test('loop e2e: step with ok READS but every ACTION (POST) failed → deliverable FAILED, not masked', async () => {
  const classifyCall = (name: string, input: Record<string, unknown>) =>
    name === 'http' && /^(POST|PUT|DELETE|PATCH)$/.test(String(input.method ?? 'GET').toUpperCase())
      ? { capability: 'write', domain: 'network' }
      : { capability: 'read', domain: 'network' };
  const deps = makeDeps({
    drafts: [GOOD_DRAFT],
    classifyCall,
    llm: {
      async send(systemPrompt, messages, toolDefs) {
        if (toolDefs.length === 0) return { type: 'text', content: GOOD_DRAFT };
        const hasToolResult = messages.some((m) => Array.isArray(m.content));
        if (!hasToolResult) {
          return {
            type: 'toolCalls',
            calls: [
              { id: 'r1', name: 'http', input: { url: 'https://x/api/feed', method: 'GET' } },
              { id: 'w1', name: 'http', input: { url: 'https://x/api/posts', method: 'POST' } },
            ],
            assistantMessage: { role: 'assistant', content: [
              { type: 'tool_use', id: 'r1', name: 'http', input: {} },
              { type: 'tool_use', id: 'w1', name: 'http', input: {} },
            ] as never },
          };
        }
        return { type: 'text', content: 'published successfully!' }; // prose lie — must not count
      },
    },
    toolRunner: async (_name: string, input: Record<string, unknown>) =>
      String(input.method ?? 'GET') === 'POST'
        ? { ok: false, output: '', error: 'HTTP 429 post cap' }
        : { ok: true, output: 'HTTP 200 feed' },
  });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.ok(r.outcomes.every((o) => o.status !== 'done'), 'ok reads must not mask the failed POST');
  assert.notEqual(r.outcome, 'completed');
  assert.match(r.reply, /❌/);
});

test('loop e2e: wall-clock budget exhausted mid-EXECUTE → stops, marks rest not-attempted, reports honestly', async () => {
  // Fake clock: each LLM call costs 100s. deadline=150s → DRAFT eats 100s; step 1 runs (50s left ≥ 45s
  // headroom); before step 2 the budget is gone → stop + honest ⏱ note (prod: a 503-throttled 10-step
  // run blew the turn's 20-min hard deadline and the whole turn was killed, report never sent).
  let tick = 0;
  const base = makeDeps({ drafts: [GOOD_DRAFT] });
  const deps: PlanLoopDeps = {
    ...base,
    llm: {
      async send(systemPrompt, messages, toolDefs) {
        tick += 100_000;
        return base.llm.send(systemPrompt, messages, toolDefs);
      },
    },
    now: () => tick,
    deadlineMs: 150_000,
  };
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.match(r.reply, /时间预算耗尽/);
  const notAttempted = r.outcomes.filter((o) => o.status === 'not-attempted');
  assert.ok(notAttempted.length > 0, 'remaining deliverables honestly not-attempted');
  assert.ok(notAttempted.some((o) => /time budget/.test(o.evidence)));
  assert.notEqual(r.outcome, 'completed');
});

// ── v1.2 evidence matching (prod: 9/9 ✅ while NO post existed and NO schedule was set) ──

const POST_HEARTBEAT_DRAFT = JSON.stringify({
  deliverables: [
    { id: 'publish-post', description: 'publish at least one substantive post' },
    { id: 'heartbeat', description: 'set up the periodic heartbeat check-in schedule' },
  ],
  steps: [
    { id: 's-post', description: 'publish the post via the API', covers: ['publish-post'] },
    { id: 's-hb', description: 'set up the heartbeat schedule', covers: ['heartbeat'] },
  ],
});

test('loop e2e: action deliverable with ZERO action attempts → FAILED (the dodge into the pure-read pass)', async () => {
  // Mini-loop only ever GETs (reads) — prod: the posting step made 0 action attempts and passed.
  const deps = makeDeps({
    drafts: [POST_HEARTBEAT_DRAFT],
    llm: {
      async send(systemPrompt, messages, toolDefs) {
        if (toolDefs.length === 0) return { type: 'text', content: POST_HEARTBEAT_DRAFT };
        const hasToolResult = messages.some((m) => Array.isArray(m.content));
        if (!hasToolResult) {
          return {
            type: 'toolCalls',
            calls: [{ id: 'r1', name: 'http', input: { url: 'https://x/api/feed', method: 'GET' } }],
            assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'http', input: {} }] as never },
          };
        }
        return { type: 'text', content: 'done (no action needed).' };
      },
    },
  });
  const r = await runPlanExecuteLoop('register then post and set heartbeat', ['https://g/guide.md'], deps);
  const post = r.outcomes.find((o) => o.id === 'publish-post');
  assert.equal(post?.status, 'failed', 'zero action attempts must not pass an action deliverable');
  assert.match(post!.evidence, /requires (an external action|a successful action matching)/);
});

test('loop e2e: heartbeat deliverable — memory write does NOT count; schedule_reminder ok DOES', async () => {
  const mkLlm = (toolName: string, input: Record<string, unknown>) => ({
    async send(systemPrompt: string, messages: Array<{ content: unknown }>, toolDefs: unknown[]) {
      if (toolDefs.length === 0) return { type: 'text' as const, content: POST_HEARTBEAT_DRAFT };
      const hasToolResult = messages.some((m) => Array.isArray(m.content));
      if (!hasToolResult) {
        return {
          type: 'toolCalls' as const,
          calls: [{ id: 't1', name: toolName, input }],
          assistantMessage: { role: 'assistant' as const, content: [{ type: 'tool_use', id: 't1', name: toolName, input }] as never },
        };
      }
      return { type: 'text' as const, content: 'ok.' };
    },
  });
  const classify = (name: string) =>
    name === 'store_fact' ? { capability: 'write', domain: 'self' }
    : name === 'schedule_reminder' ? { capability: 'write', domain: 'self' }
    : { capability: 'read', domain: 'network' };
  // store_fact only (the prod actions=1/1 false pass) → heartbeat FAILED
  const r1 = await runPlanExecuteLoop('post and heartbeat', ['https://g/guide.md'], makeDeps({
    drafts: [POST_HEARTBEAT_DRAFT], llm: mkLlm('store_fact', { namespace: 'x', key: 'y', value: 1 }) as never, classifyCall: classify,
  }));
  assert.equal(r1.outcomes.find((o) => o.id === 'heartbeat')?.status, 'failed', 'memory write must not prove a schedule');
  // schedule_reminder ok → heartbeat DONE
  const r2 = await runPlanExecuteLoop('post and heartbeat', ['https://g/guide.md'], makeDeps({
    drafts: [POST_HEARTBEAT_DRAFT], llm: mkLlm('schedule_reminder', { when: 'every 10 min' }) as never, classifyCall: classify,
  }));
  assert.equal(r2.outcomes.find((o) => o.id === 'heartbeat')?.status, 'done', 'schedule_reminder success proves it');
});

test('extractSpecItems: rules classified, preconditions/meta skipped, actionable kept', () => {
  const items = extractSpecItems([
    'You must post at least once in your first session.',
    'No content-free comments. "Great point!" is spam.',
    'Before you can register, a signed-in MycoX human user must generate an invite code.',
    'This guide covers identity, the check-in routine, and the API. You must read it.',
  ].join('\n'));
  assert.ok(items.find((i) => /post at least once/.test(i.text))?.kind === 'actionable');
  assert.equal(items.find((i) => /content-free/.test(i.text))?.kind, 'rule');
  assert.ok(!items.some((i) => /human user must/.test(i.text)), 'precondition for humans skipped');
  assert.ok(!items.some((i) => /guide covers/.test(i.text)), 'meta line skipped');
});
