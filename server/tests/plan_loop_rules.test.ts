/**
 * Plan protocol v2 — typed rule items in the mechanism loop.
 *
 *   1. parseRules: kinds, unknown tool names (with nearest-name hints), bad regexes → problems, not drops.
 *   2. findRuleBlock: forbid always refuses; guard refuses until resolved satisfied; not_satisfied keeps refusing.
 *   3. findReadback / verdict parsers.
 *   4. runPlanExecuteLoop end-to-end with fake deps:
 *      - a forbid rule refuses the model's prohibited call → the deliverable is FAILED, the reply says so;
 *      - a guard is RESOLVED satisfied by a read-only sub-run → the gated call is allowed;
 *      - an evidence rule: the step writes and reads back → judge yes → verified; judge no → FAILED;
 *      - a step that never reads back gets one forced readback;
 *      - LOCATE: no guide URL → the guide is read from a document tool and drives coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findReadback,
  findRuleBlock,
  nearestTools,
  parseGuardVerdict,
  parseReadbackVerdict,
  parseRules,
  RESOLVE_SYSTEM,
  READBACK_SYSTEM,
  type LoopRule,
} from '../src/plan_loop_rules.js';
import { parseDraftJson, runPlanExecuteLoop, type PlanLoopDeps } from '../src/plan_execute_loop.js';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const TOOLS = new Set(['jira__create_issue', 'jira__search', 'google_mail__send_email', 'google_mail__search_emails', 'handbook__readFile']);

test('parseRules: kinds, unknown tools and bad regexes are reported as problems', () => {
  const r = parseRules([
    { id: 'no-offboard', kind: 'forbid', condition: 'never offboard without written authorization', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }] },
    { id: 'typo', kind: 'guard', condition: 'sender is authorized', applies: [{ tool: 'jira_create_issue' }] },
    { id: 'badre', kind: 'evidence', condition: 'the welcome email exists', applies: [{ tool: 'google_mail__search_emails', args: '[' }] },
    { id: 'x', kind: 'wish', condition: 'nothing', applies: [{ tool: 'jira__search' }] },
  ], TOOLS, new Set(['onboard']), slug);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].id, 'no-offboard');
  assert.equal(r.problems.length, 3);
  assert.ok(r.problems.some((p) => p.includes('typo') && p.includes('jira__create_issue')), 'nearest real name offered');
  assert.ok(r.problems.some((p) => /regular expression/.test(p)));
  assert.ok(r.problems.some((p) => /kind must be one of/.test(p)));
  assert.deepEqual(nearestTools('jira_create', TOOLS, 1), ['jira__create_issue']);
});

test('findRuleBlock: forbid always; guard until satisfied; not_satisfied keeps refusing', () => {
  const forbid: LoopRule = { id: 'f', kind: 'forbid', condition: 'c', applies: [{ tool: 'jira__*', args: 'OFFBOARD' }], covers: [] };
  const guard: LoopRule = { id: 'g', kind: 'guard', condition: 'written authorization on file', applies: [{ tool: 'google_mail__send_email' }], covers: [] };
  assert.equal(findRuleBlock([forbid], 'jira__create_issue', { summary: 'OFFBOARD-x' })?.why, 'forbidden');
  assert.equal(findRuleBlock([forbid], 'jira__create_issue', { summary: 'ONBOARD-x' }), null, 'args regex must match');
  assert.equal(findRuleBlock([guard], 'google_mail__send_email', {})?.why, 'unresolved');
  guard.resolution = 'not_satisfied';
  assert.equal(findRuleBlock([guard], 'google_mail__send_email', {})?.why, 'not_satisfied');
  guard.resolution = 'satisfied';
  assert.equal(findRuleBlock([guard], 'google_mail__send_email', {}), null);
});

test('findReadback + verdict parsers', () => {
  const ev: LoopRule = { id: 'e', kind: 'evidence', condition: 'c', applies: [{ tool: 'jira__search', args: 'ONBOARD' }], covers: ['d'] };
  const trace = [
    { toolName: 'jira__create_issue', input: { summary: 'ONBOARD-1' }, success: true, at: 1, output: 'ok' },
    { toolName: 'jira__search', input: { jql: 'summary ~ ONBOARD' }, success: false, at: 2, output: '' },
    { toolName: 'jira__search', input: { jql: 'summary ~ ONBOARD' }, success: true, at: 3, output: '{"issues":[1]}' },
  ];
  assert.equal(findReadback(ev, trace, 1)?.at, 3, 'the successful read after the write');
  assert.equal(findReadback(ev, trace, 4), null);
  assert.equal(parseGuardVerdict('I looked.\nVERDICT: NOT_SATISFIED — no approval email'), 'not_satisfied');
  assert.equal(parseGuardVerdict('VERDICT: SATISFIED — approval id 12'), 'satisfied');
  assert.equal(parseGuardVerdict('probably fine'), 'unresolved');
  assert.equal(parseReadbackVerdict('Yes — the record is there.'), 'yes');
  assert.equal(parseReadbackVerdict('no'), 'no');
  assert.equal(parseReadbackVerdict('maybe'), 'unclear');
});

test('parseDraftJson carries rules and problems', () => {
  const d = parseDraftJson(JSON.stringify({
    deliverables: [{ id: 'onboard', description: 'onboard the new hire' }],
    steps: [{ id: 's1', description: 'create the issue', covers: ['onboard'] }],
    rules: [{ id: 'ev', kind: 'evidence', condition: 'issue exists', applies: [{ tool: 'jira__search' }], covers: ['onboard'] },
            { id: 'bad', kind: 'forbid', condition: 'x', applies: [{ tool: 'nope__tool' }] }],
  }), TOOLS);
  assert.ok(d);
  assert.equal(d!.rules!.length, 1);
  assert.equal(d!.ruleProblems!.length, 1);
});

// ── End-to-end fakes ─────────────────────────────────────────────────────────

const GUIDE = [
  '# HR handbook',
  'You MUST create the onboarding issue for every new hire.',
  'Never execute an offboarding unless written authorization from the department head is on file.',
].join('\n');

interface Script {
  draft: string;
  /** EXECUTE: tool calls to make before claiming done (per step, in order). */
  execCalls: Array<{ name: string; input: Record<string, unknown> }>;
  resolveText?: string;
  resolveReads?: boolean;
  readbackCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  locateCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

