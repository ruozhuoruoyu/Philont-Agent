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

test('the spec switch is honoured on BOTH http paths, not just the plan loop', () => {
  // Prod 2026-07-20: the plan loop logged `spec: OFF` and a scheduled turn on the legacy dispatch path was
  // still blocked by rejected_by_spec_request_guard minutes later — the decision had been executed halfway.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /specCompileEnabled\(\)\s*\?\s*findSpecForHost\(specHost, skillsRoot\)\s*:\s*null/,
    'the legacy/scheduled dispatch must gate the installed spec on the same switch',
  );
});

test('the host-drift guard stays ungated — the one error the service cannot report', () => {
  // A wrong host surfaces only as an opaque `fetch failed`, so this check is kept regardless of the switch.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('specHostDriftGuard('), src.indexOf('specHostDriftGuard(') + 120);
  assert.doesNotMatch(call, /specCompileEnabled/, 'host drift must not be switched off with the contract');
});
