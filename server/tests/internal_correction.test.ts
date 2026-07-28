/**
 * Production 2026-07-28 15:35:45, delivered to WeChat verbatim:
 *
 *   "You're right. 让我重写——本轮回合我确实没有运行任何计算工具…"
 *
 * The owner is reading a reply that agrees with something he never said. Gate directives are pushed as
 * `role: 'user'` messages — the only slot a mid-turn instruction fits into — so from inside the model
 * there IS a user who just said it, and agreeing is the natural next move. All 23 hand-typed copies of
 * the footer said "do not surface this reminder to the user"; the model obeyed that literally (it never
 * quoted the reminder) and still leaked the correction as a non-sequitur.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_CORRECTION_FOOTER, INTERNAL_CORRECTION_FOOTER_NL } from '../src/internal_correction.js';
import { buildNumericGroundingDirective } from '../src/numeric_grounding_gate.js';
import { buildCitationGroundingDirective } from '../src/citation_gate.js';
import { buildAnnouncedToolDirective } from '../src/announced_tool_gate.js';
import { buildTurnLedgerContract } from '../src/chat-handler.js';

test('the footer forbids the acknowledgement, not just the quoting', () => {
  // The old wording only banned surfacing the reminder, which the leak did not do.
  assert.match(INTERNAL_CORRECTION_FOOTER, /not a message from the user/i);
  for (const banned of ["you're right", 'let me rewrite', '抱歉', '更正']) {
    assert.ok(
      INTERNAL_CORRECTION_FOOTER.toLowerCase().includes(banned.toLowerCase()),
      `the footer should name "${banned}" as a forbidden opener`,
    );
  }
});

test('the newline variant is the same instruction', () => {
  assert.equal(INTERNAL_CORRECTION_FOOTER_NL, `\n${INTERNAL_CORRECTION_FOOTER}`);
});

test('every claim-grounding directive carries it — one wording, not one per author', () => {
  const directives = [
    buildNumericGroundingDirective('数值验证', '  ✓ #1 search_notes → ok'),
    buildCitationGroundingDirective('2504.21801'),
    buildAnnouncedToolDirective({ toolName: 'deep_explore', quote: '我现在就看' }),
  ];
  for (const d of directives) {
    assert.ok(d.includes(INTERNAL_CORRECTION_FOOTER), `missing the shared footer:\n${d.slice(0, 80)}…`);
  }
});

test('the directives still say what they are for', () => {
  assert.match(buildNumericGroundingDirective('数值验证'), /numeric-grounding/);
  assert.match(buildCitationGroundingDirective('2504.21801'), /arXiv:2504\.21801/);
  assert.match(
    buildAnnouncedToolDirective({ toolName: 'deep_explore', quote: '我现在就看' }),
    /deep_explore/,
  );
});

// The envelope contract joined the per-iteration ledger block on 2026-07-28, because output_format was
// firing on four of five substantive turns and each fire costs a full extra model call. The instruction
// was never missing — it was STALE: the reply-format contract sits in the system prefix, nineteen tool
// calls behind by the time a long analytical turn writes its answer. The regenerated replies proved the
// model knows the format; it wrapped the same content correctly on the second pass.
test('the generation-time contract restates the ## For User envelope', () => {
  const block = buildTurnLedgerContract([{ toolName: 'pariGp', success: true, resultText: 'ok' }]);
  assert.match(block, /## For User/);
  assert.match(block, /## Work Log/);
  assert.match(block, /CONTRACT 3\/3/);
  // and it must say the rule survives a long, well-structured answer — that is the case that failed
  assert.match(block, /###/);
});

test('an empty ledger injects nothing at all — no contract, no envelope nag', () => {
  assert.equal(buildTurnLedgerContract([]), '');
});
