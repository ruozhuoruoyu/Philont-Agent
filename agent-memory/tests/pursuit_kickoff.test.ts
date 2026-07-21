/**
 * PursuitDriver kickoff (2026-07-21) — a pursuit that has never been touched is UN-STARTED, not stalled.
 *
 * Prod: the owner's compass focus area was seeded as a pursuit and then could never be advanced by
 * anything, ever. PursuitDriver required 7 days of staleness AND evidenceRefs > 0, but evidenceRefs are
 * only written after a `pursuit:*` initiative completes — which requires PursuitDriver to have proposed.
 * The hand-off to CuriosityDriver did not close the loop either: its dormant branch waits 14 days, needs
 * stake >= 7, and emits a targetRef applyPursuitProgress filters out, so it writes no evidence and does
 * not refresh last_touched. Meanwhile every autonomous tick went to free curiosity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PursuitDriver, DEFAULT_PURSUIT_CONFIG } from '../src/autonomous/drivers/pursuit_driver.js';

const NOW = 1_784_600_000_000;
const DAY = 86_400_000;

function pursuit(over: Record<string, unknown> = {}) {
  return {
    id: 'compass-philont-abc12345',
    title: 'philont itself',
    intent: 'A focus area my owner declared in their compass.',
    isEvergreen: false,
    stakeWeight: 9,
    deadline: null,
    evidenceRefs: [] as string[],
    openQuestions: [
      { id: 'q1', text: 'What is the current state, and what would advance it?', createdTurn: 0, updatedTurn: 0, status: 'open' },
    ],
    resolutionCriteria: null,
    isActiveResearch: false,
    lastTouchedAt: null as number | null,
    updatedAt: NOW,
    ...over,
  };
}

function snap(pursuits: ReturnType<typeof pursuit>[], done: string[] = []) {
  return { now: NOW, activePursuits: pursuits, recentDoneTargetRefs: new Set(done) } as never;
}

const driver = new PursuitDriver(DEFAULT_PURSUIT_CONFIG);

test('a never-touched pursuit is advanced immediately, not held for stalledDays', () => {
  const out = driver.propose(snap([pursuit()]));
  assert.equal(out.length, 1, 'the owner just declared this — it must not wait 7 days to start');
  assert.equal(out[0].kind, 'pursuit:advance-question');
  assert.match(out[0].rationale, /never been worked on|FIRST advance/i, 'must not claim it is stalled');
});

test('the kickoff emits a targetRef that closes the loop', () => {
  // pursuit:<id>:q:<qid> is the shape applyPursuitProgress acts on — it adds evidence and refreshes
  // last_touched. CuriosityDriver's `pursuit:<id>` is filtered out by driver, which is exactly why that
  // path could never unstick anything.
  const out = driver.propose(snap([pursuit()]));
  assert.equal(out[0].targetRef, 'pursuit:compass-philont-abc12345:q:q1');
});

test('it is self-limiting: once it has produced something, normal stalled cadence resumes', () => {
  // Evidence exists and it was touched recently → inside the stalled window → nothing proposed.
  const touched = pursuit({ lastTouchedAt: NOW - DAY, evidenceRefs: ['init-1'] });
  assert.deepEqual(driver.propose(snap([touched])), []);
  // Touched, with evidence, and now genuinely stale → the ordinary path takes over.
  const stale = pursuit({ lastTouchedAt: NOW - 8 * DAY, evidenceRefs: ['init-1'] });
  const out = driver.propose(snap([stale]));
  assert.equal(out.length, 1);
  assert.match(out[0].rationale, /has not been touched for 8 days/, 'ordinary stalled wording');
});

test('the marker is evidence, not last_touched — bookkeeping must not look like progress', () => {
  // addOpenQuestion bumps last_touched_ts, so a pursuit can be "recently touched" while having produced
  // nothing at all. Keying the kickoff on last_touched would have made the compass backfill silently
  // re-block the very pursuit it was repairing.
  const out = driver.propose(snap([pursuit({ lastTouchedAt: NOW - 60_000, evidenceRefs: [] })]));
  assert.equal(out.length, 1, 'still un-started: no evidence has ever been produced');
});

test('the 24h dedup still applies — one kickoff, not one per tick', () => {
  const out = driver.propose(snap([pursuit()], ['pursuit:compass-philont-abc12345:q:q1']));
  assert.deepEqual(out, []);
});

test('a never-touched pursuit with no question and no criteria still produces nothing', () => {
  // The kickoff opens the gate; it does not invent a goal. This is why the compass now seeds an opening
  // question — without one there is still nothing to advance.
  const out = driver.propose(snap([pursuit({ openQuestions: [], resolutionCriteria: null })]));
  assert.deepEqual(out, []);
});

test('low stake does not block a kickoff — the owner declared it, stake only orders it', () => {
  // CuriosityDriver's dormant branch requires stake >= 7; a stake-5 compass focus would never surface there.
  const out = driver.propose(snap([pursuit({ stakeWeight: 5 })]));
  assert.equal(out.length, 1);
  assert.ok(out[0].utility >= 0.5);
});

test('the evergreen root is never kicked off', () => {
  assert.deepEqual(driver.propose(snap([pursuit({ isEvergreen: true })])), []);
});
