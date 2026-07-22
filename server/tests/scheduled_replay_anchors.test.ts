/**
 * A scheduled re-fire is not a user override (2026-07-21).
 *
 * decideTurnAnchors answers "how did the user respond to the stop?" — push forward, accept it, or redirect.
 * A scheduled task replays byte-identical stored text forever with nobody in the loop, and that replay was
 * scoring as a substantive redirect, so the doom accounting was cleared on every single fire. Stop signals
 * could therefore never accumulate past one turn: prod showed the agent concluding "这个模式已经走到死胡同了
 * ……同样的情况已经重复了 30+ 次", the gate firing verdict=pivot, and six minutes later
 * `doom-reset on user override ("MycoX check-in routi")` erasing it. Twice in two logs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTurnAnchors } from '../src/viability_gate.js';
import { isScheduledPromptReplay, autonomousCapabilityNote } from '../src/chat-handler.js';

const SCHEDULED_PROMPT =
  'MycoX check-in routine (including logging to memory/YYYY-MM-DD.md). Fetch the feed, review, vote, comment.';

test('a replayed schedule prompt does not clear accumulated doom', () => {
  const decision = decideTurnAnchors({
    lastAssistantText: '这个模式已经走到死胡同了。',
    userMessage: SCHEDULED_PROMPT,
    hadDoom: true,
    promptIsReplay: true,
  });
  assert.equal(decision.doomReset, false, 'nobody read the stop, so nobody overrode it');
  assert.equal(decision.anchor, false, 'and there is no instruction to stay on target for');
});

test('without the flag the same prompt still resets — i.e. this was the actual bug', () => {
  const decision = decideTurnAnchors({
    lastAssistantText: '这个模式已经走到死胡同了。',
    userMessage: SCHEDULED_PROMPT,
    hadDoom: true,
  });
  assert.equal(decision.doomReset, true);
});

test('a real user override is untouched', () => {
  // Push-forward and substantive redirect. NOT "换个方向" — that is in VIABILITY_ACCEPT_RE by design
  // (it confirms the stop rather than overriding it), and is exempt for that reason.
  for (const msg of ['继续', 'keep going, try the other endpoint', '试试直接调 /api/posts 端点']) {
    const d = decideTurnAnchors({ lastAssistantText: '撞墙了，建议停。', userMessage: msg, hadDoom: true });
    assert.equal(d.doomReset, true, `user push-forward must still reset: ${msg}`);
  }
});

test('a user ACCEPTING the stop still does not reset', () => {
  const d = decideTurnAnchors({ lastAssistantText: '建议停。', userMessage: '算了，换个框架', hadDoom: true });
  assert.equal(d.doomReset, false);
});

test('replay detection: first fire is new, identical re-fires are replays', () => {
  const seen = new Map<string, string>();
  const sid = 'system:scheduled:mycox-checkin';
  assert.equal(isScheduledPromptReplay(sid, SCHEDULED_PROMPT, seen), false, 'first fire is not a replay');
  assert.equal(isScheduledPromptReplay(sid, SCHEDULED_PROMPT, seen), true);
  assert.equal(isScheduledPromptReplay(sid, SCHEDULED_PROMPT, seen), true);
});

test('replay detection: editing the schedule IS a new instruction', () => {
  const seen = new Map<string, string>();
  const sid = 'system:scheduled:mycox-checkin';
  isScheduledPromptReplay(sid, SCHEDULED_PROMPT, seen);
  assert.equal(
    isScheduledPromptReplay(sid, SCHEDULED_PROMPT + ' Also post a summary.', seen),
    false,
    'an owner edit must not be swallowed as a replay',
  );
});

test('replay detection: interactive sessions are never replays', () => {
  const seen = new Map<string, string>();
  assert.equal(isScheduledPromptReplay('web-abc123', '继续', seen), false);
  assert.equal(isScheduledPromptReplay('web-abc123', '继续', seen), false, 'a user repeating themselves means it');
});

test('the unattended-turn note names what IS possible, not only what is not', () => {
  // The prod failure was a capability advertised only inside an error message: run 61 hit the wall, read
  // the rejection, and used appendJournal; runs 62-69 never hit the wall, never saw it, never used it.
  const note = autonomousCapabilityNote();
  assert.match(note, /appendJournal/);
  assert.match(note, /store_note/);
  assert.match(note, /writeFile/, 'still say plainly what is unavailable');
  assert.ok(
    note.indexOf('appendJournal') > 0 && /INSTEAD of/i.test(note),
    'must tell it what to reach for in place of the blocked tool',
  );
});

// ── The viability directive must describe the work actually being done (2026-07-22) ─────────────
//
// Once the pivot ratchet stopped being cleared every fire, stop_and_report became reachable on a
// scheduled session for the first time — and the directive turned out to be written entirely in
// deep_explore vocabulary. Told to "credit the proved lemmas that persist in the tree" for "the active
// reasoning goal", on a turn with no tree and provedCount=0, the model found the nearest thing in memory
// that fit and reported on Goldbach CRT residue-class coverage. In a mycox check-in.
import { buildViabilityDirective } from '../src/viability_gate.js';

const STOP = {
  verdict: 'stop_and_report' as const,
  score: 2,
  reasons: ['same_root_cause', 'repeated_pivot_ratchet'],
  evidence: 'the feed has been unchanged for 3 runs',
  recommendedReframe: undefined,
};

test('no reasoning session: the directive never mentions a tree, lemmas, or an attack', () => {
  const d = buildViabilityDirective(STOP, {
    provedCount: 0,
    hasReasoningSession: false,
    taskHint: 'MycoX check-in routine',
  });
  for (const term of [/proved lemma/i, /in the tree/i, /future attack/i, /active reasoning goal/i]) {
    assert.doesNotMatch(d, term, `session-less directive must not use reasoning vocabulary: ${term}`);
  }
  assert.match(d, /MycoX check-in routine/, 'it must name the task actually being judged');
  assert.match(d, /do NOT reach into memory/i, 'and forbid substituting a different piece of work');
});

test('with a reasoning session: the original wording is intact', () => {
  const d = buildViabilityDirective(STOP, { provedCount: 4, hasReasoningSession: true });
  assert.match(d, /4 proved lemma\(s\) persist in the tree/);
  assert.match(d, /active reasoning goal/i);
});

test('no session and no task hint: still generic, never reasoning-flavoured', () => {
  const d = buildViabilityDirective(STOP, { provedCount: 0, hasReasoningSession: false });
  assert.match(d, /This task is not advancing/);
  assert.doesNotMatch(d, /proved lemma/i);
});