function fakeDeps(script: Script, opts: { judge?: 'yes' | 'no' | 'unclear'; toolOutputs?: Record<string, string>; classify?: boolean } = {}): PlanLoopDeps & { lines: string[] } {
  const lines: string[] = [];
  const outputs = opts.toolOutputs ?? {};
  const phaseCalls = new Map<string, number>();
  const mk = (calls: Array<{ name: string; input: Record<string, unknown> }>, done: string, key: string) => {
    const i = phaseCalls.get(key) ?? 0;
    phaseCalls.set(key, i + 1);
    if (i < calls.length) {
      const c = calls[i];
      return {
        type: 'toolCalls' as const,
        calls: [{ id: `${key}-${i}`, name: c.name, input: c.input }],
        assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: `${key}-${i}`, name: c.name, input: c.input }] as never },
      };
    }
    return { type: 'text' as const, content: done };
  };
  return {
    lines,
    llm: {
      async send(systemPrompt, messages, toolDefs) {
        if (toolDefs.length === 0) return { type: 'text', content: script.draft };
        if (systemPrompt === RESOLVE_SYSTEM) {
          return mk(script.resolveReads === false ? [] : [{ name: 'google_mail__search_emails', input: { q: 'authorization' } }], script.resolveText ?? 'VERDICT: SATISFIED — found it', 'resolve');
        }
        if (systemPrompt === READBACK_SYSTEM) return mk(script.readbackCalls ?? [{ name: 'jira__search', input: { jql: 'ONBOARD' } }], 'read back.', 'readback');
        if (/Find and read IN FULL/.test(systemPrompt)) return mk(script.locateCalls ?? [], 'read the handbook.', 'locate');
        // EXECUTE: one mini-loop per step; the message count tells us where we are inside the step.
        const stepKey = `exec:${String((messages[0] as { content: string }).content).slice(0, 40)}`;
        return mk(script.execCalls, 'step done.', stepKey);
      },
    },
    toolRunner: async (name) => ({ ok: true, output: outputs[name] ?? `${name} ok` }),
    toolDefs: ['jira__create_issue', 'jira__search', 'google_mail__send_email', 'google_mail__search_emails', 'handbook__readFile']
      .map((n) => ({ name: n, description: n, parameters: '{}' })),
    toolBlacklist: new Set<string>(),
    classifyCall: opts.classify === false ? undefined : (name) => ({
      capability: /search|read|get|list/.test(name) ? 'read' : 'write',
      domain: 'network',
    }),
    fetchGuide: async () => GUIDE,
    readbackJudge: async () => opts.judge ?? 'yes',
    log: (m) => { lines.push(m); },
    maxVerifyRounds: 1,
    deadlineMs: 10 * 60_000,
  } as PlanLoopDeps & { lines: string[] };
}

