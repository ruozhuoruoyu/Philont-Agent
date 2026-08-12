/**
 * Is the policy layer actually on the path?
 *
 * Five separate holes were found in two days, and they were the same hole five times: a control that
 * was written, unit-tested and carefully commented, sitting next to a call site that did not go
 * through it.
 *
 *   · the command gate — filtered out of the chain it was written for
 *   · classifyTool     — handed a lambda that dropped the params the decision needs
 *   · the plan sub-loop — calling the bare registry
 *   · the autonomous loop — same, on the path that runs unattended
 *   · grant_research_tool — minting the grants that make the rest of it optional
 *
 * None of them failed a test, because each mechanism's own tests passed: the mechanisms worked. What
 * was broken was their REACHABILITY, and nothing in a codebase this size makes that visible by
 * reading. Density has passed the point where "is this control in force?" is answerable by eye.
 *
 * So it is answered here instead. These are not tests of behaviour — the behaviour has its own tests
 * — they are tests that the behaviour is connected to anything. A new bypass has to be written down
 * as a deliberate exception, which is the point: the failures above were all silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const chatHandler = readFileSync(join(SRC, 'chat-handler.ts'), 'utf8');

/**
 * Every place that reaches the bare registry, and why that is allowed. `tools.execute()` performs no
 * authorization of any kind — it looks a tool up and invokes it — so each call site is either behind
 * a checker or is a deliberate exception with a reason someone had to write.
 */
const BARE_EXECUTE_EXCEPTIONS: Array<{ contains: string; why: string }> = [
  {
    contains: 'const r = await tools.execute(name, input);',
    why: 'subTurnToolRunner — checked immediately above by getSubLoopChecker (see the runner test below)',
  },
  {
    contains: 'const result = await tools.execute(',
    why: 'autonomousToolRunner — checked immediately above by getSubLoopChecker (see the runner test below)',
  },
  {
    contains: 'const validation = await tools.execute(call.name, call.input);',
    why: 'askUserQuestion schema validation only; the call itself was already checked in the loop',
  },
  {
    contains: 'result = await tools.execute(call.name, sanitized.input);',
    why: 'main tool loop, after checker() decided this call',
  },
  {
    contains: 'result = await tools.execute(call.name, sanitized2.input);',
    why: 'main tool loop second iteration, after checker() decided this call',
  },
];

function callSites(source: string, needle: RegExp): Array<{ line: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((l) => needle.test(l.text) && !l.text.startsWith('*') && !l.text.startsWith('//'));
}

