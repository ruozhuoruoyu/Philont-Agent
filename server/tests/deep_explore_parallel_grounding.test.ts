/**
 * H1 — parallel sub-agent research grounding: pure helpers (flag / fanout / angles / merge-dedup).
 * The runParallelSubAgents integration is covered by the no-regression suite; here we lock the logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subAgentResearchEnabled,
  subAgentResearchFanout,
  buildGroundingAngles,
  mergeLiteratureCards,
  type LiteratureCard,
} from '../src/deep_explore.js';

test('subAgentResearchEnabled: default ON, =0/off disables', () => {
  const prev = process.env.PHILONT_SUBAGENT_RESEARCH;
  try {
    delete process.env.PHILONT_SUBAGENT_RESEARCH;
    assert.equal(subAgentResearchEnabled(), true);
    process.env.PHILONT_SUBAGENT_RESEARCH = '0';
    assert.equal(subAgentResearchEnabled(), false);
    process.env.PHILONT_SUBAGENT_RESEARCH = 'off';
    assert.equal(subAgentResearchEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_SUBAGENT_RESEARCH;
    else process.env.PHILONT_SUBAGENT_RESEARCH = prev;
  }
});

test('subAgentResearchFanout: default 3, clamped to 2..4', () => {
  const prev = process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT;
  try {
    delete process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT;
    assert.equal(subAgentResearchFanout(), 3);
    process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT = '1';
    assert.equal(subAgentResearchFanout(), 2, 'floor 2');
    process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT = '9';
    assert.equal(subAgentResearchFanout(), 4, 'ceil 4');
    process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT = 'x';
    assert.equal(subAgentResearchFanout(), 3, 'non-int → default');
  } finally {
    if (prev === undefined) delete process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT;
    else process.env.PHILONT_SUBAGENT_RESEARCH_FANOUT = prev;
  }
});

test('buildGroundingAngles: distinct per-domain angles, count = fanout', () => {
  const f = buildGroundingAngles('formal', 3);
  assert.equal(f.length, 3);
  assert.equal(new Set(f).size, 3, 'angles are distinct');
  assert.match(f.join(' '), /SOTA|barrier|no-go/i, 'formal angles mention SOTA/barriers');

  const d = buildGroundingAngles('deliberate', 3);
  assert.match(d.join(' '), /tradeoff|risk|factor/i, 'deliberate angles mention factors/tradeoffs/risks');

  assert.equal(buildGroundingAngles('formal', 2).length, 2);
  assert.equal(buildGroundingAngles('formal', 9).length, 4, 'capped at 4 available angles');
});

test('mergeLiteratureCards: dedupes by normalized claim, keeps first, caps to max', () => {
  const card = (claim: string, type: LiteratureCard['type'] = 'background', source = ''): LiteratureCard => ({ claim, type, source });
  const a = [card('Prime gaps are bounded'), card('Sieve methods hit the parity barrier', 'barrier')];
  const b = [card('  prime gaps   are BOUNDED '), card('Circle method gives an asymptotic', 'approach')]; // dup of a[0] (normalized)
  const merged = mergeLiteratureCards([a, b], 10);
  assert.equal(merged.length, 3, 'the normalized-duplicate claim is dropped');
  assert.equal(merged[0].claim, 'Prime gaps are bounded', 'first occurrence kept');

  const capped = mergeLiteratureCards([a, b], 2);
  assert.equal(capped.length, 2, 'respects max');
});
