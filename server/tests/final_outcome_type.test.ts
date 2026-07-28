/**
 * A turn can deliver its final text from three places: the zero-tool first response, the tool loop's
 * natural text exit, and the maxIterations fallback. Each had its own copy of the emit ritual, and the
 * OUTCOME LABEL was computed in exactly one of them.
 *
 * So the numeric-grounding rule armed `signalBus.couldNotVerify` on every exit — steering a turn into an
 * honest "I could not verify this" is the whole reason that flag exists — and on two of the three exits
 * nothing ever read it. Prod 2026-07-28 07:09:52: the rule fired on the zero-tool path and the turn
 * closed `outcome=response`, while the identical fire inside the tool loop closed
 * `outcome=could_not_verify` (22:08:11, 00:01:22). The learning judge and the daily health report both
 * read that label, so a share of the honest non-answers were being counted as answers.
 *
 * The rule is one pure function now, called from one emit function. These tests pin the rule; the fact
 * that all three exits reach it is enforced by there being only one of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFinalOutcomeType } from '../src/chat-handler.js';

const NO_TOOLS: Array<{ toolName: string; success: boolean }> = [];

test('an ordinary delivered answer is a response', () => {
  assert.equal(
    resolveFinalOutcomeType({ viabilityStopPending: false, couldNotVerify: false, inTurnRecords: NO_TOOLS }),
    'response',
  );
});

test('the honest non-answer is labelled could_not_verify, not response', () => {
  assert.equal(
    resolveFinalOutcomeType({ viabilityStopPending: false, couldNotVerify: true, inTurnRecords: NO_TOOLS }),
    'could_not_verify',
  );
});

test('a turn that actually computed is a response even if it hedged elsewhere', () => {
  assert.equal(
    resolveFinalOutcomeType({
      viabilityStopPending: false,
      couldNotVerify: true,
      inTurnRecords: [{ toolName: 'pariGp', success: true }],
    }),
    'response',
  );
});

test('a FAILED compute tool does not count as having computed', () => {
  assert.equal(
    resolveFinalOutcomeType({
      viabilityStopPending: false,
      couldNotVerify: true,
      inTurnRecords: [{ toolName: 'pariGp', success: false }],
    }),
    'could_not_verify',
  );
});

test('a successful NON-compute tool does not launder an unverified claim', () => {
  assert.equal(
    resolveFinalOutcomeType({
      viabilityStopPending: false,
      couldNotVerify: true,
      inTurnRecords: [{ toolName: 'search_notes', success: true }],
    }),
    'could_not_verify',
  );
});

test('a viability stop outranks everything — it is a concede, not a failure to verify', () => {
  assert.equal(
    resolveFinalOutcomeType({
      viabilityStopPending: true,
      couldNotVerify: true,
      inTurnRecords: [{ toolName: 'pariGp', success: true }],
    }),
    'stop_and_report',
  );
});
