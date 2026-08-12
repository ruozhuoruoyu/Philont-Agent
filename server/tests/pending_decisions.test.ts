/**
 * The reply had no address, and four modules were reading it.
 *
 * Verified in the handler before writing this: the pending states are checked in a fixed order —
 * deep-explore ask, tool authorization, research authorization, question — so "同意" is applied to
 * whichever module comes first in the code, not to the card the owner was looking at. Each kind
 * keeps one slot per session with no occupancy check, so a second request of the same kind
 * overwrites the first and leaves it waiting for an answer that was already spent elsewhere. And the
 * deep-explore ask is deleted before its reply is even examined, so any unrelated message destroys
 * it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeReply,
  renderAmbiguityPrompt,
  renderNeedsAddressPrompt,
  renderPendingTail,
  PendingDecisionBook,
  type PendingDecision,
} from '../src/pending_decisions.js';

const NOW = 1_786_229_362_000;
const HOUR = 3_600_000;

function decision(over: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'd1',
    kind: 'research_authorization',
    title: '后台研究「LRC k=13」请求使用 shell 跑数值验证',
    offered: ['同意', '拒绝'],
    resolutionPolicy: 'unique_bare_reply_allowed',
    createdAt: NOW,
    expiresAt: NOW + HOUR,
    ...over,
  };
}

const research = decision({ id: 'r7k2' });
const publish = decision({
  id: 'p4m8',
  kind: 'tool_authorization',
  title: '发布计划请求执行 git push',
  detail: 'git push origin main',
  offered: ['同意', '拒绝'],
  resolutionPolicy: 'explicit_address_required',
});

test('one thing outstanding: a bare yes answers it', () => {
  const r = routeReply('同意', [research], { now: NOW });
  assert.deepEqual(r, { kind: 'addressed', id: 'r7k2', how: 'only-one' });
});

test('two things outstanding: a bare yes is NOT applied to either', () => {
  // This is the whole point. Before, the fixed check order handed it to the tool authorization —
  // so a yes typed at the research card could approve a git push.
  const r = routeReply('同意', [research, publish], { now: NOW });
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') assert.deepEqual(r.candidates.map((c) => c.id), ['r7k2', 'p4m8']);
});

test('quoting the card is exact, and costs the owner nothing', () => {
  // WeChat inbound carries ref_msg when the owner quotes a message; the field was already in the
  // protocol before anything used it for this.
  const r = routeReply('同意', [research, publish], {
    now: NOW,
    quotedText: '后台研究「LRC k=13」请求使用 shell 跑数值验证',
  });
  assert.deepEqual(r, { kind: 'addressed', id: 'r7k2', how: 'quoted' });
});

const shown = { displayedAt: NOW, ordinals: ['r7k2', 'p4m8'] };

test('a number picks one out of the list that was shown', () => {
  assert.deepEqual(routeReply('2 同意', [research, publish], { now: NOW, snapshot: shown }), {
    kind: 'addressed', id: 'p4m8', how: 'indexed',
  });
  assert.deepEqual(routeReply('第1个', [research, publish], { now: NOW, snapshot: shown }), {
    kind: 'addressed', id: 'r7k2', how: 'indexed',
  });
  // Out of range is not an index, and a bare number answers nothing on its own: unaddressed beats
  // confidently wrong, and every card stays up.
  assert.equal(routeReply('9', [research, publish], { now: NOW, snapshot: shown }).kind, 'unaddressed');
  // A number that opens an ordinary sentence is not a selection either.
  assert.equal(
    routeReply('2 个问题都先放着', [research, publish], { now: NOW, snapshot: shown }).kind,
    'unaddressed',
  );
  // And with no list ever shown, a number addresses nothing — the reply falls through as an
  // ordinary message and every card stays up, rather than being counted against a list the owner
  // was never given.
  assert.equal(routeReply('1 同意', [research, publish], { now: NOW }).kind, 'unaddressed');
});

test('an id said outright works, for a reply that arrives somewhere else entirely', () => {
  assert.deepEqual(routeReply('允许 r7k2', [research, publish], { now: NOW }), {
    kind: 'addressed', id: 'r7k2', how: 'named',
  });
});

test('an ordinary message leaves every card standing', () => {
  // The deep-explore ask was deleted before its reply was read, so "帮我看下日志" silently discarded
  // a question the owner had been asked. A message that answers nothing must consume nothing.
  for (const msg of ['帮我看下今天的日志', '这个数怎么算的', 'k=13 那个还在跑吗']) {
    assert.deepEqual(routeReply(msg, [research, publish], { now: NOW }), { kind: 'unaddressed' }, msg);
  }
});

test('expired cards are not answerable, and do not make a live one ambiguous', () => {
  const stale = decision({ id: 'old', expiresAt: NOW - 1 });
  assert.deepEqual(routeReply('同意', [stale, research], { now: NOW }), {
    kind: 'addressed', id: 'r7k2', how: 'only-one',
  });
  assert.deepEqual(routeReply('同意', [stale], { now: NOW }), { kind: 'unaddressed' });
});

test('an open question has no offered words, so anything can be its answer', () => {
  const question = decision({ id: 'q2n6', kind: 'question', title: '部署到 staging 还是 production？', offered: [] });
  assert.deepEqual(routeReply('用 staging', [question], { now: NOW }), {
    kind: 'addressed', id: 'q2n6', how: 'only-one',
  });
  // With an authorization also outstanding, free text still lands on the question — it is the only
  // one that COULD be answered this way, and "同意/拒绝" is not what was typed.
  assert.deepEqual(routeReply('用 staging', [question, research], { now: NOW }), {
    kind: 'addressed', id: 'q2n6', how: 'only-one',
  });
  // Whereas a word both could take is refused, as always.
  assert.equal(routeReply('同意', [question, research], { now: NOW }).kind, 'ambiguous');
});

test('the disambiguation names each item — merged notice, separate decisions', () => {
  const prompt = renderAmbiguityPrompt([research, publish]);
  assert.match(prompt, /1\. 后台研究/);
  assert.match(prompt, /2\. 发布计划/);
  // Never a single yes-to-all: a shell run and an external publish are not one decision.
  assert.doesNotMatch(prompt, /全部同意|approve all/i);
});

// ── the book ────────────────────────────────────────────────────────────────────────────────────

test('a new request never displaces an unanswered one', () => {
  const book = new PendingDecisionBook();
  book.add('s1', decision({ id: 'a', title: '研究 A 请求 shell' }));
  book.add('s1', decision({ id: 'b', title: '研究 B 请求 http' }));
  // The single-slot map kept only B, and A became an orphan the owner had already been shown.
  assert.deepEqual(book.list('s1', NOW).map((d) => d.id), ['a', 'b']);
});

test('resolving takes one out and leaves the rest', () => {
  const book = new PendingDecisionBook();
  book.add('s1', decision({ id: 'a' }));
  book.add('s1', decision({ id: 'b' }));
  book.resolve('s1', 'a');
  assert.deepEqual(book.list('s1', NOW).map((d) => d.id), ['b']);
});

test('sessions do not see each other', () => {
  const book = new PendingDecisionBook();
  book.add('s1', decision({ id: 'a' }));
  book.add('s2', decision({ id: 'b' }));
  assert.deepEqual(book.list('s1', NOW).map((d) => d.id), ['a']);
  assert.deepEqual(book.list('s2', NOW).map((d) => d.id), ['b']);
});

test('expiry is swept on read', () => {
  const book = new PendingDecisionBook();
  book.add('s1', decision({ id: 'a', expiresAt: NOW - 1 }));
  assert.deepEqual(book.list('s1', NOW), []);
});

// ── the snapshot, and the risk tier ─────────────────────────────────────────────────────────────

test('an ordinal means the list the owner SAW, not the list as it is now', () => {
  const shownList = { displayedAt: NOW, ordinals: ['r7k2', 'p4m8'] };
  // A request registered after the list was rendered. Re-deriving positions from the live set would
  // put it first and silently move the owner's "1" onto something they were never shown there.
  const arrivedLater = decision({ id: 'z9', title: '另一个研究请求 http' });
  const live = [arrivedLater, research, publish];

  assert.deepEqual(routeReply('1 同意', live, { now: NOW, snapshot: shownList }), {
    kind: 'addressed', id: 'r7k2', how: 'indexed',
  });
});

test('a stale snapshot stops addressing by number', () => {
  const old = { displayedAt: NOW - 31 * 60_000, ordinals: ['r7k2', 'p4m8'] };
  assert.equal(routeReply('1 同意', [research, publish], { now: NOW, snapshot: old }).kind, 'unaddressed');
});

test('a slot already resolved is not reused by its number', () => {
  const shownList = { displayedAt: NOW, ordinals: ['r7k2', 'p4m8'] };
  // r7k2 has since been answered, so only publish is live. "1" must not slide onto it.
  assert.equal(routeReply('1 同意', [publish], { now: NOW, snapshot: shownList }).kind, 'unaddressed');
});

test('a high-risk authorization is not decided by a bare yes, even alone', () => {
  const r = routeReply('同意', [publish], { now: NOW });
  assert.equal(r.kind, 'needs-address');
  if (r.kind === 'needs-address') assert.equal(r.decision.id, 'p4m8');

  // Pointing at it works, by any of the exact means.
  assert.equal(routeReply('p4m8 同意', [publish], { now: NOW }).how, 'named');
  assert.equal(
    routeReply('同意', [publish], { now: NOW, quotedText: '发布计划请求执行 git push' }).how,
    'quoted',
  );
});

test('policy narrows only after ambiguity is judged, never instead of it', () => {
  // Both could be what "同意" meant. Filtering by policy first would quietly approve the research
  // one and leave the git push standing — mis-addressing wearing a safer-looking mask.
  const r = routeReply('同意', [research, publish], { now: NOW });
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') assert.equal(r.candidates.length, 2);
});

test('the prompts say plainly that nothing ran, and show the exact operation', () => {
  const amb = renderAmbiguityPrompt([research, publish]);
  assert.match(amb, /一个都没有执行/);
  assert.match(amb, /git push origin main/, 'a high-risk item shows the full command');
  assert.doesNotMatch(amb, /没听懂|不明白/, 'the system knows where the ambiguity is');

  const needs = renderNeedsAddressPrompt(publish);
  assert.match(needs, /没有执行/);
  assert.match(needs, /git push origin main/);
});

test('an ordinary reply gets a nudge, not a re-ask', () => {
  const tail = renderPendingTail([research, publish]);
  assert.match(tail, /2 件事/);
  assert.doesNotMatch(tail, /同意|拒绝/, 'a tail must not re-offer the words and become a second card');
  assert.equal(renderPendingTail([]), '');
});

test('the book records the list it rendered', () => {
  const book = new PendingDecisionBook();
  book.add('s1', research);
  book.add('s1', publish);
  book.snapshot('s1', book.list('s1', NOW), NOW);
  assert.deepEqual(book.lastSnapshot('s1')?.ordinals, ['r7k2', 'p4m8']);
});
