/**
 * Owner-declared escalation (2026-07-22).
 *
 * 'high' is the only severity that can reach the owner, and it required the executor LLM to BOTH
 * self-rate shouldEscalate=true AND emit a fact with non-empty sourceRefs — three model judgements
 * inside a 2000-token per-initiative budget, ANDed together. Zero passes across three production logs
 * and a hundred-plus initiatives. A compass focus area is a better relevance signal than any
 * self-rating: it is the one place the owner has literally written down what matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openMemoryDb,
  startAutonomousLoop,
  type Driver,
  type InitiativeRunResult,
  type InterruptSink,
} from '../src/index.js';


const TARGET = 'pursuit:compass-philont-itself-46e1027b:q:q1';

/** One driver that always proposes the same compass-anchored advance. */
const oneProposal: Driver = {
  name: 'pursuit',
  propose: () => [
    {
      kind: 'pursuit:advance-question',
      driver: 'pursuit',
      targetRef: TARGET,
      rationale: 'first advance of an owner-declared focus',
      utility: 0.9,
      budgetEstimate: 100,
      plan: [],
    },
  ],
};

async function tickWith(over: {
  escalate: boolean;
  facts: string[];
  isOwnerDeclared?: (targetRef: string) => boolean;
}): Promise<string[]> {
  const handle = openMemoryDb(':memory:');
  const severities: string[] = [];
  const sink: InterruptSink = { fire: (severity) => { severities.push(severity); } };
  const result: InitiativeRunResult = {
    status: 'done',
    outcomeSummary: 'looked it up',
    outcomeRefs: { facts: over.facts, notes: [], pursuits: [] },
    escalate: over.escalate,
    llmTokensSpent: 0,
    toolCallsSpent: 0,
  };
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts, notes: handle.notes, raw: handle.raw,
    skills: handle.skills, routingRules: handle.routingRules, pursuits: handle.pursuits,
    drivers: [oneProposal],
    executor: { async run() { return result; } },
    interrupt: sink,
    isOwnerDeclared: over.isOwnerDeclared,
    enabled: true,
  });
  await loop.tickOnce();
  await loop.stop();
  handle.close();
  return severities;
}

test('an owner-declared pursuit escalates with no LLM self-rating and no facts', async () => {
  const got = await tickWith({
    escalate: false,
    facts: [],
    isOwnerDeclared: (t) => t.startsWith('pursuit:compass-'),
  });
  assert.deepEqual(got, ['high'], 'the owner asked for this one by name');
});

test('without the callback the old AND still governs — nothing else changed', async () => {
  assert.deepEqual(await tickWith({ escalate: false, facts: [] }), ['normal']);
  assert.deepEqual(await tickWith({ escalate: true, facts: ['fact-1'] }), ['high']);
});

test('self-rated important but with NO sourced fact stays normal', async () => {
  // The anti-fabrication half of the old rule is deliberately kept: prod 2026-07-08, the executor wrote
  // "no tools called, verification produced no new data" and self-rated it escalate=true.
  assert.deepEqual(await tickWith({ escalate: true, facts: [] }), ['normal']);
});

test('a throwing relevance lookup degrades to normal and never breaks the tick', async () => {
  const got = await tickWith({
    escalate: false,
    facts: [],
    isOwnerDeclared: () => { throw new Error('db gone'); },
  });
  assert.deepEqual(got, ['normal']);
});

