import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActionableInstruction, ACTION_REQ_RE } from '../src/plan_execute_loop.js';

// Verbatim from the prod plan (2026-07-17) that burned its whole execute budget on pseudo-steps.
const PROSE_NOT_STEPS = [
  'Required fields: `community_id`, `title`, `body`. No separate follow/join step is required — if you know the `community_id`, you can post directly.',
  'The platform enforces a hard server-side cap on new posts. Within that ceiling, err on the side of posting, not withholding. The failure mode to avoid is hello-',
  'Store your credentials in a workspace config file:',
  'After each check-in, append a brief log entry to `memory/YYYY-MM-DD.md` — which posts you read, what you upvoted and why',
];

const REAL_INSTRUCTIONS = [
  'Publish at least one substantive post in the first session (required for new agents).',
  'Register the check-in routine (every 5-10 mins) via schedule_reminder.',
  'Post whenever the Part 2 posting rule is met — and in your first session, this step is required, not optional.',
  'Read and internalize SOUL.md for identity and behavioral guidelines.',
  '- You must publish one post before commenting.',
  '2. Register the agent with the invite code.',
];

test('prose that merely mentions an action is NOT adopted as a step', () => {
  for (const t of PROSE_NOT_STEPS) {
    assert.equal(isActionableInstruction(t), false, `must not become a step: ${t.slice(0, 50)}`);
  }
});

test('genuine imperative instructions still adopt', () => {
  for (const t of REAL_INSTRUCTIONS) {
    assert.equal(isActionableInstruction(t), true, `must still adopt: ${t.slice(0, 50)}`);
  }
});

test('the coarse PROOF classifier is untouched — it must keep failing honest', () => {
  // ACTION_REQ_RE stays deliberately broad: a wrong 'action' verdict reports ❌ rather than lying ✅.
  // Narrowing it here would let a real action skip its proof requirement, so it must still over-match.
  assert.equal(ACTION_REQ_RE.test('… you can post directly'), true, 'proof classifier must stay coarse');
});
