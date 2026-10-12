import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBlockingRule,
  patternMatchesCall,
  readbackSatisfied,
  toolNameMatches,
  validateRuleInput,
} from '../src/plan_rules.js';
import type { Plan, PlanStep } from '../src/types.js';

test('toolNameMatches: exact names and * globs only', () => {
  assert.equal(toolNameMatches('jira__create_issue', 'jira__create_issue'), true);
  assert.equal(toolNameMatches('jira__*', 'jira__create_issue'), true);
  assert.equal(toolNameMatches('*__send_*', 'google_mail__send_email'), true);
  assert.equal(toolNameMatches('jira__create', 'jira__create_issue'), false, 'no implicit prefix match');
  assert.equal(toolNameMatches('', 'x'), false);
});

test('patternMatchesCall: args regex runs over the JSON input; invalid regex never matches', () => {
  assert.equal(patternMatchesCall({ tool: 'jira__create_issue', args: 'OFFBOARD' }, 'jira__create_issue', { summary: 'OFFBOARD-Navarro' }), true);
  assert.equal(patternMatchesCall({ tool: 'jira__create_issue', args: 'OFFBOARD' }, 'jira__create_issue', { summary: 'ONBOARD-Yoon' }), false);
  assert.equal(patternMatchesCall({ tool: 'jira__create_issue', args: '[' }, 'jira__create_issue', { summary: 'OFFBOARD' }), false);
  assert.equal(patternMatchesCall({ tool: 'jira__create_issue' }, 'jira__create_issue', 'raw string input'), true);
});

function planWith(steps: PlanStep[], status: Plan['status'] = 'executing'): Plan {
  return {
    id: 'p', sessionId: 's', taskSignature: null, steps, deliverables: [], deliverableStatus: null, status,
    reviewHistory: [], isPlaceholder: false, persistedTo: null, guideRef: null, outcomeSummary: null,
    innerIter: 0, outerIter: 0, createdAt: 1, updatedAt: 1, completedAt: null,
  };
}
const step = (id: string, kind: PlanStep['kind'], rule: PlanStep['rule']): PlanStep =>
  ({ id, description: id, status: 'pending', covers: [], evidence: null, startedAt: null, completedAt: null, kind, rule });

test('findBlockingRule: forbid always; guard until satisfied; closed plans never block', () => {
  const forbid = step('f', 'forbid', { applies: [{ tool: 'jira__*', args: 'OFFBOARD' }], condition: 'never offboard without authorization' });
  const guard = step('g', 'guard', { applies: [{ tool: 'google_mail__send_email' }], condition: 'approval on file', resolution: null });
  const plan = planWith([forbid, guard]);
  assert.equal(findBlockingRule(plan, 'jira__create_issue', { summary: 'OFFBOARD-1' })?.why, 'forbidden');
  assert.equal(findBlockingRule(plan, 'jira__create_issue', { summary: 'ONBOARD-1' }), null);
  assert.equal(findBlockingRule(plan, 'google_mail__send_email', {})?.why, 'unresolved');
  guard.rule!.resolution = 'not_satisfied';
  assert.equal(findBlockingRule(plan, 'google_mail__send_email', {})?.why, 'not_satisfied');
  guard.rule!.resolution = 'satisfied';
  assert.equal(findBlockingRule(plan, 'google_mail__send_email', {}), null);
  assert.equal(findBlockingRule(planWith([forbid], 'completed'), 'jira__create_issue', { summary: 'OFFBOARD-1' }), null);
});

test('readbackSatisfied: a successful matching call at or after sinceTs', () => {
  const ev = step('e', 'evidence', { applies: [{ tool: 'jira__search', args: 'ONBOARD' }], condition: 'issue exists' });
  const trace = [
    { toolName: 'jira__search', input: { jql: 'ONBOARD' }, success: true, at: 5 },
    { toolName: 'jira__search', input: { jql: 'ONBOARD' }, success: false, at: 20 },
  ];
  assert.equal(readbackSatisfied(ev, trace, 1)?.at, 5);
  assert.equal(readbackSatisfied(ev, trace, 10), null, 'the later call failed; the earlier one is before sinceTs');
});

test('validateRuleInput: kinds without rules pass; rule kinds need applies + condition', () => {
  assert.equal(validateRuleInput('step', undefined, 'x'), null);
  assert.ok(validateRuleInput('guard', undefined, 'x'));
  assert.ok(validateRuleInput('guard', { applies: [], condition: 'needs approval' }, 'x'));
  assert.ok(validateRuleInput('guard', { applies: [{ tool: 'a' }], condition: 'ok?' }, 'x'), 'condition too short');
  assert.ok(validateRuleInput('evidence', { applies: [{ tool: 'a', args: '(' }], condition: 'record exists' }, 'x'));
  assert.equal(validateRuleInput('forbid', { applies: [{ tool: 'jira__*', args: 'OFFBOARD' }], condition: 'never offboard' }, 'x'), null);
});