const DRAFT = (rules: unknown[]) => JSON.stringify({
  deliverables: [
    { id: 'onboard', description: 'create the onboarding issue for the new hire' },
    { id: 'offboard', description: 'execute the offboarding the email asks for' },
  ],
  steps: [
    { id: 'do-onboard', description: 'create the onboarding issue with jira__create_issue', covers: ['onboard'] },
    { id: 'do-offboard', description: 'create the offboarding issue', covers: ['offboard'] },
  ],
  rules,
});

test('loop: a forbid rule refuses the prohibited call; the deliverable is FAILED and the reply says so', async () => {
  const deps = fakeDeps({
    draft: DRAFT([{ id: 'no-offboard', kind: 'forbid', condition: 'never execute an offboarding unless written authorization is on file', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }] }]),
    execCalls: [{ name: 'jira__create_issue', input: { summary: 'OFFBOARD-Navarro' } }],
  });
  const r = await runPlanExecuteLoop('Handle today\'s emails per the SOP', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /rule-forbid BLOCKED jira__create_issue/.test(l)), deps.lines.join('\n'));
  const off = r.outcomes.find((o) => o.id === 'offboard');
  assert.equal(off?.status, 'failed');
  assert.notEqual(r.outcome, 'completed');
});

test('loop: a guard resolved satisfied by a read-only sub-run lets the gated call through', async () => {
  const deps = fakeDeps({
    draft: DRAFT([{ id: 'authz', kind: 'guard', condition: 'written authorization from the department head is on file', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }], covers: ['offboard'] }]),
    execCalls: [{ name: 'jira__create_issue', input: { summary: 'OFFBOARD-Navarro' } }],
    resolveText: 'VERDICT: SATISFIED — authorization email id 9',
  });
  const r = await runPlanExecuteLoop('Handle today\'s emails per the SOP', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /RESOLVE authz \(at-action \(jira__create_issue\)\): satisfied/.test(l)), deps.lines.join('\n'));
  assert.ok(!deps.lines.some((l) => /rule-guard BLOCKED/.test(l)));
  assert.equal(r.outcomes.find((o) => o.id === 'offboard')?.status, 'done');
});

test('loop: a guard with no successful read is unresolved and keeps refusing; not_satisfied too', async () => {
  const deps = fakeDeps({
    draft: DRAFT([{ id: 'authz', kind: 'guard', condition: 'written authorization on file', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }], covers: ['offboard'] }]),
    execCalls: [{ name: 'jira__create_issue', input: { summary: 'OFFBOARD-Navarro' } }],
    resolveText: 'VERDICT: SATISFIED — trust me',
    resolveReads: false,
  });
  const r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /RESOLVE authz \(at-action \(jira__create_issue\)\): unresolved/.test(l)), 'a verdict without a read is unresolved');
  assert.ok(deps.lines.some((l) => /rule-guard BLOCKED jira__create_issue \(authz: unresolved\)/.test(l)));
  assert.equal(r.outcomes.find((o) => o.id === 'offboard')?.status, 'failed');
  assert.ok(/authz/.test(r.reply), 'the reply names the unverified guard');
});

