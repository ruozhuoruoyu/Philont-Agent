/**
 * H3 skill self-repair — one-shot dogfood against a REAL model.
 *
 * The end-to-end unit tests (agent-memory/tests/skill_repair_loop.test.ts) prove the pipeline wires up,
 * but with a canned LLM reply. The one thing they cannot answer is the only thing that matters for
 * flipping PHILONT_SKILL_REPAIR on by default: does a real model, handed a recipe's real failed runs,
 * produce a *good* fix? This script answers that once, on demand, and prints the before/after so you can
 * judge it by eye.
 *
 * It uses a throwaway in-memory DB — it never touches your real ~/.philont memory. It needs whatever
 * model env your normal server uses (ANTHROPIC_API_KEY, or LLM_PROVIDER + that provider's key). One real
 * LLM call.
 *
 *   Usage:  (cd server && npx tsx scripts/skill-repair-dogfood.ts)
 *           # optionally seed a different broken recipe:
 *           SKILL_REPAIR_SCENARIO=nested-braces npx tsx scripts/skill-repair-dogfood.ts
 */

import '../src/load-env.js'; // MUST be first: loads .env so createLLMAdapter() sees the real model config
import {
  openMemoryDb,
  StandardExecutor,
  SkillRepairDriver,
  skillRevisionWriter,
  isRepairCandidate,
  type ExtractorLlmClient,
  type SkillRepairContext,
  type ToolRunner,
  type Initiative,
} from '@agent/memory';
import { createLLMAdapter } from '../src/llm-adapter.js';

/** A broken recipe + the real failure output the model will diagnose from. */
interface Scenario {
  name: string;
  actionTemplate: string;
  verification: { kind: 'tool_result_ok' | 'assert' | 'compute_recheck'; check: string };
  toolPolicy: string[];
  failureResult: string;
  failureTool: string;
}

const SCENARIOS: Record<string, Scenario> = {
  // The default: a recipe that shells out to a binary that isn't installed. The "right" fix is to
  // pre-flight `command -v` and report, not to keep invoking a missing binary.
  'missing-binary': {
    name: 'md-to-docx-recipe',
    actionTemplate: 'Step 1: run shell `pandoc in.md -o out.docx`. Step 2: readFile out.docx to confirm.',
    verification: { kind: 'tool_result_ok', check: 'readFile out.docx succeeds' },
    toolPolicy: ['shell', 'readFile'],
    failureTool: 'shell',
    failureResult: '⚠ TOOL FAILED: bash: pandoc: command not found',
  },
  // A pari/gp recipe that fails on the well-known nested-brace syntax trap (see gp.ts).
  'nested-braces': {
    name: 'oeis-verify-recipe',
    actionTemplate: 'Run pariGp with a script that wraps the loop body in nested `{ ... { ... } }` braces.',
    verification: { kind: 'compute_recheck', check: 'pariGp exits 0 and prints terms' },
    toolPolicy: ['pariGp'],
    failureTool: 'pariGp',
    failureResult: '⚠ TOOL FAILED: pariGp: syntax error, embedded braces are not allowed near `{`',
  },
};

