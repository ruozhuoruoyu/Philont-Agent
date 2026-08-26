/**
 * Learning instrumentation report (2026-06-22).
 *
 * Aggregates the persisted metric counters (memory.metrics) PLUS state derivable from existing tables
 * (routing_rules confidence, skills maturity, memory_actions tool calls) into one human-readable block,
 * so after a few days we can decide — from data, not intuition — whether the self-learning machinery
 * actually reaches the agent and matures, or is over-built and should be simplified.
 *
 * Pure reader: no writes, no LLM. Safe to call anytime; every section is independently try/caught.
 */
import { extractFailureSignature } from '@agent/memory';
import type { MemoryHandle } from '@agent/memory';

function pct(n: number, d: number): string {
  if (!d) return 'n/a';
  return `${((100 * n) / d).toFixed(0)}%`;
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

export function renderLearningStats(memory: MemoryHandle, windowDays = 7): string {
  const lines: string[] = [];
  lines.push(`=== Learning instrumentation (window ${windowDays}d) ===`);

  // 1) Raw counters
  try {
    const snap = memory.metrics.snapshot();
    const get = (k: string) => snap.find((r) => r.key === k)?.count ?? 0;
    const turns = get('turn.total');

    lines.push('-- counters --');
    for (const r of snap) lines.push(`  ${r.key} = ${r.count}`);

    // 2) Derived ratios — the actual "does learning reach the agent / help?" signals
    lines.push('-- signals --');
    lines.push(
      `  routing rule injected in ${get('routing.inject.turns')}/${turns} turns (${pct(get('routing.inject.turns'), turns)}); ` +
        `rules shown total=${get('routing.inject.rules')}`,
    );
    const ro = get('routing.outcome.success') + get('routing.outcome.failure');
    lines.push(
      `  routing outcomes recorded: success=${get('routing.outcome.success')} failure=${get('routing.outcome.failure')} (success ${pct(get('routing.outcome.success'), ro)})`,
    );
    lines.push(
      `  in-turn reminders fired=${get('inturn.fire')} (mechanical=${get('inturn.mechanical')}) — the cheap path that actually reaches the agent same-turn`,
    );
    lines.push(
      `  turn-close reflection: fired=${get('reflect.fire')} skipped_cooldown=${get('reflect.skip_cooldown')} → produced routing_rule=${get('reflect.routing_rule')} playbook=${get('reflect.playbook')} new_skill=${get('reflect.new_skill')} skill_refine=${get('reflect.skill_refine')}`,
    );
    lines.push(
      `  idle skill extraction: ran=${get('idle_reflect.ran')} suppressed_doomloop=${get('idle_reflect.suppressed')}`,
    );
    lines.push(
      `  auto-injected lessons: playbook turns=${get('playbook.inject.turns')} anti-pattern turns=${get('antipattern.inject.turns')}`,
    );
    // THE ONLY LINES HERE THAT ARE EFFECT AND NOT ACTIVITY.
    //
    // Everything above counts what the learning layer PRODUCED — rules written, reminders fired,
    // lessons injected. None of it can distinguish a system that learns from one that writes notes,
    // which is how "reflect.fire=753 / routing_rule=800" sat next to the same tool failure recurring
    // 38 times in the same week and read like health. These two count what CHANGED instead.
    const recurNew = get('learning.recurrence_after_rule.cross_turn');
    const recurSame = get('learning.recurrence_after_rule.intra_turn');
    lines.push(
      `  recurrence AFTER a rule was known: ${recurNew + recurSame} ` +
        `(new turn=${recurNew} — the rule did not stick; same turn=${recurSame} — the error text was ignored)`,
    );
    const applied = get('learning.repair.applied');
    const verified = get('learning.repair.verified');
    const noEffect = get('learning.repair.no_effect');
    const differentFailure = get('learning.repair.different_failure');
    const inconclusive = get('learning.repair.inconclusive');
    lines.push(
      `  mechanism-applied repairs: applied=${applied} verified=${verified} no_effect=${noEffect} ` +
        `different_failure=${differentFailure} inconclusive=${inconclusive} ` +
        `(verified ${pct(verified, applied)}) — ` +
        `a rule whose verified count never moves is a note, not a behaviour change`,
    );
    const replayed = get('learning.replay.verified') + get('learning.replay.no_effect')
      + get('learning.replay.different_failure') + get('learning.replay.inconclusive');
    if (replayed > 0 || get('learning.replay.not-attempted') > 0) {
      lines.push(
        `  rules replayed against their own past failure: ${replayed} ` +
          `(verified=${get('learning.replay.verified')} no_effect=${get('learning.replay.no_effect')} ` +
          `different_failure=${get('learning.replay.different_failure')} ` +
          `inconclusive=${get('learning.replay.inconclusive')} ` +
          `not-attempted=${get('learning.replay.not-attempted')}) — ` +
          `this is the count that no longer waits for the failure to recur`,
      );
    }
  } catch (e) {
    lines.push(`  [counters error: ${(e as Error)?.message}]`);
  }

  // 3) Routing-rule maturity distribution (derived from the table)
  try {
    const rules = memory.routingRules.listAll();
    const byConf = countBy(rules, (r) => r.confidence);
    lines.push('-- routing_rules (stored) --');
    lines.push(`  total=${rules.length} by confidence: ${JSON.stringify(byConf)}`);
    const validated = byConf['validated'] ?? 0;
    const provisional = byConf['provisional'] ?? 0;
    lines.push(
      `  validated=${validated} (${pct(validated, rules.length)}) · provisional-still=${provisional} · the higher 'provisional/disputed/retired' vs 'validated', the less the machinery is paying off`,
    );
  } catch (e) {
    lines.push(`  [routing_rules error: ${(e as Error)?.message}]`);
  }

  // 4) Skills maturity / kind distribution (derived)
  try {
    const skills = memory.skills.listAll(500);
    lines.push('-- skills (stored) --');
    lines.push(`  total=${skills.length} by maturity: ${JSON.stringify(countBy(skills, (s) => s.maturity))}`);
    lines.push(`  by kind: ${JSON.stringify(countBy(skills, (s) => s.kind ?? 'positive'))}`);
  } catch (e) {
    lines.push(`  [skills error: ${(e as Error)?.message}]`);
  }

  // 5) Tool-call activity + recurring failure signatures from the action log (derived)
  try {
    const cutoff = Date.now() - windowDays * 24 * 60 * 60_000;
    const rows = memory.db
      .prepare(
        `SELECT tool_name AS toolName, result, success FROM memory_actions WHERE timestamp >= ?`,
      )
      .all(cutoff) as Array<{ toolName: string; result: string | null; success: number }>;
    const calls = countBy(rows, (r) => r.toolName);
    lines.push('-- action log (derived) --');
    lines.push(`  search_skills calls=${calls['search_skills'] ?? 0} · use_skill calls=${calls['useSkill'] ?? calls['use_skill'] ?? 0} (does the agent pull learned skills?)`);
    const failSigs = countBy(
      rows.filter((r) => r.success === 0),
      (r) => extractFailureSignature(r.toolName, r.result),
    );
    const topFails = Object.entries(failSigs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    lines.push(`  top failure signatures: ${topFails.map(([s, n]) => `${s}×${n}`).join(', ') || '(none)'}`);
    lines.push(`    ^ a compute signature (pariGp:/leanCheck:/z3Verify:) still topping this AFTER the error-visibility fixes = the case where a learning subsystem might earn its keep`);
  } catch (e) {
    lines.push(`  [action log error: ${(e as Error)?.message}]`);
  }

  return lines.join('\n');
}