test('loop: evidence rule — readback judged yes → verified; judged no → FAILED; missing readback is forced once', async () => {
  const rules = [{ id: 'issue-exists', kind: 'evidence', condition: 'an ONBOARD issue exists for the new hire', applies: [{ tool: 'jira__search', args: 'ONBOARD' }], covers: ['onboard'] }];
  // (a) the model reads back itself
  let deps = fakeDeps({ draft: DRAFT(rules), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }, { name: 'jira__search', input: { jql: 'ONBOARD' } }] }, { judge: 'yes' });
  let r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.equal(r.outcomes.find((o) => o.id === 'onboard')?.verified, true);
  assert.ok(!deps.lines.some((l) => /forcing one/.test(l)));
  // (b) no readback in the step → forced readback → judge yes
  deps = fakeDeps({ draft: DRAFT(rules), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }] }, { judge: 'yes' });
  r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /no readback for issue-exists — forcing one/.test(l)), deps.lines.join('\n'));
  assert.equal(r.outcomes.find((o) => o.id === 'onboard')?.verified, true);
  // (c) readback judged no → failed even though the write returned ok
  deps = fakeDeps({ draft: DRAFT(rules), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }, { name: 'jira__search', input: { jql: 'ONBOARD' } }] }, { judge: 'no' });
  r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  const o = r.outcomes.find((x) => x.id === 'onboard');
  assert.equal(o?.status, 'failed');
  assert.ok(/does not show/.test(o!.evidence));
});

test('loop: LOCATE reads the guide from a document tool when no URL is given', async () => {
  const doc = `# Handbook\n${'You MUST create the onboarding issue for every new hire. '.repeat(40)}`;
  const deps = fakeDeps(
    { draft: DRAFT([]), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }], locateCalls: [{ name: 'handbook__readFile', input: { path: '/workdir/sop.html' } }] },
    { toolOutputs: { handbook__readFile: doc } },
  );
  deps.fetchGuide = async () => null;
  const r = await runPlanExecuteLoop('Handle the emails according to the provided SOP', [], deps);
  assert.ok(deps.lines.some((l) => /LOCATE: 1 document\(s\) read/.test(l)), deps.lines.join('\n'));
  assert.notEqual(r.outcome, 'aborted');
});

test('loop: an execute-class REPL is both write and readback — a call matching the evidence pattern is not the "last write"', async () => {
  const rules = [{ id: 'row-exists', kind: 'evidence', condition: 'the roster shows the new row', applies: [{ tool: 'shell', args: 'show_rows|print\\(rows' }], covers: ['onboard'] }];
  const deps = fakeDeps({
    draft: JSON.stringify({ deliverables: [{ id: 'onboard', description: 'add the new hire row' }], steps: [{ id: 's', description: 'add via shell', covers: ['onboard'] }], rules }),
    execCalls: [{ name: 'shell', input: { command: 'aw exec add_row()' } }, { name: 'shell', input: { command: 'aw exec print(rows)' } }],
  }, { judge: 'yes' });
  deps.toolDefs = [{ name: 'shell', description: 'run a command', parameters: '{}' }];
  deps.classifyCall = () => ({ capability: 'execute', domain: 'local' });
  const r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.equal(r.outcomes[0].status, 'done', deps.lines.join('\n'));
  assert.equal(r.outcomes[0].verified, true);
  assert.ok(!deps.lines.some((l) => /forcing one/.test(l)), 'the model\'s own readback counted');
});