test('every path to the bare registry is either checked or a written-down exception', () => {
  const sites = callSites(chatHandler, /\btools\.execute\(/);
  assert.ok(sites.length > 0, 'the scan itself must not silently match nothing');

  const unexplained = sites.filter(
    (s) => !BARE_EXECUTE_EXCEPTIONS.some((e) => s.text.includes(e.contains.trim())),
  );
  assert.deepEqual(
    unexplained.map((s) => `chat-handler.ts:${s.line}: ${s.text}`),
    [],
    'A new call to tools.execute() reaches tools with NO authorization of any kind — no matrix, no ' +
      'grants, no validator chain, no path ACL, no command gate. Route it through a checker, or add ' +
      'it to BARE_EXECUTE_EXCEPTIONS with the reason it is safe.',
  );
});

test('the exception list stays honest: every entry still exists in the source', () => {
  for (const e of BARE_EXECUTE_EXCEPTIONS) {
    assert.ok(
      chatHandler.includes(e.contains),
      `stale exception — this call site is gone, so the entry should be too: ${e.contains}`,
    );
  }
});

/**
 * The two runners that feed a sub-agent loop. Both spent their whole life calling the bare registry;
 * a sub-model composed the arguments and nothing read them.
 */
test('sub-agent runners consult the checker before executing', () => {
  for (const runner of ['subTurnToolRunner', 'autonomousToolRunner']) {
    const start = chatHandler.indexOf(`const ${runner}`);
    assert.ok(start > 0, `${runner} not found — renamed? this test needs updating with it`);
    const body = chatHandler.slice(start, chatHandler.indexOf('tools.execute(', start));
    assert.match(
      body,
      /getSubLoopChecker\(\)/,
      `${runner} reaches tools.execute() without a policy check in between`,
    );
  }
});

/**
 * The input is part of the authorization decision — http is read × network until you look at
 * `method`, and write × network after. A lambda that drops the second argument silently reverts
 * every dynamically-classified tool to its static declaration.
 */
test('every classifyTool passes the params through', () => {
  const sites = callSites(chatHandler, /classifyTool:/);
  assert.ok(sites.length > 0, 'the scan itself must not silently match nothing');
  for (const s of sites) {
    assert.match(
      s.text,
      /classifyTool:\s*\(\s*name\s*,\s*params\s*\)\s*=>.*classify\(\s*name\s*,\s*params\s*\)/,
      `chat-handler.ts:${s.line} drops the params: ${s.text}\n` +
        'A name-only classifier judges http POST as the read its static declaration claims to be.',
    );
  }
});

/**
 * The grant-action patterns require a COMMAND-scope grant, which a tool-scope one deliberately does
 * not satisfy. They were filtered out of the production chain for two months.
 */
test('the dangerous-command chain is not filtered down to deny-only', () => {
  assert.doesNotMatch(
    chatHandler,
    /dangerousCommands:\s*createDangerousCommandValidator\(\{\s*\n?\s*patterns:\s*DEFAULT_DANGEROUS_PATTERNS\.filter\(\(p\)\s*=>\s*p\.defaultAction\s*===\s*'deny'\)/,
    'the grant-action patterns are filtered out again — git push, credential reads and curl|sh stop ' +
      'being gated, which is the state that let a plain `git push` publish 902 files',
  );
  assert.match(
    chatHandler,
    /createDangerousCommandValidator\(\{\s*patterns:\s*commandGatePatterns\(\)\s*\}\)/,
    'the chain should read its patterns from commandGatePatterns(), which honours PHILONT_COMMAND_GATE',
  );
});

/**
 * An escape hatch whose blast radius is larger than its name is how an escape hatch becomes the
 * incident. PHILONT_SUBLOOP_POLICY=off says "stop asking me"; it must not also say "let a background
 * plan write to ~/.ssh or pipe a credential out".
 */
test('turning the sub-loop policy off does not turn off the things nobody can grant', () => {
  const runners = chatHandler.slice(chatHandler.indexOf('const subTurnToolRunner'));
  assert.match(
    runners,
    /subLoopPolicyEnabled\(\)\s*\?\s*getSubLoopChecker\(\)\s*:\s*getSubLoopFloorChecker\(\)/,
    'with the flag off a runner must fall back to the floor checker, not to no check at all',
  );
  // And the floor must be the deep chain: catastrophic commands, sensitive paths, exfiltration.
  const floor = chatHandler.slice(
    chatHandler.indexOf('function getSubLoopFloorChecker'),
    chatHandler.indexOf('const subTurnToolRunner'),
  );
  assert.match(floor, /validatorChain:\s*conservativeValidatorChain/, 'the floor keeps the validator chain');
  assert.doesNotMatch(floor, /grantStore/, 'the floor decides what is never done, not who may do it');
});

/**
 * A research approval is for the research loop. Grants are matched by tool name, so without an
 * audience the same yes covered the main loop and any plan sub-task for the whole window.
 */
test('research grants are issued with an audience on every path that issues them', () => {
  const issuances = chatHandler.split('grants.grant({').slice(1);
  const researchIssuances = issuances.filter((block) => block.slice(0, 400).includes('research:'));
  assert.ok(researchIssuances.length > 0, 'the scan must not silently match nothing');
  for (const block of researchIssuances) {
    assert.match(
      block.slice(0, 400),
      /audience:\s*researchGrantAudience\(/,
      'a research grant issued without a per-pursuit audience answers for research that never asked',
    );
  }
});

// ── the reply has one address, and one claimant ─────────────────────────────────────────────────
// Wiring invariants for research authorization and the deep-explore ask. The behaviour lives in
// pending_decisions.test.ts; these assert that the handler is CONNECTED to it — the failure mode
// this whole week has been about.

test('the address is resolved once, before any module reads its own map', () => {
  const entry = chatHandler.indexOf('const outstandingDecisions = pendingDecisions.list(sessionId);');
  const askRead = chatHandler.indexOf('const exploreAsk = pendingExploreAsk.get(sessionId);');
  const researchRead = chatHandler.indexOf('const rg = pendingResearchGrants.get(sessionId);');
  assert.ok(entry > 0, 'entry resolution not found');
  assert.ok(entry < askRead, 'the deep-explore ask must not read its map before the address is known');
  assert.ok(entry < researchRead, 'nor may research authorization');
});

test('both wired modules act only when the address names them', () => {
  // The guard has to be ON THE BRANCH, not merely computed above it. Asserting that the expression
  // appears somewhere in the file passes while `if (exploreAsk && addressedToAsk)` decays back to
  // `if (exploreAsk)` — measuring that the guard was written rather than that it decides anything,
  // which is the failure this file exists to catch.
  assert.match(
    chatHandler,
    /if \(exploreAsk && addressedToAsk\) \{/,
    'the deep-explore ask must be entered only for a reply addressed to it',
  );
  assert.match(
    chatHandler,
    /if \(rg && addressedToResearch\) \{/,
    'research authorization must be entered only for a reply addressed to it',
  );
  // And the guards must be derived from the entry resolution, not from something local.
  assert.match(chatHandler, /resolvedDecision\?\.decision\.id === exploreAsk\.decisionId/);
  assert.match(chatHandler, /signalBus\.resolvedDecisionId === rg\.decisionId/);
});

test('an unaddressed message no longer destroys the deep-explore ask', () => {
  // It was deleted before its reply was even examined, so "帮我看下日志" discarded a question the
  // owner had been asked. The delete now sits behind the address check.
  const block = chatHandler.slice(
    chatHandler.indexOf('const exploreAsk = pendingExploreAsk.get(sessionId);'),
    chatHandler.indexOf('const exploreAsk = pendingExploreAsk.get(sessionId);') + 600,
  );
  const deleteAt = block.indexOf('pendingExploreAsk.delete(sessionId);');
  const guardAt = block.indexOf('if (exploreAsk && addressedToAsk) {');
  assert.ok(guardAt >= 0, 'the delete must sit behind the address check, not beside a computed flag');
  assert.ok(guardAt < deleteAt, 'and the check must come first');
});

test('the semantic classifier reads the verdict, never picks the target', () => {
  const block = chatHandler.slice(chatHandler.indexOf('const rg = pendingResearchGrants.get(sessionId);'));
  assert.match(
    block.slice(0, 2000),
    /classifyGrantReply\(verdictText\)/,
    'the closed-enum reader must see the verdict text, not the whole message',
  );
  assert.match(block.slice(0, 2500), /classifyAuthIntent\(\s*verdictText/, 'and so must the semantic one');
});

test('every card carries an id before it is shown', () => {
  assert.match(chatHandler, /decisionId: registerResearchDecision\(sid\)/, 'wechat/telegram push');
  assert.match(chatHandler, /payload: \{ decisionId/, 'the web-ui card carries it too, for a button');
  assert.match(chatHandler, /decisionId: askDecisionId/, 'the deep-explore ask');
});

test('resolving a card takes it out of the book on every terminal path', () => {
  const block = chatHandler.slice(chatHandler.indexOf('const rg = pendingResearchGrants.get(sessionId);'));
  const resolves = block.split('pendingDecisions.resolve(sessionId, rg.decisionId)').length - 1;
  assert.ok(resolves >= 2, `grant and deny must both clear the card, found ${resolves}`);
});

test('a resolution is audited as it happens, not reconstructed later', () => {
  assert.match(chatHandler, /function auditDecisionResolution/);
  assert.match(chatHandler, /auditDecisionResolution\(sessionId, decision, routed\.how, routed\.verdictText\)/);
  const fn = chatHandler.slice(chatHandler.indexOf('function auditDecisionResolution'));
  for (const field of ['decisionId', 'decisionKind', 'addressedBy', 'verdict', 'principal']) {
    assert.match(fn.slice(0, 900), new RegExp(field), `the record must carry ${field}`);
  }
});