async function main(): Promise<void> {
  const scenarioKey = process.env.SKILL_REPAIR_SCENARIO ?? 'missing-binary';
  const scenario = SCENARIOS[scenarioKey];
  if (!scenario) {
    console.error(`Unknown scenario "${scenarioKey}". Options: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  const h = openMemoryDb(':memory:'); // throwaway — never touches real memory

  h.skills.createSkill({
    name: scenario.name,
    description: `dogfood: ${scenarioKey}`,
    triggerKeywords: [scenarioKey],
    actionTemplate: scenario.actionTemplate,
    verification: scenario.verification,
    toolPolicy: scenario.toolPolicy,
    maturity: 'playbook', // as recordLinkedSkillOutcomes leaves a demote_revise
  });
  for (let i = 0; i < 3; i++) {
    h.actions.log({
      sessionId: 'dogfood',
      toolName: scenario.failureTool,
      params: {},
      result: scenario.failureResult,
      success: false,
      linkedSkill: scenario.name,
    });
  }

  // Guard: without a real provider, createLLMAdapter() returns the mock (which echoes the prompt's
  // example JSON), and the run would print a meaningless "inconclusive". Fail loudly instead so the
  // signal is "your env isn't set", not "the model couldn't fix it".
  const provider = (process.env.LLM_PROVIDER || 'mock').toLowerCase();
  if (provider === 'mock') {
    console.error(
      '\n✗ No real model configured (LLM_PROVIDER is unset → mock mode).\n' +
      '  This dogfood needs the SAME env your server uses. Make sure `.env` exists in this dir (or set\n' +
      '  PHILONT_ENV_FILE) with LLM_PROVIDER + its key — the same config `npm run dev` loads. Nothing was run.',
    );
    process.exit(1);
  }

  const base = createLLMAdapter();
  const llm: ExtractorLlmClient = {
    async complete(prompt: string) {
      const resp = await base.send([{ role: 'user', content: prompt }]);
      return { text: resp.type === 'text' ? resp.content : '', tokensUsed: 0 };
    },
  };

  const skillRepairContext = (skillName: string): SkillRepairContext | null => {
    const s = h.skills.getByName(skillName);
    if (!s || !isRepairCandidate(s) || !s.verification) return null;
    return {
      actionTemplate: s.actionTemplate,
      verification: s.verification,
      toolPolicy: s.toolPolicy,
      failures: h.actions
        .getBySkill(skillName, { onlyFailed: true, limit: 5 })
        .map((a) => ({ toolName: a.toolName, result: a.result, timestamp: a.timestamp })),
    };
  };

  const noTools: ToolRunner = {
    async run(name) {
      throw new Error(`a repair must call no tools; called ${name}`);
    },
  };

  const executor = new StandardExecutor({
    facts: h.facts,
    notes: h.notes,
    llm,
    tools: noTools,
    skillRepairContext,
    maxLlmOutputTokens: 1200, // a rewritten recipe body can be longer than a research summary
  });
  const writer = skillRevisionWriter(h.skills);

  const driver = new SkillRepairDriver();
  const proposals = driver.propose({
    facts: [], routingRules: [], skills: h.skills.listAll(50), activePursuits: [],
    recentTimelineTokens: [], recentDoneTargetRefs: new Set(), now: Date.now(),
  });
  if (proposals.length === 0) {
    console.error('Driver produced no proposal — the seeded recipe is not a repair candidate. Bug?');
    process.exit(1);
  }

  const before = h.skills.getByName(scenario.name)!;
  console.log('\n=== BEFORE ===');
  console.log(`recipe:        ${before.name}  (maturity=${before.maturity})`);
  console.log(`steps:         ${before.actionTemplate}`);
  console.log(`verification:  ${JSON.stringify(before.verification)}`);
  console.log(`failed runs:   ${scenario.failureResult}`);

  console.log('\n… calling the real model to diagnose …\n');
  const init: Initiative = {
    ...proposals[0],
    id: 'dogfood-1',
    status: 'running',
    budgetActual: null,
    outcomeSummary: null,
    outcomeRefs: null,
    error: null,
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  };
  const result = await executor.run(init);

  console.log('=== MODEL RESULT ===');
  console.log(`status:        ${result.status}`);
  console.log(`summary:       ${result.outcomeSummary ?? '(none)'}`);
  if (result.error) console.log(`error:         ${result.error}`);
  if (!result.skillRevision) {
    console.log('\n⚠ The model proposed NO fix (inconclusive). The recipe stays advisory — this is a');
    console.log('  valid, safe outcome, but if it happens on a CLEARLY fixable case, the prompt needs work.');
    h.close();
    return;
  }

  writer(init, result);
  const after = h.skills.getByName(scenario.name)!;
  console.log('\n=== AFTER (written back) ===');
  console.log(`maturity:      ${after.maturity}  (should be "draft")`);
  console.log(`diagnosis:     ${result.skillRevision.diagnosis}`);
  console.log(`new steps:     ${after.actionTemplate}`);
  console.log(`verification:  ${JSON.stringify(after.verification)}`);
  console.log(`history depth: ${after.revisionHistory.length}  (should be 1, holding the old version)`);

  console.log('\n=== YOUR CALL ===');
  console.log('Is the new recipe actually better than the old one — does it address the real failure');
  console.log('(and not just reword it)? If yes across a few scenarios, PHILONT_SKILL_REPAIR is ready to');
  console.log('default on. If it rewords without fixing, or "fixes" a non-problem, the diagnosis prompt');
  console.log('(renderSkillRepairPrompt in agent-memory/src/autonomous/executor.ts) needs tightening.');
  h.close();
}

main().catch((e) => {
  console.error('dogfood failed:', e);
  process.exit(1);
});