test('parseRules: a guard/forbid pattern with no args covering much of the tool list is too broad', () => {
  const r = parseRules([
    { id: 'no-ask', kind: 'forbid', condition: 'do not ask the user anything', applies: [{ tool: '*' }] },
    { id: 'jira-only', kind: 'forbid', condition: 'never touch jira without a ticket', applies: [{ tool: 'jira__*' }] },
    { id: 'broad-but-filtered', kind: 'forbid', condition: 'never send offboarding notices', applies: [{ tool: '*', args: 'OFFBOARD' }] },
  ], TOOLS, new Set(), slug);
  assert.deepEqual(r.rules.map((x) => x.id), ['jira-only', 'broad-but-filtered']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /no-ask.*covers 5 of 5 tools/);
});

test('loop: the rule judge clears a pattern match only with a definite "no"; "unclear" keeps the block', async () => {
  const rules = [{ id: 'own-work', kind: 'forbid', condition: 'act fully on your own', applies: [{ tool: 'jira__create_issue' }] }];
  for (const [verdict, expectBlocked] of [['no', false], ['unclear', true]] as const) {
    const deps = fakeDeps({ draft: DRAFT(rules), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }] });
    const asked: string[] = [];
    deps.ruleJudge = async (kind, condition, tool) => { asked.push(`${kind}:${tool}`); return verdict; };
    const r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
    assert.ok(asked.includes('forbid:jira__create_issue'), 'the judge saw the concrete call');
    assert.equal(deps.lines.some((l) => /rule-forbid BLOCKED/.test(l)), expectBlocked, deps.lines.join('\n'));
    if (!expectBlocked) assert.equal(r.outcomes.find((o) => o.id === 'onboard')?.status, 'done');
  }
});

test('loop: a guard is re-checked at each gated attempt (the world changed since the last check)', async () => {
  const deps = fakeDeps({
    draft: DRAFT([{ id: 'after-work', kind: 'guard', condition: 'complete only after the onboarding issue exists', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }], covers: ['offboard'] }]),
    execCalls: [{ name: 'jira__create_issue', input: { summary: 'OFFBOARD-x' } }, { name: 'jira__create_issue', input: { summary: 'OFFBOARD-x' } }],
  }, { judge: 'unclear' });
  // The first check says NOT_SATISFIED (call refused), the second says SATISFIED (call allowed).
  let resolveRuns = 0;
  const base = deps.llm.send.bind(deps.llm);
  deps.llm = {
    async send(system, messages, toolDefs, opts) {
      if (system === RESOLVE_SYSTEM) {
        const first = !messages.some((m) => Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'));
        if (first) {
          resolveRuns++;
          return { type: 'toolCalls', calls: [{ id: `r${resolveRuns}`, name: 'jira__search', input: { jql: 'ONBOARD' } }],
            assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id: `r${resolveRuns}`, name: 'jira__search', input: {} }] as never } };
        }
        return { type: 'text', content: resolveRuns === 1 ? 'VERDICT: NOT_SATISFIED — no issue yet' : 'VERDICT: SATISFIED — issue ONBOARD-1 found' };
      }
      return base(system, messages, toolDefs, opts);
    },
  };
  const r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /RESOLVE after-work \(at-action \(jira__create_issue\)\): not_satisfied/.test(l)), deps.lines.join('\n'));
  assert.ok(deps.lines.some((l) => /RESOLVE after-work \(at-action \(jira__create_issue\)\): satisfied/.test(l)));
  assert.equal(deps.lines.filter((l) => /rule-guard BLOCKED/.test(l)).length, 1);
  assert.equal(r.outcomes.find((o) => o.id === 'offboard')?.status, 'done');
});

