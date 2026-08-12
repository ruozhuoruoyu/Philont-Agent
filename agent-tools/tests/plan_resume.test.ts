/**
 * A denial should not cost the work that came before it.
 *
 * A sub-loop has nobody to ask, so running out of authorization ends the plan rather than the
 * sub-task — continuing would spend budget on every downstream step that depends on the one that
 * could not run. But re-running the whole plan after the owner approves is wasteful in a way that
 * matters: the finished steps did real work, sometimes the expensive kind (a Lean compile, a long
 * enumeration), and a fresh decomposition would not even produce the same steps to skip.
 *
 * So the plan is checkpointed at the refusal and resumed from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlanAndExecuteTool,
  PlanBudgetTracker,
  SUBLOOP_AUTH_DENIED,
  type PlanExecCheckpoint,
} from '../src/index.js';
import type { MiniLoopLLMResponse } from '../src/utils/mini-agent-loop.js';

const PLAN = JSON.stringify({
  subTasks: [
    { id: 'st-1', description: 'compile the file', dependsOn: [] },
    { id: 'st-2', description: 'publish the result', dependsOn: ['st-1'] },
    { id: 'st-3', description: 'record a note', dependsOn: ['st-2'] },
  ],
});

/** Plans once, then has each sub-task call `work` exactly once and report. */
function scriptedLlm() {
  return {
    async send(systemPrompt: string, messages: unknown[]): Promise<MiniLoopLLMResponse> {
      if (systemPrompt.includes('subTasks') || JSON.stringify(messages).includes('subTasks')) {
        return { type: 'text', content: PLAN };
      }
      const alreadyCalled = JSON.stringify(messages).includes('tool_result');
      if (alreadyCalled) return { type: 'text', content: 'sub-task finished' };
      return {
        type: 'toolCalls',
        calls: [{ id: `c-${messages.length}`, name: 'work', input: {} }],
        assistantMessage: { role: 'assistant', content: '' } as never,
      };
    },
  };
}

function makeTool(runner: (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; output: string; error?: string }>, store: Map<string, PlanExecCheckpoint>) {
  return createPlanAndExecuteTool({
    llm: scriptedLlm() as never,
    toolRunner: runner,
    toolDefs: [{ name: 'work', description: 'do the step', parameters: '{}' }],
    budgetTracker: new PlanBudgetTracker(),
    checkpoints: {
      load: (task) => store.get(task.trim()) ?? null,
      save: (cp) => { store.set(cp.task.trim(), cp); },
      clear: (task) => { store.delete(task.trim()); },
    },
  });
}

test('a plan blocked on authorization keeps what it already finished', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  const ran: string[] = [];
  let authorized = false;

  const runner = async (_name: string, _input: Record<string, unknown>) => {
    // st-1 runs; st-2 is the publish step and needs an approval nobody has given yet.
    const step = ran.length;
    ran.push(`call-${step}`);
    if (step >= 1 && !authorized) {
      return { ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED} for this sub-task: shell (execute/local)` };
    }
    return { ok: true, output: 'ok' };
  };

  const tool = makeTool(runner, store);
  const first = await tool.execute({ task: 'compile then publish then note' });
  // Not success: the plan was refused. The report is still produced, but the tool result the parent
  // ledger records must say so — see the blocked-result test below.
  assert.equal(first.success, false);

  const cp = store.get('compile then publish then note');
  assert.ok(cp, 'a checkpoint was taken');
  assert.equal(cp!.blockedSubTaskId, 'st-2', 'stopped at the step that was refused');
  assert.match(cp!.blockedReason, new RegExp(SUBLOOP_AUTH_DENIED));
  assert.deepEqual(
    cp!.completed.filter((c) => c.status === 'success').map((c) => c.id),
    ['st-1'],
    'the finished step is carried, not thrown away',
  );
});

test('after the approval, the same call resumes instead of redoing st-1', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  let authorized = false;
  const executed: string[] = [];

  const runner = async () => {
    const step = executed.length;
    if (!authorized && step >= 1) {
      return { ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED} for this sub-task: shell (execute/local)` };
    }
    executed.push(`run-${step}`);
    return { ok: true, output: 'ok' };
  };

  const tool = makeTool(runner, store);
  await tool.execute({ task: 'compile then publish then note' });
  const afterBlock = executed.length;
  assert.equal(afterBlock, 1, 'only st-1 actually ran');

  // The owner approves; the parent model re-issues the same call.
  authorized = true;
  const second = await tool.execute({ task: 'compile then publish then note' });
  assert.equal(second.success, true);
  assert.equal(
    executed.length,
    afterBlock + 2,
    'exactly the two remaining steps ran — st-1 was not repeated',
  );
  assert.equal(store.size, 0, 'a completed plan leaves no checkpoint behind');
});

