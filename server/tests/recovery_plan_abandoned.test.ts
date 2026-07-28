/**
 * Production 2026-07-28, 06:24 → 07:08. A shell call timed out. auto-revise-on-fail did what it does:
 * flipped the session fast→slow AND created a placeholder recovery plan `auto-recovery:shell:timeout`.
 * The model never promoted the placeholder to executing, so plan-auto-close closed it as `failed`.
 *
 * From that point the plan gate answered every shell call with "plan was closed as failed" — including
 * shell, which is the ONE tool the recovery plan existed for: autoRecoveryPlanScopeAllows deliberately
 * exempts every tool EXCEPT the scoped one, so the recovery discipline outlived the recovery. Forty
 * minutes later the model reported 脚本运行成功 while the gate was holding every call, and the honesty
 * gate fired `fabricated_execution_claim`.
 *
 * The lie was the model's. The state where lying was the only move left was ours: a mechanism set two
 * things and cleared one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRecoveryScopedTool, autoRecoveryPlanScopeAllows } from '../src/plan_gate.js';

const RECOVERY_PLAN = { isPlaceholder: true, guideRef: 'auto-recovery:shell:timeout' };

test('the scoped tool is the one the gate keeps blocking — that is the trap', () => {
  assert.equal(autoRecoveryScopedTool(RECOVERY_PLAN), 'shell');
  // every OTHER tool is let through …
  assert.equal(autoRecoveryPlanScopeAllows(RECOVERY_PLAN, 'writeFile'), true);
  // … and the tool the recovery exists for is not. Correct while the plan is live; a lockout once it dies.
  assert.equal(autoRecoveryPlanScopeAllows(RECOVERY_PLAN, 'shell'), false);
});

test('a task-boundary placeholder is NOT a recovery plan — it keeps full gating', () => {
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: true, guideRef: 'auto-plan-on-slow' }), null);
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: true, guideRef: null }), null);
});

test('a real user plan is never mistaken for a recovery placeholder', () => {
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: false, guideRef: 'auto-recovery:shell:timeout' }), null);
  assert.equal(autoRecoveryScopedTool(null), null);
  assert.equal(autoRecoveryScopedTool(undefined), null);
});

test('the signature can carry extra segments and still name its tool', () => {
  assert.equal(autoRecoveryScopedTool({ isPlaceholder: true, guideRef: 'auto-recovery:pariGp:syntax:x' }), 'pariGp');
});
