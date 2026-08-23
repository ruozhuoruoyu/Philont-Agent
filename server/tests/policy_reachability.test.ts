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
  {
    contains: 'run: (input) => tools.execute(call.name, input),',
    why:
      'mechanism-initiated repair — a rewrite is a different call than the one that was approved, so ' +
      'attemptMechanicalRepair puts the REWRITTEN arguments back through checker() (isSafeToRerun) and ' +
      'runs this only when that returns allowed',
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
  // and the resolve must live inside grant, deny and expiry, and nowhere else.
  const start = chatHandler.indexOf('if (exploreAsk && addressedToAsk) {');
  const branch = chatHandler.slice(start, chatHandler.indexOf('// Interrupt teeth:', start));
  assert.ok(branch.length > 200, 'ask-tier branch not found');
  const deletes = branch.split('pendingExploreAsk.delete(sessionId);').length - 1;
  assert.equal(deletes, 3, `grant, deny and expiry only — found ${deletes}`);
  for (const terminal of ["if (askIntent === 'grant') {", "} else if (askIntent === 'deny') {"]) {
    const body = branch.slice(branch.indexOf(terminal), branch.indexOf(terminal) + 400);
    assert.match(body, /pendingExploreAsk\.delete\(sessionId\);/, `${terminal} must consume`);
    assert.match(body, /pendingDecisions\.resolve\(sessionId, exploreAsk\.decisionId!\);/, `${terminal} must clear`);
  }
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
