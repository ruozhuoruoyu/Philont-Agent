/**
 * The deep_explore session-control words the cards print — 放弃 / 全清 / 自动推进 / 停.
 *
 * Until 2026-07-14 these had NO listener anywhere in the repo: the phrases existed only in the cards that
 * printed them, while the verbs they name (setSessionStatus('abandoned'), setAutoAdvance) sat fully built and
 * unplumbed. The valve was made and never connected to the handle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExploreControlReply, resolveExploreTarget, decideResumeBatch} from '../src/explore_control.js';

test('classifyExploreControlReply: matches the words the cards offer, in both languages', () => {
  assert.deepEqual(classifyExploreControlReply('全清'), { kind: 'abandon_all' });
  assert.deepEqual(classifyExploreControlReply('clear all'), { kind: 'abandon_all' });
  assert.deepEqual(classifyExploreControlReply('自动推进'), { kind: 'auto_advance' });
  assert.deepEqual(classifyExploreControlReply('auto advance'), { kind: 'auto_advance' });
  assert.deepEqual(classifyExploreControlReply('继续'), { kind: 'resume_batch' });
  assert.deepEqual(classifyExploreControlReply('continue'), { kind: 'resume_batch' });
  assert.deepEqual(classifyExploreControlReply('停'), { kind: 'stop_auto' });
  assert.deepEqual(classifyExploreControlReply('stop'), { kind: 'stop_auto' });
  assert.deepEqual(classifyExploreControlReply('放弃'), { kind: 'abandon', target: null });
  assert.deepEqual(classifyExploreControlReply('abandon'), { kind: 'abandon', target: null });
});

test('classifyExploreControlReply: "放弃 <它>" carries the target the owner named', () => {
  // The cards truncate goals to 50 chars, so the owner types a FRAGMENT of what they were shown — never an
  // id. The target is whatever they typed; resolveExploreTarget decides what it means.
  assert.deepEqual(classifyExploreControlReply('放弃 素数分布'), { kind: 'abandon', target: '素数分布' });
  assert.deepEqual(classifyExploreControlReply('放弃「素数分布」'), { kind: 'abandon', target: '素数分布' });
  assert.deepEqual(classifyExploreControlReply('abandon prime distribution'), {
    kind: 'abandon',
    target: 'prime distribution',
  });
});

test('classifyExploreControlReply: ordinary sentences are not control words', () => {
  // This runs BEFORE the model on every turn. 停 / 放弃 are ordinary words people say for ordinary reasons.
  assert.equal(classifyExploreControlReply('我不想放弃这个方向,再想想'), null);
  assert.equal(classifyExploreControlReply('自动推进是怎么实现的？'), null);
  assert.equal(classifyExploreControlReply('停车场在哪'), null);
  assert.equal(classifyExploreControlReply(''), null);
});

test('resolveExploreTarget: a bare abandon means the session we just asked about', () => {
  const a = { id: 'a', goal: 'prime gaps' };
  const b = { id: 'b', goal: 'model selection' };
  assert.deepEqual(resolveExploreTarget([a, b], null, b), { session: b }, 'null target → current focus');
  assert.deepEqual(resolveExploreTarget([a, b], 'prime', b), { session: a }, 'named target wins over focus');
  assert.equal(resolveExploreTarget([a, b], 'nonsense', b), null);
});

test('resolveExploreTarget: ambiguity is REFUSED, never guessed', () => {
  // Silently archiving the wrong line of reasoning is far worse than asking which one. Same rule as the
  // constitution-proposal prefix.
  const a = { id: 'a', goal: 'prime gaps in arithmetic progressions' };
  const b = { id: 'b', goal: 'prime counting function bounds' };
  const r = resolveExploreTarget([a, b], 'prime', null);
  assert.ok(r && 'ambiguous' in r, '"prime" matches both — must ask, not pick');
  assert.equal((r as { ambiguous: unknown[] }).ambiguous.length, 2);
});

test('a bare 继续 is only ours to answer when this driver paused the focused session', () => {
  const base = {
    hasFocus: true,
    pauseReason: 'stuck' as const,
    focusIsFormal: true,
    hasFormalAdmission: true,
    admissionCardPending: false,
  };
  // Nothing focused → we cannot even know the word was about an exploration. Answering "name one first"
  // would hijack every routine 继续 the moment a stale session sits in the list.
  assert.equal(decideResumeBatch({ ...base, hasFocus: false }), 'fall_through');
  // Focused, but this driver never paused it → the long-standing manual continue path keeps it.
  assert.equal(decideResumeBatch({ ...base, pauseReason: null }), 'fall_through');
  // Our pause + a live lease → one word buys one episode.
  assert.equal(decideResumeBatch(base), 'rearm');
  assert.equal(decideResumeBatch({ ...base, pauseReason: 'budget' }), 'rearm');
  // A deliberate session needs no local verifier lease.
  assert.equal(
    decideResumeBatch({ ...base, focusIsFormal: false, hasFormalAdmission: false }),
    'rearm',
  );
});

test('a pause reason that outlived its approval card re-raises the card, never a dead end', () => {
  // autoPauseReason is persisted; the pending card is in-memory with a TTL. After a restart or a lapse,
  // "reply 同意 to the authorization card" names a card that no longer exists — and no word the owner
  // types can get them out of it.
  assert.equal(
    decideResumeBatch({
      hasFocus: true, pauseReason: 'auth', focusIsFormal: true,
      hasFormalAdmission: false, admissionCardPending: false,
    }),
    'request_admission',
  );
  // While the card IS live, 继续 is simply not the word it asked for.
  assert.equal(
    decideResumeBatch({
      hasFocus: true, pauseReason: 'auth', focusIsFormal: true,
      hasFormalAdmission: false, admissionCardPending: true,
    }),
    'await_card',
  );
  // Lease came back (the foreground approved something else) → just run the batch.
  assert.equal(
    decideResumeBatch({
      hasFocus: true, pauseReason: 'auth', focusIsFormal: true,
      hasFormalAdmission: true, admissionCardPending: false,
    }),
    'rearm',
  );
});

test('a stuck formal pause does not promise a batch the next tick would refuse', () => {
  // The driver checks admission at the top of every tick, so answering "已重新武装一批" without the
  // lease means the owner gets an authorization card instead of the batch they were just promised.
  assert.equal(
    decideResumeBatch({
      hasFocus: true, pauseReason: 'stuck', focusIsFormal: true,
      hasFormalAdmission: false, admissionCardPending: false,
    }),
    'request_admission',
  );
});
