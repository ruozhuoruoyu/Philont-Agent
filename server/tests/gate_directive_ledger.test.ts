/**
 * Production 2026-07-30 12:21, one turn that ran `tools=10 ok=8 (exec=3)`:
 *
 *   12:21:05  [honesty] passed (8 ok / 2 fail / 10 total)
 *   12:21:05  [output-format] fired                       ← pushes a string-content user message
 *   12:21:13  [honesty] passed (0 ok / 0 fail / 0 total)  ← the ledger is now empty
 *   12:21:15  [numeric_grounding] fired: adjudicated computation claim naming [shell]
 *             with 0 successful compute/exec tools
 *
 * The model's rewrite pushed back — "Let me re-read the ledger more carefully. #8 shell DID succeed" —
 * and it was right. A false positive on the fabrication layer, manufactured by an earlier gate.
 *
 * Cause: extractRecentToolResults defines the turn boundary as "the most recent user message with STRING
 * content", and every gate directive is pushed as exactly that. So the FIRST gate to fire in a turn blinds
 * every gate after it. renderTurnLedger's own comment already names the hazard; the contract was routed
 * into messages[0] to dodge it, the directives never were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRecentToolResults } from '../src/chat-handler.js';
import {
  markInternalDirective,
  isInternalDirective,
  INTERNAL_DIRECTIVE_MARK,
} from '../src/internal_correction.js';

/** One turn: user asks, model calls two tools, both come back. */
function turnWithTwoTools(): any[] {
  return [
    { role: 'user', content: 'k=6 跑一下' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'gp -q run.gp' } },
        { type: 'tool_use', id: 't2', name: 'pariGp', input: { code: '1+1' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '✓ exit 0' },
        { type: 'tool_result', tool_use_id: 't2', content: '✓ 2' },
      ],
    },
  ];
}

test('the ledger sees both tools before any gate fires', () => {
  const results = extractRecentToolResults(turnWithTwoTools());
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.toolName), ['shell', 'pariGp']);
});

test('a gate directive does not empty the ledger for the gates that run after it', () => {
  const messages = turnWithTwoTools();
  messages.push({ role: 'assistant', content: 'draft reply' });
  messages.push({ role: 'user', content: markInternalDirective('[drive OutputFormat] rewrite …') });

  const results = extractRecentToolResults(messages);
  assert.equal(results.length, 2, 'the second gate must still see the 2 tools of this turn');
  assert.deepEqual(results.map((r) => r.toolName), ['shell', 'pariGp']);
});

test('several stacked directives still leave the ledger intact', () => {
  const messages = turnWithTwoTools();
  for (const d of ['[drive OutputFormat] …', '[drive EmptyConclusion] …', '[honesty] …']) {
    messages.push({ role: 'assistant', content: 'draft' });
    messages.push({ role: 'user', content: markInternalDirective(d) });
  }
  assert.equal(extractRecentToolResults(messages).length, 2);
});

// The direction that matters: over-marking would pull a PREVIOUS turn's tools into this turn's ledger,
// turning a false positive on the honesty layer into a false NEGATIVE. A real user message is still the
// boundary, marked or not — and it is never marked, because only pushGateDirective marks.
test('a real user message still ends the previous turn', () => {
  const messages = turnWithTwoTools();
  messages.push({ role: 'assistant', content: '跑完了' });
  messages.push({ role: 'user', content: '继续' });

  assert.equal(extractRecentToolResults(messages).length, 0, "the new turn starts with an empty ledger");
});

test('a user message that merely CONTAINS the mark is not treated as ours', () => {
  const messages = turnWithTwoTools();
  messages.push({ role: 'assistant', content: '跑完了' });
  messages.push({ role: 'user', content: `继续${INTERNAL_DIRECTIVE_MARK}` });

  assert.equal(extractRecentToolResults(messages).length, 0, 'the mark is a prefix, not a substring');
});

test('the mark is invisible and does not disturb the directive text', () => {
  const text = '[drive OutputFormat] Your reply is missing ## For User.';
  const marked = markInternalDirective(text);

  assert.ok(isInternalDirective(marked));
  assert.ok(!isInternalDirective(text), 'unmarked text must not be mistaken for ours');
  assert.equal(marked.slice(INTERNAL_DIRECTIVE_MARK.length), text, 'the directive itself is unchanged');
  assert.equal(marked.replace(/[​⁠]/g, ''), text, 'zero-width only — nothing renders');
});

test('non-string content is never a boundary and never marked', () => {
  assert.ok(!isInternalDirective(undefined));
  assert.ok(!isInternalDirective(null));
  assert.ok(!isInternalDirective([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]));
});
