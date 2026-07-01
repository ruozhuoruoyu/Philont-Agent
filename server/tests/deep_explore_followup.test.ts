/**
 * Proactive follow-up (S2 REPORT slice): ask once about a quiet OPEN deep_explore session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAskFollowUp, createFollowUpLoop } from '../src/deep_explore_followup.js';

type Reasoning = Parameters<typeof createFollowUpLoop>[0]['reasoning'];
const SIX_H = 6 * 3_600_000;

test('shouldAskFollowUp: ask iff open frontier + quiet + not-yet-asked', () => {
  const base = { id: 's1', goal: 'g', updatedAt: 0, openFrontierCount: 3 };
  const ctx = (over: Partial<{ alreadyAsked: ReadonlySet<string> }> = {}) =>
    ({ now: SIX_H, silenceMs: SIX_H, alreadyAsked: new Set<string>(), ...over });
  assert.equal(shouldAskFollowUp(base, ctx()), true, 'open + quiet → ask');
  assert.equal(shouldAskFollowUp({ ...base, openFrontierCount: 0 }, ctx()), false, 'nothing open → no');
  assert.equal(shouldAskFollowUp(base, ctx({ alreadyAsked: new Set(['s1']) })), false, 'already asked → no');
  assert.equal(shouldAskFollowUp({ ...base, updatedAt: SIX_H - 1 }, ctx()), false, 'not quiet yet → no');
});

test('createFollowUpLoop: asks once per quiet open session; skips fresh / no-open / re-ask', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP; // default ON
  try {
    const sessions = [
      { id: 'open-quiet', goal: 'P vs NP barriers and how to push the proof', updatedAt: 0, createdAt: 0, ownerSessionId: 'wechat:u' }, // quiet, 4 open → ask
      { id: 'open-fresh', goal: 'just touched', updatedAt: SIX_H, createdAt: 0, ownerSessionId: 'wechat:u' }, // fresh → skip
      { id: 'no-open', goal: 'all settled', updatedAt: 0, createdAt: 0, ownerSessionId: 'wechat:u' }, // 0 open → skip
    ];
    const snaps: Record<string, number> = { 'open-quiet': 4, 'open-fresh': 2, 'no-open': 0 };
    const reasoning = {
      listActiveSessions: () => sessions,
      summarizeSession: (id: string) => ({
        status: 'active',
        provedCount: 0,
        deadCount: 0,
        openFrontierCount: snaps[id],
      }),
    } as unknown as Reasoning;

    const asks: Array<{ text: string; owner?: string }> = [];
    const loop = createFollowUpLoop({
      reasoning,
      notify: (text, opts) => asks.push({ text, owner: opts?.ownerSessionId }),
      silenceMs: SIX_H,
      now: () => SIX_H, // now − updatedAt(0) = SIX_H ≥ silence → open-quiet qualifies; open-fresh(=SIX_H) does not
    });

    loop.tickOnce();
    assert.equal(asks.length, 1, 'only the quiet open session is asked');
    assert.match(asks[0].text, /P vs NP barriers/);
    assert.match(asks[0].text, /4 个开放节点/);
    assert.equal(asks[0].owner, 'wechat:u', 'routed to the session owner channel');

    loop.tickOnce(); // unchanged state → dedup
    assert.equal(asks.length, 1, 'asked once, never again');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
    else process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP = prev;
  }
});

test('createFollowUpLoop: many quiet open sessions → ONE batched ask (most recent), not one per session', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  try {
    // The prod bug: a chat with many stale open sessions got ONE message PER session in a single tick.
    const sessions = [
      { id: 'old', goal: 'Goldbach via circle method', updatedAt: 0, createdAt: 100, ownerSessionId: 'wechat:u' },
      { id: 'newest', goal: 'P vs NP barriers and how to push', updatedAt: 0, createdAt: 300, ownerSessionId: 'wechat:u' },
      { id: 'mid', goal: 'GLM deployment cost', updatedAt: 0, createdAt: 200, ownerSessionId: 'wechat:u' },
    ];
    const reasoning = {
      listActiveSessions: () => sessions,
      summarizeSession: () => ({ status: 'active', provedCount: 0, deadCount: 0, openFrontierCount: 5 }),
    } as unknown as Reasoning;
    const asks: Array<{ text: string; owner?: string }> = [];
    const loop = createFollowUpLoop({
      reasoning,
      notify: (text, opts) => asks.push({ text, owner: opts?.ownerSessionId }),
      silenceMs: SIX_H,
      now: () => SIX_H,
    });
    loop.tickOnce();
    assert.equal(asks.length, 1, 'ONE batched ask, not one per session (the spam bug)');
    assert.match(asks[0].text, /3 个/, 'surfaces the backlog count');
    assert.match(asks[0].text, /P vs NP barriers/, 'asks about the most recently STARTED (current focus)');
    assert.equal(asks[0].owner, 'wechat:u', 'routed to the owner channel');
    loop.tickOnce();
    assert.equal(asks.length, 1, 'whole batch silenced — no drip on later ticks');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
    else process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP = prev;
  }
});

test('shouldAutoAbandon: only after asked + still quiet + stuck + grace elapsed', async () => {
  const { shouldAutoAbandon } = await import('../src/deep_explore_followup.js');
  const GRACE = 24 * 3_600_000;
  const base = { openFrontierCount: 5, updatedAt: 0, askedAt: 0, provedCount: 0 };
  const ctx = { now: GRACE, graceMs: GRACE };
  assert.equal(shouldAutoAbandon(base, ctx), true, 'asked + quiet + stuck + grace → archive');
  assert.equal(shouldAutoAbandon({ ...base, askedAt: undefined }, ctx), false, 'never asked → no');
  assert.equal(shouldAutoAbandon({ ...base, openFrontierCount: 0 }, ctx), false, 'already resolved → no');
  assert.equal(shouldAutoAbandon({ ...base, provedCount: 2 }, ctx), false, 'made progress → never discard');
  assert.equal(shouldAutoAbandon({ ...base, updatedAt: 1 }, ctx), false, 're-engaged after ask → no');
  assert.equal(shouldAutoAbandon(base, { now: GRACE - 1, graceMs: GRACE }), false, 'grace not elapsed → no');
});

test('createFollowUpLoop: stuck session → ask leads with abandon option; auto-archives if ignored past grace', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  const prevA = process.env.PHILONT_DEEP_EXPLORE_AUTOARCHIVE;
  delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  delete process.env.PHILONT_DEEP_EXPLORE_AUTOARCHIVE; // default ON
  try {
    const sessions = [
      { id: 'stuck', goal: '模型选型 DeepSeek vs Claude,开放节点都需外部实时数据', updatedAt: 0, createdAt: 0, ownerSessionId: 'wechat:u' },
    ];
    const abandoned: string[] = [];
    const reasoning = {
      listActiveSessions: () => sessions,
      summarizeSession: () => ({ status: 'stuck', provedCount: 0, deadCount: 0, openFrontierCount: 5 }),
      setSessionStatus: (id: string, st: string) => { if (st === 'abandoned') abandoned.push(id); },
    } as unknown as Reasoning;
    const asks: Array<{ text: string }> = [];
    let clock = SIX_H;
    const loop = createFollowUpLoop({
      reasoning,
      notify: (text) => asks.push({ text }),
      silenceMs: SIX_H,
      now: () => clock,
    });
    loop.tickOnce(); // asks once, stuck → 放弃 lead
    assert.equal(asks.length, 1, 'asked once');
    assert.match(asks[0].text, /放弃/, 'stuck session leads with the abandon option');
    assert.equal(abandoned.length, 0, 'not archived on the ask tick');
    clock = SIX_H + 24 * 3_600_000 + 1; // past grace, still no re-engagement
    loop.tickOnce();
    assert.deepEqual(abandoned, ['stuck'], 'auto-archived after grace');
    assert.equal(asks.length, 2, 'notified about the archive');
    assert.match(asks[1].text, /归档/, 'archive notice');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP; else process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP = prev;
    if (prevA === undefined) delete process.env.PHILONT_DEEP_EXPLORE_AUTOARCHIVE; else process.env.PHILONT_DEEP_EXPLORE_AUTOARCHIVE = prevA;
  }
});

test('createFollowUpLoop: re-engagement after the ask cancels auto-archive', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
  try {
    const session = { id: 's', goal: 'g', updatedAt: 0, createdAt: 0, ownerSessionId: 'wechat:u' };
    const sessions = [session];
    const abandoned: string[] = [];
    const reasoning = {
      listActiveSessions: () => sessions,
      summarizeSession: () => ({ status: 'active', provedCount: 0, deadCount: 0, openFrontierCount: 3 }),
      setSessionStatus: (id: string, st: string) => { if (st === 'abandoned') abandoned.push(id); },
    } as unknown as Reasoning;
    const asks: Array<{ text: string }> = [];
    let clock = SIX_H;
    const loop = createFollowUpLoop({ reasoning, notify: (t) => asks.push({ text: t }), silenceMs: SIX_H, now: () => clock });
    loop.tickOnce(); // ask at SIX_H
    session.updatedAt = SIX_H + 1; // user re-engaged (advanced the session) after the ask
    clock = SIX_H + 24 * 3_600_000 + 1;
    loop.tickOnce();
    assert.equal(abandoned.length, 0, 're-engaged session is never auto-archived');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP; else process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP = prev;
  }
});