test('without a checkpoint store the behaviour is exactly as before', async () => {
  const tool = createPlanAndExecuteTool({
    llm: scriptedLlm() as never,
    toolRunner: async () => ({ ok: true, output: 'ok' }),
    toolDefs: [{ name: 'work', description: 'do the step', parameters: '{}' }],
    budgetTracker: new PlanBudgetTracker(),
  });
  const r = await tool.execute({ task: 'compile then publish then note' });
  assert.equal(r.success, true);
});

test('a sub-model writing a tidy summary over a refusal does not make the step done', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  // Denies everything, so the sub-model's own wrap-up text is the only thing suggesting success.
  const tool = makeTool(
    async () => ({ ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED} for this sub-task: shell (execute/local)` }),
    store,
  );
  await tool.execute({ task: 'compile then publish then note' });

  const cp = store.get('compile then publish then note');
  assert.ok(cp, 'the refusal is what decides, not the summary written over it');
  assert.equal(cp!.blockedSubTaskId, 'st-1');
  assert.equal(cp!.completed.filter((c) => c.status === 'success').length, 0);
});

// ── the boundaries the first version did not model ──────────────────────────────────────────────

test('a blocked plan does not report success to the parent', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  const tool = makeTool(
    async () => ({ ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED}: shell` }),
    store,
  );
  const r = await tool.execute({ task: 'compile then publish then note' });

  // The sub-task being marked failed is not enough: the parent's ledger reads THIS.
  assert.equal(r.success, false, 'a refused plan is not a successful tool call');
  assert.match(r.error ?? '', /AUTHORIZATION_REQUIRED/);
  assert.equal((r.data as Record<string, unknown>)?.outcome, 'blocked');
  assert.equal((r.data as Record<string, unknown>)?.resumable, true);
});

test('an ordinary failure that says "not authorized" is not our refusal', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  // An HTTP 401 body. Text-matching would have made this a resumable authorization checkpoint.
  const tool = makeTool(
    async () => ({ ok: false, output: '', error: 'HTTP 401: {"message":"NOT AUTHORIZED — bad api key"}' }),
    store,
  );
  const r = await tool.execute({ task: 'compile then publish then note' });
  assert.equal(store.size, 0, 'no checkpoint: this is the API refusing, not the policy layer');
  assert.notEqual((r.data as Record<string, unknown>)?.outcome, 'blocked');
});

test('a plain failure before the block is not double-counted on resume', async () => {
  const store = new Map<string, PlanExecCheckpoint>();
  let authorized = false;
  let calls = 0;
  // st-1 fails outright (not a policy denial); st-2 is refused; st-3 never runs.
  const tool = makeTool(async () => {
    const n = calls++;
    if (n === 0) return { ok: false, output: '', error: 'compiler said no' };
    if (!authorized) return { ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED}: shell` };
    return { ok: true, output: 'ok' };
  }, store);

  await tool.execute({ task: 'compile then publish then note' });
  authorized = true;
  const second = await tool.execute({ task: 'compile then publish then note' });

  const results = (second.data as { results?: Array<{ id: string }> })?.results ?? [];
  const ids = results.map((r) => r.id);
  assert.deepEqual([...new Set(ids)], ids, `each sub-task appears once, got ${ids.join(',')}`);
});
