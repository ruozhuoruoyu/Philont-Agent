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
    contains: '? withBudgetNotice(await tools.execute(call.name, fitted.input), fitted.notice)',
    why:
      'main tool loop, after checker() decided this call; fitToolCallToTurn may narrow the wall-clock ' +
      'timeout to what the turn has left, and puts that REWRITTEN input back through checker() before ' +
      'it is used (see the turn-budget test below)',
  },
  {
    contains: '? withBudgetNotice(await tools.execute(call.name, fitted2.input), fitted2.notice)',
    why: 'main tool loop second iteration, same path and same re-check as the site above',
  },
  {
    contains: 'return tools.execute(call.name, input);',
    why:
      'mechanism-initiated repair — a rewrite is a different call than the one that was approved, so ' +
      'attemptMechanicalRepair puts the REWRITTEN arguments back through checker() (isSafeToRerun) and ' +
      'runs this only when that returns allowed; the surrounding callback also charges the second tool call',
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
  // Matches grants.grant({ …, globalGrants.grant({ … and effects.grant({ … — the issuance has moved
  // once already, and a scan anchored to one caller name goes quietly blind when it moves again.
  const issuances = chatHandler.split(/\.grant\(\{/).slice(1);
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
  const researchRead = chatHandler.indexOf('const rg = researchPayloadFor(signalBus);');
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
  const block = chatHandler.slice(chatHandler.indexOf('const rg = researchPayloadFor(signalBus);'));
  assert.match(
    block.slice(0, 2000),
    /classifyGrantReply\(verdictText\)/,
    'the closed-enum reader must see the verdict text, not the whole message',
  );
  assert.match(block.slice(0, 2500), /classifyAuthIntent\(\s*verdictText/, 'and so must the semantic one');
});

test('every card carries an id before it is shown', () => {
  assert.match(chatHandler, /const decisionId = registerResearchDecision\(sid, \{/, 'wechat/telegram push');
  assert.match(chatHandler, /payload: \{ decisionId/, 'the web-ui card carries it too, for a button');
  assert.match(chatHandler, /decisionId: askDecisionId/, 'the deep-explore ask');
});

test('resolving a card takes it out of the book on every terminal path', () => {
  const block = chatHandler.slice(chatHandler.indexOf('const rg = researchPayloadFor(signalBus);'));
  const resolves = block.split('pendingDecisions.resolve(sessionId, rg.decisionId!)').length - 1;
  assert.ok(resolves >= 3, `grant, deny and expiry must all clear the card, found ${resolves}`);
});

test('addressing and applying are recorded separately', () => {
  // One record used to be written the moment the router matched — before the module validated its
  // payload, decided, granted or resumed anything. In the case that prompted the split, the ledger
  // said "resolved A" while nothing had happened to A at all.
  assert.match(chatHandler, /function auditDecisionAddressed/);
  assert.match(chatHandler, /function auditDecisionApplied/);
  assert.match(chatHandler, /auditDecisionAddressed\(sessionId, decision, routed\.how, routed\.verdictText\)/);
  for (const outcome of ["'granted'", "'denied'", "'expired'"]) {
    assert.ok(chatHandler.includes(`auditDecisionApplied(sessionId, rg.decisionId!, ${outcome}`), `research ${outcome}`);
  }
  const fn = chatHandler.slice(chatHandler.indexOf('function auditDecisionAddressed'));
  for (const field of ['decisionId', 'decisionKind', 'addressedBy', 'verdict', 'principal']) {
    assert.match(fn.slice(0, 900), new RegExp(field), `the record must carry ${field}`);
  }
});

test('the research payload is keyed by decision, not by conversation', () => {
  // The book held [A, B] while the payload map held only B, so approving A matched nothing and did
  // nothing — a card that is addressable with no record behind it. Half a fix reads exactly like a
  // whole one from outside: the card is there, the reply is understood, the grant never happens.
  assert.match(
    chatHandler,
    /const pendingResearchGrants = new Map<string, PendingResearchGrant & \{ sessionId: string \}>\(\);/,
    'keyed by decision id, with the session carried inside',
  );
  assert.doesNotMatch(
    chatHandler,
    /pendingResearchGrants\.(get|set)\(sessionId/,
    'never "the most recent one in this conversation" — that is what applied A\'s answer to B',
  );
  assert.match(chatHandler, /pendingResearchGrants\.get\(signalBus\.resolvedDecisionId\)/);
});

test('modules that have not migrated still obey the address', () => {
  // pendingAuth is consulted BEFORE research, so without this a "同意" quoted at a research card
  // resolves correctly at entry and is then spent by the tool authorization anyway.
  assert.match(
    chatHandler,
    /pendingAuthBlock: if \(pending && !claimedByAnotherDecision\(signalBus\)\) \{/,
    'tool authorization must yield when the message was addressed elsewhere',
  );
  assert.match(
    chatHandler,
    /if \(pendingQ && !claimedByAnotherDecision\(signalBus\)\) \{/,
    'and so must askUserQuestion',
  );
});

test('there is no mode in which the router silently disables the decisions it watches', async () => {
  // `shadow` set no resolved id while both wired branches required one, so research and the
  // deep-explore ask could be neither approved nor denied — under a name that reads like observation.
  assert.doesNotMatch(chatHandler, /PHILONT_PENDING_ROUTER/);
  assert.doesNotMatch(chatHandler, /pendingRouterMode/);
});

test('claimedByAnotherDecision: a module acts only on its own decision', async () => {
  const { claimedByAnotherDecision } = await import('../src/chat-handler.js');
  // Nothing addressed: every module behaves as it always did.
  assert.equal(claimedByAnotherDecision({} as never, undefined), false);
  assert.equal(claimedByAnotherDecision({} as never, 'r1'), false);
  // Addressed elsewhere: hands off, even though this module has no id of its own yet.
  assert.equal(claimedByAnotherDecision({ resolvedDecisionId: 'r1' } as never, undefined), true);
  assert.equal(claimedByAnotherDecision({ resolvedDecisionId: 'r1' } as never, 'other'), true);
  // Addressed to me.
  assert.equal(claimedByAnotherDecision({ resolvedDecisionId: 'r1' } as never, 'r1'), false);
});

test('the tail reports what is still waiting, including a card that was named but not answered', () => {
  // It was imported and never called, while the summary said ordinary replies carried a reminder.
  // A claim about behaviour with no call site is the same defect as a gate with no call site.
  assert.match(chatHandler, /renderPendingTail\(\s*\n?\s*stillWaiting,/);
  assert.match(chatHandler, /const stillWaiting = pendingDecisions\.list\(sessionId\);/);
  // And it must NOT subtract the decision this message addressed. Addressing is not answering: a
  // reply that names a card to ask what it means leaves the card open, and the book — which no
  // longer holds anything resolved this turn — is already the exact outstanding set.
  const line = chatHandler.slice(chatHandler.indexOf('const stillWaiting = pendingDecisions.list('));
  assert.doesNotMatch(
    line.slice(0, 200),
    /resolvedDecisionId/,
    'subtracting the addressed decision hides a card that is still waiting',
  );
});

test('a card and the payload behind it are created in one place', () => {
  // They were written in two, and drifted: the book held [A, B] while the payload map held only B,
  // so an approval for A matched nothing and did nothing — silently, and indistinguishably from a
  // card that works. Nothing else may write into the payload map.
  const writes = chatHandler.match(/pendingResearchGrants\.set\(/g) ?? [];
  assert.equal(writes.length, 1, `only registerResearchDecision may create a payload, found ${writes.length}`);
  const fn = chatHandler.slice(
    chatHandler.indexOf('export function registerResearchDecision('),
    chatHandler.indexOf('export function researchPayloadFor('),
  );
  assert.match(fn, /pendingDecisions\.add\(sid, \{/, 'the addressable card');
  assert.match(fn, /pendingResearchGrants\.set\(id, \{/, 'and its payload, under the same id');
});

test('the payload is fetched by the resolved id and by nothing else', () => {
  const fn = chatHandler.slice(chatHandler.indexOf('export function researchPayloadFor('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /pendingResearchGrants\.get\(signalBus\.resolvedDecisionId\)/);
  assert.doesNotMatch(body, /\.get\(sessionId\)|values\(\)/, 'never "the latest one in this conversation"');
});

test('a card is consumed only by a terminal verdict', () => {
  // The ask-tier offer was deleted at the top of its branch, before the reply had been classified.
  // That made "d3 这是什么意思？" — addressed, non-empty, and not an answer — destroy it. The delete
  // and the resolve must live inside the terminal arms and nowhere else.
  //
  // Derived from the arms rather than from their spelling: the first version of this test pinned the
  // literal `if (askIntent === 'grant') {` plus a 400-character window, and went red the day an `auto`
  // verdict was added to that same arm — a correct change, a failing test, and nothing wrong with the
  // code. What must hold is the PROPERTY: an arm that records a verdict also consumes the card.
  const start = chatHandler.indexOf('if (exploreAsk && addressedToAsk) {');
  const branch = chatHandler.slice(start, chatHandler.indexOf('// Interrupt teeth:', start));
  assert.ok(branch.length > 200, 'ask-tier branch not found');

  // Split the if/else chain into arms at each `askIntent === '…'` test.
  const armStarts = [...branch.matchAll(/(?:if|else if)\s*\(askIntent[^)]*\)\s*\{/g)].map((m) => m.index!);
  assert.ok(armStarts.length >= 2, `expected at least the grant and deny arms, found ${armStarts.length}`);
  const arms = armStarts.map((from, i) => branch.slice(from, armStarts[i + 1] ?? branch.length));

  // A terminal arm is one that records a verdict. Every one of them must consume and clear the card.
  const terminal = arms.filter((a) => /exploreAskApproved|exploreAskDeclined/.test(a));
  assert.ok(terminal.length >= 2, `expected grant-like and deny-like arms, found ${terminal.length}`);
  for (const arm of terminal) {
    const head = arm.slice(0, arm.indexOf('\n', arm.indexOf('{')) + 1).trim();
    assert.match(arm, /pendingExploreAsk\.delete\(sessionId\);/, `${head} must consume`);
    assert.match(arm, /pendingDecisions\.resolve\(sessionId, exploreAsk\.decisionId!\);/, `${head} must clear`);
  }
  // Non-terminal arms take nothing.
  for (const arm of arms.filter((a) => !/exploreAskApproved|exploreAskDeclined/.test(a))) {
    assert.doesNotMatch(arm, /pendingExploreAsk\.delete\(sessionId\);/, 'a non-verdict arm must not consume the card');
  }
  // Terminal arms + expiry, and nothing else, delete it.
  const deletes = branch.split('pendingExploreAsk.delete(sessionId);').length - 1;
  assert.equal(deletes, terminal.length + 1, `terminal arms + expiry only — found ${deletes}`);
  // The unclear arm exists and takes nothing.
  assert.match(branch, /ask-tier addressed without a verdict → offer stands/);
});

test('the state change happens before the record of it', () => {
  const branch = chatHandler.slice(chatHandler.indexOf('const rg = researchPayloadFor(signalBus);'));
  for (const [verdict, label] of [['grant', 'granted'], ['deny', 'denied']]) {
    const call = branch.indexOf(`applyResearchDecision({ payload: rg, verdict: '${verdict}'`);
    assert.ok(call > 0, `${verdict} must go through the applier`);
    // Measured from the branch, not from the applier call — slicing forward from the call cannot see
    // a record written BEFORE it, which is the whole failure. (Found by reintroducing exactly that.)
    const record = branch.indexOf(`auditDecisionApplied(sessionId, rg.decisionId!, '${label}'`);
    assert.ok(record > 0, `${verdict} must record its outcome`);
    assert.ok(record > call, `${label} must not be recorded before the change that earns it`);

    const after = branch.slice(call, record);
    assert.match(after, /if \(!outcome\.applied\) \{/, `${verdict} must check the outcome first`);
    assert.match(after, /auditDecisionApplied\(sessionId, rg\.decisionId!, 'failed', outcome\.reason\)/);
    assert.ok(
      after.indexOf('return { outcome: { outcomeType:') < after.lastIndexOf('}'),
      `a failed ${verdict} must not fall through into the success path`,
    );
  }
});

test('decision_failed has a call site, not just a signature', () => {
  // The three-state audit shipped as an interface with one state unreachable.
  const failures = chatHandler.match(/auditDecisionApplied\([^)]*'failed'/g) ?? [];
  assert.ok(failures.length >= 2, `grant and deny must both be able to fail, found ${failures.length}`);
});

test('an expiring card takes its payload with it', () => {
  // list() dropped stale cards silently: the address vanished, the payload map kept its entry
  // forever, and the handler's own expired branch became unreachable — it can only run for a
  // decision the router resolved, and the router cannot resolve what list() has already hidden.
  assert.match(chatHandler, /new PendingDecisionBook\(\(sessionId, decision\) => \{/, 'the hook is installed');
  assert.match(chatHandler, /onDecisionExpired\(sessionId, decision\)/);
  const fn = chatHandler.slice(chatHandler.indexOf('function onDecisionExpired('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /pendingResearchGrants\.delete\(decision\.id\)/, 'the payload goes');
  assert.match(body, /'expired'/, 'and it is recorded');
  assert.doesNotMatch(
    body,
    /setQuestionPendingTool/,
    'expired is not denied — withdrawing the request would decide something the owner did not',
  );
});

/**
 * Recency is not a binding. `getMostRecentActiveSession` answers "which tree was touched last", which
 * is only ever safe for "is there a tree at all". Every place that reads a session's GOAL, TREE or
 * STALL state on behalf of this turn must use the owner's explicit focus, or a background round on an
 * unrelated project silently supplies the goal (prod 2026-08-25 23:35: LRC work judged against the
 * Riemann session's frontier). Three more sites were still on recency after that fix — the execution
 * ledger going into the prompt, the explore-control focus, and the next-turn stop recommendation — so
 * the rule is written down here rather than left to be re-found.
 */
const RECENCY_EXISTENCE_CHECKS: Array<{ contains: string; why: string }> = [
  { contains: 'hasActiveSession: memory.reasoning.getMostRecentActiveSession(sessionId) != null', why: 'existence only — force-start asks whether ANY session is open' },
  { contains: 'if (memory.reasoning.getMostRecentActiveSession(sessionId) == null) return text', why: 'existence only — no session means nothing to check the text against' },
  { contains: 'ownerReasoningActive: !!memory.reasoning.getMostRecentActiveSession(sessionId)', why: 'existence only — a boolean for the claim-grounding chain' },
];

test('recency answers existence and nothing else', () => {
  const sites = callSites(chatHandler, /getMostRecentActiveSession\(/);
  const bindings = sites.filter(
    (s) => !RECENCY_EXISTENCE_CHECKS.some((e) => s.text.includes(e.contains)),
  );
  assert.deepEqual(
    bindings.map((s) => `chat-handler.ts:${s.line}: ${s.text}`),
    [],
    'This reads a session on behalf of the turn by RECENCY. Use focusedReasoningSession(owner) — the ' +
      'owner\'s explicit binding — or, if the answer really is just "is one open", add it to ' +
      'RECENCY_EXISTENCE_CHECKS with the reason.',
  );
});

test('the recency allowlist stays honest: every entry still exists', () => {
  for (const e of RECENCY_EXISTENCE_CHECKS) {
    assert.ok(chatHandler.includes(e.contains), `stale entry — the call site is gone: ${e.contains}`);
  }
});

/**
 * The turn-budget clamp rewrites an approved call's arguments. A rewrite is a different call than the
 * one that was approved — the rule mechanical repair already follows — so the narrowed input has to go
 * back through the checker before it runs. This asserts the wire, not the arithmetic: the arithmetic is
 * tested in tool_time_budget.test.ts.
 */
test('the turn-budget clamp re-checks the call it rewrote', () => {
  const fit = chatHandler.slice(
    chatHandler.indexOf('async function fitToolCallToTurn('),
    chatHandler.indexOf('function withBudgetNotice('),
  );
  assert.ok(fit.length > 0, 'the scan itself must not silently match nothing');
  assert.match(fit, /isSafeToRerun\(rewritten\)/,
    'the narrowed input must be re-authorized, not assumed safe because it is narrower');
  for (const site of ['fitted', 'fitted2']) {
    const call = chatHandler.slice(chatHandler.indexOf(`const ${site} = await fitToolCallToTurn(`));
    assert.match(call.slice(0, 600), /checker\(\{ toolName: call\.name, approval: 'never'/,
      `${site} must pass the real checker, not a lambda that says yes`);
  }
});

/**
 * The in-turn tool block tells the model a tool is disabled and then has to make that true. It could
 * not: nothing counted the calls that came after it, so `deep_explore:other:rejected_by_in_turn_reflection`
 * reached 120 in one week — every one an LLM round trip and a tool slot taken from the turn that was
 * supposed to be writing the owner a reply. This asserts the wire; the report split has its own test.
 */
test('the in-turn tool block enforces itself instead of repeating advice', () => {
  const site = chatHandler.slice(
    chatHandler.indexOf('[in-turn-reflection blocked]'),
    chatHandler.indexOf('[in-turn-reflection blocked]') + 1500,
  );
  assert.ok(site.length > 0, 'the scan itself must not silently match nothing');
  assert.match(site, /blockedToolRejections\+\+/, 'the rejections after a block must be counted');
  assert.match(site, /blockedToolStop = call\.name/, 'reaching the cap must record the stop');

  // And the stop has to be acted on BEFORE the next LLM call, or the enforcement costs a round trip.
  const guard = chatHandler.slice(chatHandler.indexOf('if (blockedToolStop) {'));
  assert.match(guard.slice(0, 800), /break;/, 'the guard must leave the tool loop');
  // The loop's LLM call is the first one AFTER the guard; an earlier sendLlmWithRescue belongs to
  // the flat-text branch, a different function.
  const guardAt = chatHandler.indexOf('if (blockedToolStop) {');
  const loopStart = chatHandler.lastIndexOf('for (let i = startIteration + 1; i < effectiveMax; i++) {', guardAt);
  const llmCallAt = chatHandler.indexOf('response = await sendLlmWithRescue(', guardAt);
  assert.ok(loopStart > -1 && loopStart < guardAt && guardAt < llmCallAt,
    'the guard must sit inside the tool loop and above its LLM call, so enforcing costs nothing');
});

/**
 * A spent budget used to end in three silent places: the forced-continue decision returned null, the
 * driver notified once and disarmed itself, and no code path could raise the ceiling. These assert the
 * three wires that replace that — the arithmetic has its own tests in explore_budget.test.ts.
 */
test('a spent budget reaches the owner as a card, and the owner\'s answer reaches the ledger', () => {
  const decide = chatHandler.slice(
    chatHandler.indexOf('export async function decideForcedDeepExploreCall('),
    chatHandler.indexOf('export async function decideForcedDeepExploreCall(') + 1600,
  );
  assert.match(decide, /exploreBudgetExhausted\(boundExplore\)\) \{[\s\S]{0,600}requestBudgetExtension\(boundExplore\)/,
    'the spent branch must raise the card before returning null, not return null alone');
  const answer = chatHandler.slice(chatHandler.indexOf('const pending = pendingBudgetExtension.get(sessionId);'));
  assert.match(answer.slice(0, 2500), /memory\.reasoning\.grantBudget\(current\.id, EXPLORE_BUDGET_GRANT_TOKENS\)/,
    'a grant must write budget_granted — the only thing that can reopen the session');
  assert.match(answer.slice(0, 2500), /deepExploreAutoAdvance\.rearm\(current\.id\)/,
    'a grant must re-arm the driver that was waiting on it');
  const deps = chatHandler.slice(chatHandler.indexOf('export const deepExploreAutoAdvance = createAutoAdvanceLoop({'));
  assert.match(deps.slice(0, 1200), /requestBudgetExtension: \(s\) => requestBudgetExtension\(s\)/,
    'the driver must be handed the card, or it falls back to the fire-once notice');
});

/**
 * Replies sent to the owner BEFORE the model (card answers, spent-budget notices) must carry the same
 * channel envelope the model's replies carry. Prod 2026-09-03 11:17:21: the admission-grant reply had
 * none and WeChat logged an output_filter fallback. Every direct reply in the two card blocks and the
 * explore-control branch now goes through forUser(); this pins that.
 */
test('every pre-model owner reply carries the channel envelope', () => {
  const from = chatHandler.indexOf('const pending = pendingBudgetExtension.get(sessionId);');
  const to = chatHandler.indexOf("// '/autonomy' status command");
  assert.ok(from > 0 && to > from, 'the pre-model reply region still exists');
  const region = chatHandler.slice(from, to);
  const bare = [...region.matchAll(/onDelta\((?!forUser\(|reply\))/g)].map((m) => region.slice(m.index!, m.index! + 60));
  assert.deepEqual(bare, [], 'a direct onDelta without the envelope reaches WeChat only via the fallback path');
  assert.doesNotMatch(region, /reply = exploreBudgetNotice\(/, 'the budget notice must be enveloped too');
  const helper = chatHandler.slice(chatHandler.indexOf('function forUser('), chatHandler.indexOf('function forUser(') + 200);
  assert.match(helper, /## For User/); assert.match(helper, /## 给用户/);
});

/**
 * A card is answerable only in a conversation it reached. Prod 2026-09-10 23:14:12: an admission card
 * the dispatcher had skipped on WeChat stayed registered under the WeChat conversation (a web-ui client
 * was connected), and the owner's "OK" — meant for the tool-auth prompt they could see — was consumed
 * by it. Both card raisers must hand the dispatcher's skips to retireUndeliveredCard.
 */
test('both cards un-register themselves where the dispatcher skipped them', () => {
  for (const fn of ['requestBudgetExtension', 'requestFormalAutoAdmission']) {
    const body = chatHandler.slice(chatHandler.indexOf(`function ${fn}(`), chatHandler.indexOf(`function ${fn}(`) + 4000);
    assert.match(body, /retireUndeliveredCard\(pending(?:BudgetExtension|FormalAutoAdmission), s\.id, entry\.ts, result\.skipped\)/,
      `${fn} must un-register the card for every (channel, peer) the dispatcher skipped`);
  }
  const helper = chatHandler.slice(chatHandler.indexOf('function retireUndeliveredCard('), chatHandler.indexOf('function retireUndeliveredCard(') + 900);
  assert.match(helper, /reconstructDmSessionId\(skip\.channel, skip\.peer\)/, 'the skip must be mapped to the conversation it names');
  assert.match(helper, /p\.sessionId === sessionId && p\.ts === ts/, 'only THIS card is retired, never a newer one');
});

/**
 * The background mini-loop's LLM call must carry the same per-call clock the foreground has. Prod
 * 2026-09-12 11:12:50 → 11:25:52: one `fetch failed` attempt took thirteen minutes to fail — the whole
 * round budget — because this path forwarded only the round's abort signal and no timeout of its own.
 */
test('the background mini-loop LLM call is bounded by the per-call clock', () => {
  const site = chatHandler.slice(chatHandler.indexOf('const miniLoopLLM: MiniLoopLLMClient = {'), chatHandler.indexOf('const miniLoopLLM: MiniLoopLLMClient = {') + 3000);
  assert.match(site, /llmCallBudgetMs\(Number\.POSITIVE_INFINITY\)/, 'the adaptive per-call budget, not an ad-hoc constant');
  // And the clock does not merely stop the wait: it aborts the call. Prod 2026-09-13: the round was
  // declared not-run at 7.3min while the adapter's retry loop kept the orphaned request alive underneath
  // for another twenty minutes, overlapping the next round. Only an abort reaches the fetch AND the loop.
  assert.match(site, /setTimeout\(\(\) => \{ timedOut = true; ctrl\.abort\(\); \}, ms\)/, 'the timer must abort, not just reject');
  assert.match(site, /signal: ctrl\.signal/, 'the adapter must receive the abortable signal, not the raw caller signal');
  assert.match(site, /addEventListener\('abort', forward/, "the caller's own abort still has to propagate");
});

/**
 * Two heartbeat facts the owner read on 2026-09-13 that were false: a "current step" taken from a plan
 * auto-closed as failed four days earlier, and "121 个开放节点" where deep_explore(status) said 68 for
 * the same tree — two definitions of "open" behind one word.
 */
test('heartbeats read a live plan and one meaning of open', () => {
  const turnHb = chatHandler.slice(chatHandler.indexOf('const stopProgress = startProgressTicker(() => {'), chatHandler.indexOf('const stopProgress = startProgressTicker(() => {') + 900);
  assert.match(turnHb, /\.find\(\(p\) => p\.status === 'draft' \|\| p\.status === 'executing'\)/, 'only a live plan has a current step');
  const aa = readFileSync(new URL('../src/deep_explore_autoadvance.ts', import.meta.url), 'utf8');
  assert.match(aa, /const frontier = computeFrontier\(nodes\);\s*const open = frontier\.length;/, 'the milestone must count open the way status does');
  assert.match(aa, /const retryingAfterOutage = \(endpointStrikes\.get\(s\.id\) \?\? 0\) > 0;/, 'a retry after an outage must not arm the heartbeat ticker');
});

/**
 * The iLink allowance is a ledger of messages per inbound, kept by the WeChat channel and read by the
 * dispatcher. Three call sites make it true; any one missing makes the ledger silently wrong.
 */
test('the WeChat send ledger is fed on send, refusal and inbound, and read by the dispatcher', () => {
  const wechat = readFileSync(new URL('../src/channels/wechat/index.ts', import.meta.url), 'utf8');
  assert.match(wechat, /if \(r\.ret === 0\) \{\s*allowance\.onSent\(to\);/, 'an accepted message spends one');
  assert.match(wechat, /if \(r\.ret === -2\) allowance\.onRefused\(to\);/, 'a refusal teaches the total');
  assert.match(wechat, /allowance\?\.onInbound\(event\.groupId \|\| event\.fromUserId\);\s*if \(!event\.text\)/, 'every inbound refills, before the text check');
  assert.match(wechat, /allowance: \(peer\) => allowance\.view\(peer\),/, 'the push channel exposes the ledger');
  const dispatcher = readFileSync(new URL('../src/push/dispatcher.ts', import.meta.url), 'utf8');
  assert.match(dispatcher, /if \(req\.progress === 'heartbeat'\) \{\s*const a = lookupChannel\.allowance\?\.\(peer\)/, 'the dispatcher reads it for heartbeats');
  // The purge literal must be the kind chat-handler produces for a heartbeat.
  assert.match(chatHandler, /kind: opts\.blocking \? 'deep_explore:auto_paused' : `deep_explore:auto_\$\{opts\.progress \?\? 'advance'\}`/);
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /discardKind\('deep_explore:auto_heartbeat'\)/);
});

/**
 * What the owner reads must be what the model can see, and what the channel carries must be what the
 * owner was promised. Prod 2026-09-13/14, the WeChat side of the log.
 */
test('owner-facing text is on the record, heartbeats stay off the messaging channel, one frontier rule', () => {
  // Pre-model replies and delivered proactive notices reach the timeline the next turn reads.
  assert.equal((chatHandler.match(/sayBeforeModel\(sessionId, onDelta, forUser\(en, /g) ?? []).length, 7, 'every pre-model reply is recorded');
  assert.match(chatHandler, /if \(reply\) \{\s*sayBeforeModel\(sessionId, onDelta, reply\);/, 'the explore-control reply too');
  assert.match(chatHandler, /if \(result\.delivered > 0\) remember\(\);/, 'a delivered auto-advance notice is remembered');
  assert.match(chatHandler, /if \(result\.delivered > 0\) recordOwnerFacing\(owner, `\$\{PROACTIVE_NOTICE_TAG\} \$\{text\}`\)/, 'a delivered follow-up too');
  // Heartbeats never reach the messaging channel from auto-advance; milestones and important notices do.
  assert.match(chatHandler, /if \(\(opts\?\.important \|\| opts\?\.progress === 'milestone'\) && \(!owner \|\| parseDmPeerFromSessionId\(owner\)\)\)/);
  // The turn heartbeat names the tool it is waiting on; the marker is cleared whenever the loop returns to the model.
  assert.match(chatHandler, /signalBus\.inflightTool = \{ name: call\.name, startedAt: Date\.now\(\) \};/);
  assert.ok((chatHandler.match(/signalBus\.inflightTool = null;\s*const response = await sendLlmWithRescue\(/g) ?? []).length >= 1);
  assert.match(chatHandler, /正在执行 \$\{inflight\.name\}/);
  // One frontier rule: the store owns it, deep_explore re-exports it, summarizeSession uses it.
  const reasoning = readFileSync(new URL('../../agent-memory/src/reasoning.ts', import.meta.url), 'utf8');
  assert.match(reasoning, /const openFrontierCount = computeFrontier\(nodes\)\.length;/);
  const deepExplore = readFileSync(new URL('../src/deep_explore.ts', import.meta.url), 'utf8');
  assert.match(deepExplore, /^export \{ computeFrontier \};/m);
  assert.doesNotMatch(deepExplore, /export function computeFrontier/);
});