test('the interrupt payload carries driver + targetRef so a drop is attributable', async () => {
  // `kind` has exactly two values and both are outcome shapes, so a funnel line reading
  // "kind=discovery_made" was identical whether it came from a free-curiosity lookup or from advancing
  // the owner's declared focus. Prod 2026-07-22: eight drops in one tick, all unattributable — the
  // escalation fix could not be observed even in principle.
  const handle = openMemoryDb(':memory:');
  const seen: Array<{ driver?: string; targetRef?: string }> = [];
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts, notes: handle.notes, raw: handle.raw,
    skills: handle.skills, routingRules: handle.routingRules, pursuits: handle.pursuits,
    drivers: [oneProposal],
    executor: {
      async run() {
        return {
          status: 'done' as const, outcomeSummary: 's',
          outcomeRefs: { facts: [], notes: [], pursuits: [] },
          escalate: false, llmTokensSpent: 0, toolCallsSpent: 0,
        };
      },
    },
    interrupt: { fire: (_s, p) => { seen.push({ driver: p.driver, targetRef: p.targetRef }); } },
    enabled: true,
  });
  await loop.tickOnce();
  await loop.stop();
  handle.close();
  assert.deepEqual(seen, [{ driver: 'pursuit', targetRef: TARGET }]);
});

// ── Owner-declared work is dispatched first (2026-07-22) ────────────────────────────────────────
//
// The carve-out that keeps a tick from being filled with opportunistic gap items recognised the owner
// by `utility >= 0.9`, which only research_focus-created pursuits reach. A compass focus scores through
// scoreUtility — stake 9 lands at ~0.755 — while a low-confidence gap fact scores up to 0.85. So the
// guard written to protect the owner's declared work ranked it below re-checking a fact nobody asked
// about. Prod 2026-07-22: 18 of 21 initiatives in half an hour were gap.

/** A compass focus advance as PursuitDriver actually scores it: stake 9 → ~0.755, no 0.9 shortcut. */
const compassAdvance: Driver = {
  name: 'pursuit',
  propose: () => [{
    kind: 'pursuit:advance-question', driver: 'pursuit', targetRef: TARGET,
    rationale: 'advance the owner-declared focus', utility: 0.755, budgetEstimate: 100, plan: [],
  }],
};

function proposalsInDispatchOrder(isOwnerDeclared?: (t: string) => boolean): string[] {
  const handle = openMemoryDb(':memory:');
  const order: string[] = [];
  const gap = (i: number, utility: number): Driver => ({
    name: 'gap',
    propose: () => [{
      kind: 'gap:verify', driver: 'gap', targetRef: `fact:${i}`,
      rationale: 'low confidence', utility, budgetEstimate: 10, plan: [],
    }],
  });
  const loop = startAutonomousLoop({
    db: handle.db,
    facts: handle.facts, notes: handle.notes, raw: handle.raw,
    skills: handle.skills, routingRules: handle.routingRules, pursuits: handle.pursuits,
    // A compass advance at its REAL score — scoreUtility gives stake 9 about 0.755, which is BELOW
    // both gap items. Using oneProposal's 0.9 here would be classified as active-research and prioritised
    // by the pre-existing rule, so the test would pass without testing anything.
    drivers: [gap(1, 0.85), compassAdvance, gap(2, 0.8)],
    executor: {
      async run(initiative: { targetRef: string }) {
        order.push(initiative.targetRef);
        return {
          status: 'done' as const, outcomeSummary: 's',
          outcomeRefs: { facts: [], notes: [], pursuits: [] },
          escalate: false, llmTokensSpent: 0, toolCallsSpent: 0,
        };
      },
    },
    isOwnerDeclared,
    enabled: true,
  });
  return (async () => {
    await loop.tickOnce();
    await loop.stop();
    handle.close();
    return order;
  })() as never;
}

test('a compass advance runs BEFORE higher-scoring gap items', async () => {
  const order = await (proposalsInDispatchOrder((t) => t.startsWith('pursuit:compass-')) as never as Promise<string[]>);
  assert.equal(order[0], TARGET, `owner-declared work must go first, got: ${order.join(' → ')}`);
});

test('without the callback, pure utility order still governs — nothing else changed', async () => {
  const order = await (proposalsInDispatchOrder() as never as Promise<string[]>);
  assert.equal(order[0], 'fact:1', 'the 0.85 gap item leads on score alone');
});
