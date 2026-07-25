/**
 * A recovery plan for X must not confiscate Y.
 *
 * Three production occurrences in 32 hours (2026-07-24 16:46, 17:08, 2026-07-25 00:00), same shape:
 * webFetch 403s twice during a math session → in-turn-tool-block disables webFetch (bleeding stopped) →
 * auto-revise-on-fail creates a placeholder plan sig=webFetch:http-403 → the plan gate then rejects
 * writeFile/shell — the enumeration scripts that had nothing to do with the fetch failure. The third
 * occurrence provoked a fabricated "shell → 跑完" claim about the blocked call. The honesty gate caught
 * the lie, but the provocation was the gate's own collateral scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRecoveryPlanScopeAllows, autoRecoveryScopedTool } from '../src/plan_gate.js';

const recoveryPlan = { isPlaceholder: true, guideRef: 'auto-recovery:webFetch:http-403' };

test('the production shape: a webFetch recovery plan releases shell and writeFile', () => {
  assert.equal(autoRecoveryScopedTool(recoveryPlan), 'webFetch');
  assert.equal(autoRecoveryPlanScopeAllows(recoveryPlan, 'shell'), true);
  assert.equal(autoRecoveryPlanScopeAllows(recoveryPlan, 'writeFile'), true);
});

test('the failing tool itself stays gated — the discipline still applies where it was earned', () => {
  assert.equal(autoRecoveryPlanScopeAllows(recoveryPlan, 'webFetch'), false);
});

test('a task-boundary placeholder (auto-plan-on-slow) keeps full gating — that one IS the protocol', () => {
  const taskPlaceholder = { isPlaceholder: true, guideRef: 'https://example.com/guide.md' };
  assert.equal(autoRecoveryScopedTool(taskPlaceholder), null);
  assert.equal(autoRecoveryPlanScopeAllows(taskPlaceholder, 'shell'), false);
});

test('a promoted (non-placeholder) plan and no plan at all are out of scope', () => {
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: false, guideRef: 'auto-recovery:shell:exit-1' }), null);
  assert.equal(autoRecoveryPlanScopeAllows(null, 'shell'), false);
  assert.equal(autoRecoveryPlanScopeAllows(undefined, 'shell'), false);
});

test('a closed recovery plan does not haunt the next tool either — scope survives status changes', () => {
  // plan-auto-close flips the placeholder to failed while the turn continues; the failed recovery plan
  // must not re-confiscate unrelated tools through the "closed plan → draft a new one" branch.
  const closed = { isPlaceholder: true, guideRef: 'auto-recovery:webFetch:http-403', status: 'failed' };
  assert.equal(autoRecoveryPlanScopeAllows(closed, 'shell'), true);
});

test('a malformed guideRef degrades to full gating, never to a free-for-all', () => {
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: true, guideRef: 'auto-recovery:' }), null);
  assert.equal(autoRecoveryPlanScopeAllows({ isPlaceholder: true, guideRef: 'auto-recovery:' }, 'shell'), false);
});
