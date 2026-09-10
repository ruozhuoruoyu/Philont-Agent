import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_TOKEN_BUDGET,
  EXPLORE_BUDGET_GRANT_TOKENS,
  exploreBudgetCeiling,
  exploreBudgetExhausted,
  exploreBudgetNotice,
} from '../src/explore_budget.js';
import { classifyGrantReply } from '../src/research_grant.js';

test('the ceiling is the lifetime budget plus whatever the owner granted', () => {
  // Prod: budget_spent=300614 against a constant 300000, with no column that could ever raise it.
  const spent = { budgetSpent: 300_614, budgetGranted: 0 };
  assert.equal(exploreBudgetExhausted(spent), true);
  assert.equal(exploreBudgetCeiling(spent), SESSION_TOKEN_BUDGET);
  const granted = { budgetSpent: 300_614, budgetGranted: EXPLORE_BUDGET_GRANT_TOKENS };
  assert.equal(exploreBudgetExhausted(granted), false, 'one grant reopens the session');
  assert.equal(exploreBudgetCeiling(granted), SESSION_TOKEN_BUDGET + EXPLORE_BUDGET_GRANT_TOKENS);
  // Rows written before v46 arrive without the field; they are not granted anything by accident.
  assert.equal(exploreBudgetExhausted({ budgetSpent: 300_614 }), true);
  assert.equal(exploreBudgetExhausted({ budgetSpent: 10, budgetGranted: -5 }), false, 'a negative grant cannot lower the ceiling');
});

test('the budget card offers exactly the words the grant matcher answers', () => {
  // This text IS the interface — pushed to the owner, returned to the model, printed on 继续. Every
  // word it offers has to land in classifyGrantReply, or the owner is handed a dead end again.
  const s = { budgetSpent: 300_614, budgetGranted: 0, goal: '写严格证明，我来跑lean' };
  const zh = exploreBudgetNotice(s, 'zh');
  assert.match(zh, /300614\/300000/);
  assert.match(zh, /同意/); assert.match(zh, /拒绝/);
  assert.equal(classifyGrantReply('同意'), 'grant');
  assert.equal(classifyGrantReply('拒绝'), 'deny');
  assert.doesNotMatch(zh, /需要明确调整预算/, 'must not name an action that does not exist');
  const en = exploreBudgetNotice(s, 'en');
  assert.match(en, /approve/); assert.match(en, /reject/);
  assert.equal(classifyGrantReply('approve'), 'grant');
  assert.equal(classifyGrantReply('reject'), 'deny');
  assert.match(en, new RegExp(String(EXPLORE_BUDGET_GRANT_TOKENS)), 'the card says what one approve buys');
});
