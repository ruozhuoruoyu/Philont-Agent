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
      { id: 'open-quiet', goal: 'P vs NP barriers and how to push the proof', updatedAt: 0 }, // quiet, 4 open → ask
      { id: 'open-fresh', goal: 'just touched', updatedAt: SIX_H }, // fresh → skip
      { id: 'no-open', goal: 'all settled', updatedAt: 0 }, // 0 open → skip
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

    const asks: string[] = [];
    const loop = createFollowUpLoop({
      reasoning,
      notify: (text) => asks.push(text),
      silenceMs: SIX_H,
      now: () => SIX_H, // now − updatedAt(0) = SIX_H ≥ silence → open-quiet qualifies; open-fresh(=SIX_H) does not
    });

    loop.tickOnce();
    assert.equal(asks.length, 1, 'only the quiet open session is asked');
    assert.match(asks[0], /P vs NP barriers/);
    assert.match(asks[0], /4 个开放节点/);

    loop.tickOnce(); // unchanged state → dedup
    assert.equal(asks.length, 1, 'asked once, never again');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP;
    else process.env.PHILONT_DEEP_EXPLORE_FOLLOWUP = prev;
  }
});
