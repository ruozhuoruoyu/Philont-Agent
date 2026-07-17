import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLAN_LOOP_BLACKLIST } from '../src/chat-handler.js';

test('plan-loop allows saveCredential (the mandated save-creds deliverable needs it)', () => {
  assert.equal(PLAN_LOOP_BLACKLIST.has('saveCredential'), false);
});

test('plan-loop still blocks everything else the sub-loop must not do', () => {
  for (const t of ['planAndExecute', 'askUserQuestion', 'installSkill', 'removeCredential']) {
    assert.equal(PLAN_LOOP_BLACKLIST.has(t), true, `${t} must stay blacklisted in the plan-loop`);
  }
});

test('the plan-loop tool defs and runner blacklist come from ONE set', () => {
  // The original bug was structural: the defs filter and the runner blacklist were computed separately and
  // disagreed, so the model never saw saveCredential. Guard the invariant at the call site.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('runPlanExecuteLoop(userMessage'));
  const head = call.slice(0, 800);
  assert.ok(/toolDefs[\s\S]*?!PLAN_LOOP_BLACKLIST\.has/.test(head), 'toolDefs must filter by PLAN_LOOP_BLACKLIST');
  assert.ok(/toolBlacklist:\s*PLAN_LOOP_BLACKLIST/.test(head), 'runner must use the same PLAN_LOOP_BLACKLIST');
});
