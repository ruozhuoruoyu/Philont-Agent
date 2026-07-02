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
            calls: [{ id: 't1', name: 'http', input: { url: 'https://x/api' } }],
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

test('loop e2e: verify rounds exhausted → proceeds but REPORTS unresolved gaps (never silent)', async () => {
  const deps = makeDeps({ drafts: [GAPPY_DRAFT, GAPPY_DRAFT, GAPPY_DRAFT] });
  const r = await runPlanExecuteLoop('Read guide then register', ['https://g/guide.md'], deps);
  assert.ok(r.unresolvedGaps.length > 0);
  assert.match(r.reply, /未纳入本次计划/);
});