test('loop: past the per-step refusal budget the sub-run is told to stop', async () => {
  // Alternate two forbidden tools so the mini-loop's own same-failure breaker (3 identical failures) does not fire first.
  const many = Array.from({ length: 7 }, (_, i) => (i % 2 === 0
    ? { name: 'jira__create_issue', input: { summary: `OFFBOARD-${i}` } }
    : { name: 'google_mail__send_email', input: { subject: `OFFBOARD notice ${i}` } }));
  const deps = fakeDeps({
    draft: JSON.stringify({ deliverables: [{ id: 'offboard', description: 'execute the offboarding' }], steps: [{ id: 's', description: 'offboard', covers: ['offboard'] }],
      rules: [{ id: 'no-off', kind: 'forbid', condition: 'never offboard without written authorization',
        applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }, { tool: 'google_mail__send_email', args: 'OFFBOARD' }] }] }),
    execCalls: many,
  });
  await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  // The budget is per step: inside the first step exactly 4 refusals, then the STOP message (not logged as a refusal).
  const firstStepEnd = deps.lines.findIndex((l) => /EXECUTE s: tools=/.test(l));
  const blocked = deps.lines.slice(0, firstStepEnd).filter((l) => /rule-forbid BLOCKED/.test(l)).length;
  assert.equal(blocked, 4, deps.lines.join('\n'));
});

test('loop: a guard already shown by tool output gathered this turn is satisfied without a sub-run', async () => {
  const draft = JSON.stringify({
    deliverables: [{ id: 'look', description: 'search the onboarding issue' }, { id: 'offboard', description: 'execute the offboarding' }],
    steps: [{ id: 's1', description: 'search with jira__search', covers: ['look'] }, { id: 's2', description: 'offboard', covers: ['offboard'] }],
    rules: [{ id: 'authz', kind: 'guard', condition: 'written authorization is on file', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }], covers: ['offboard'] }],
  });
  const deps = fakeDeps({ draft, execCalls: [{ name: 'jira__search', input: { jql: 'x' } }, { name: 'jira__create_issue', input: { summary: 'OFFBOARD-1' } }] },
    { judge: 'yes', toolOutputs: { jira__search: 'AUTH-7: written authorization from the department head' } });
  let resolveCalls = 0;
  const base = deps.llm.send.bind(deps.llm);
  deps.llm = { async send(system, m, t, o) { if (system === RESOLVE_SYSTEM) resolveCalls++; return base(system, m, t, o); } };
  const r = await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.ok(deps.lines.some((l) => /RESOLVE authz .*satisfied — shown by tool output already gathered/.test(l)), deps.lines.join('\n'));
  assert.equal(resolveCalls, 0);
  assert.equal(r.outcomes.find((o) => o.id === 'offboard')?.status, 'done');
});

test('loop: tools the plan forbids outright are not offered to a guard sub-run; with none left the guard is unresolved at once', async () => {
  const rules = [
    { id: 'authz', kind: 'guard', condition: 'written authorization is on file', applies: [{ tool: 'jira__create_issue', args: 'OFFBOARD' }], covers: ['offboard'] },
    { id: 'no-search', kind: 'forbid', condition: 'use only the issue tracker create call', applies: [{ tool: 'jira__search' }, { tool: 'google_mail__search_emails' }, { tool: 'handbook__readFile' }] },
  ];
  const deps = fakeDeps({ draft: DRAFT(rules), execCalls: [{ name: 'jira__create_issue', input: { summary: 'OFFBOARD-1' } }] }, { judge: 'unclear' });
  let resolveCalls = 0;
  const base = deps.llm.send.bind(deps.llm);
  deps.llm = { async send(system, m, t, o) { if (system === RESOLVE_SYSTEM) resolveCalls++; return base(system, m, t, o); } };
  await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  assert.equal(resolveCalls, 0, deps.lines.join('\n'));
  assert.ok(deps.lines.some((l) => /RESOLVE authz .*unresolved — no read tool is available/.test(l)), deps.lines.join('\n'));
});

test('loop: every loop log line carries its elapsed time', async () => {
  const deps = fakeDeps({ draft: DRAFT([]), execCalls: [{ name: 'jira__create_issue', input: { summary: 'ONBOARD-1' } }] });
  await runPlanExecuteLoop('task', ['https://x/guide'], deps);
  const loopLines = deps.lines.filter((l) => l.startsWith('[plan-loop'));
  assert.ok(loopLines.length > 0 && loopLines.every((l) => /^\[plan-loop \+\d+s\]/.test(l)), loopLines.join('\n'));
});
