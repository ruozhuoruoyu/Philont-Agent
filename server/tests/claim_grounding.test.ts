/**
 * The claim-grounding chain replaces four gates that were each hand-wired at some subset of the three
 * places a turn emits final text. What these tests pin is not the detection logic — that lives in the
 * four rule modules and has its own tests — but the properties the MERGE is supposed to buy:
 *
 *   · every rule is reachable from one call, so no exit can be missing one;
 *   · at most one finding per evaluation, so a turn regenerates once instead of up to three times;
 *   · the pre-merge precedence is preserved;
 *   · a rule that throws costs nothing;
 *   · the announced-tool window reports a miss instead of swallowing it.
 *
 * Aux-backed rules (session_claim, announced_tool) return "unknown"/"judge_unavailable" with no aux
 * configured, which is the CI condition — so these exercise the deterministic rules and the chain shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaimGrounding, isGroundingFire, type ClaimGroundingContext } from '../src/claim_grounding.js';

const BASE: ClaimGroundingContext = {
  text: '',
  toolResults: [],
  messages: [],
  toolNames: [],
  calledToolNames: [],
  hasActiveReasoningSession: false,
  deepExploreSucceededThisTurn: false,
};

const ctx = (over: Partial<ClaimGroundingContext>): ClaimGroundingContext => ({ ...BASE, ...over });

test('an unbacked computation claim is caught through the chain', async () => {
  const f = await evaluateClaimGrounding(
    ctx({ text: 'k=10 完成！11 个子集全部通过，最小孤独距离 = 1/11。' }),
  );
  assert.equal(f?.rule, 'numeric_grounding');
  assert.ok(isGroundingFire(f));
  assert.equal(f?.armsCouldNotVerify, true);
});

test('the same claim backed by a successful compute tool passes the chain', async () => {
  const f = await evaluateClaimGrounding(
    ctx({
      text: 'k=10 完成！11 个子集全部通过，最小孤独距离 = 1/11。',
      toolResults: [{ toolName: 'pariGp', content: '✓ ALL PASS best_min = 1/11' }],
    }),
  );
  assert.equal(f, null);
});

test('an ungrounded arXiv id is caught, and outranks a numeric claim in the same draft', async () => {
  const both =
    '按 arXiv:2504.21801 的结论，k=10 完成！11 个子集全部通过，最小孤独距离 = 1/11。';
  const f = await evaluateClaimGrounding(ctx({ text: both }));
  // Pre-merge order: citation ran before numeric in the tool loop. One draft, one directive.
  assert.equal(f?.rule, 'citation_grounding');
  assert.equal(f?.claim, '2504.21801');
});

test('an arXiv id the user actually supplied is grounded', async () => {
  const f = await evaluateClaimGrounding(
    ctx({
      text: '按 arXiv:2504.21801 的结论继续。',
      messages: [{ role: 'user', content: '看看 arXiv:2504.21801 这篇' }],
    }),
  );
  assert.equal(f, null);
});

test('the announced-tool window reports a miss rather than swallowing it', async () => {
  const f = await evaluateClaimGrounding(
    ctx({ text: 'Calling deep_explore status to see the frontier.', toolNames: ['deep_explore'] }),
  );
  assert.equal(f?.rule, 'announced_tool');
  // No aux in CI → no verdict → log-only. A log-only finding must NOT be treated as a fire.
  assert.equal(isGroundingFire(f), false);
  assert.match(f!.log, /judge_unavailable/);
});

test('a tool that WAS called this turn is not a stall', async () => {
  const f = await evaluateClaimGrounding(
    ctx({
      text: 'Calling deep_explore status to see the frontier.',
      toolNames: ['deep_explore'],
      calledToolNames: ['deep_explore'],
    }),
  );
  assert.equal(f, null);
});

test('ordinary prose produces no finding at all', async () => {
  assert.equal(await evaluateClaimGrounding(ctx({ text: '好的，我看一下会话状态然后继续推进。' })), null);
});

test('a rule that throws is a rule that found nothing — the reply still goes out', async () => {
  // messages is typed as an array; handing the citation rule a hostile shape must not take the chain down.
  const f = await evaluateClaimGrounding(
    ctx({ text: '见 arXiv:2504.21801。', messages: null as unknown as ClaimGroundingContext['messages'] }),
  );
  assert.equal(f, null);
});

test('a disabled rule is skipped without disabling the rest of the chain', async () => {
  const prev = process.env.PHILONT_CITATION_GATE;
  process.env.PHILONT_CITATION_GATE = '0';
  try {
    const f = await evaluateClaimGrounding(
      ctx({ text: '按 arXiv:2504.21801，k=10 完成！11 个子集全部通过，最小孤独距离 = 1/11。' }),
    );
    assert.equal(f?.rule, 'numeric_grounding', 'citation off → numeric still runs');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_CITATION_GATE;
    else process.env.PHILONT_CITATION_GATE = prev;
  }
});
