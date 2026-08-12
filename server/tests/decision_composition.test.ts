/**
 * Three cards, one reply.
 *
 * Every piece of the address layer was unit-tested and every piece passed, and the composition was
 * still broken: routeReply picked A correctly, and then pendingAuth — consulted first, holding no id
 * of its own — spent the reply anyway, while the research payload map, keyed by conversation, had
 * long since overwritten A with B. Each part behaved. The turn did not.
 *
 * So this drives the parts together, against the handler's own state: the book and the payload map
 * that production writes, seeded through the function production seeds them with. The seam is
 * deliberately narrow — `handleChatSend` cannot be booted here (the LLM is module-level and not
 * injectable), so what this pins is the resolution chain, not the socket-to-socket turn. What it
 * cannot see is stated at the bottom rather than implied to be covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingDecisions,
  registerResearchDecision,
  researchPayloadFor,
  claimedByAnotherDecision,
  applyResearchDecision,
} from '../src/chat-handler.js';
import { routeReply } from '../src/pending_decisions.js';

const SID = 'wechat:acct1:userA';

/** What the entry router does to an incoming message, in the order the handler does it. */
function deliver(message: string, opts: { quoted?: string } = {}) {
  const outstanding = pendingDecisions.list(SID);
  const routed = routeReply(message, outstanding, {
    now: Date.now(),
    quotedText: opts.quoted,
    snapshot: pendingDecisions.lastSnapshot(SID),
  });
  // The bus the modules downstream read.
  const signalBus = {
    resolvedDecisionId: routed.kind === 'addressed' ? routed.id : undefined,
    resolvedVerdictText: routed.kind === 'addressed' ? routed.verdictText : undefined,
  } as never as Parameters<typeof claimedByAnotherDecision>[0];
  return { routed, signalBus };
}

/** The applier over a fixed payload, so each test names only the effect it is about. */
function applyResearchDecisionSync(
  verdict: 'grant' | 'deny',
  effects: Parameters<typeof applyResearchDecision>[0]['effects'],
) {
  return applyResearchDecision({
    payload: {
      pursuitId: 'p-jacobian', questionId: 'q1', tool: 'webFetch',
      why: 'read the paper', ts: Date.now(), decisionId: 'r001', sessionId: SID,
    },
    verdict,
    effects,
  });
}

function seedTwoResearchCards() {
  for (const d of pendingDecisions.list(SID)) pendingDecisions.resolve(SID, d.id);
  const a = registerResearchDecision(SID, {
    pursuitId: 'p-jacobian',
    questionId: 'q1',
    tool: 'webFetch',
    why: 'read the 1998 counterexample paper',
    title: '雅可比猜想',
  });
  const b = registerResearchDecision(SID, {
    pursuitId: 'p-kv-cache',
    questionId: 'q2',
    tool: 'webSearch',
    why: 'survey recent KV-cache eviction work',
    title: 'KV-cache',
  });
  return { a, b };
}

test('the approval quoted at A moves A, and leaves B exactly where it was', () => {
  const { a, b } = seedTwoResearchCards();
  const { routed, signalBus } = deliver('同意', { quoted: '后台研究「雅可比猜想」请求使用 webFetch' });

  assert.equal(routed.kind, 'addressed');
  assert.equal(routed.kind === 'addressed' && routed.id, a);

  // The payload the research branch will act on is A's — this is the lookup that used to return B.
  const payload = researchPayloadFor(signalBus);
  assert.equal(payload?.decisionId, a);
  assert.equal(payload?.tool, 'webFetch');
  assert.equal(payload?.pursuitId, 'p-jacobian');

  // B is untouched: still outstanding, still with its own payload behind it.
  const stillOpen = pendingDecisions.list(SID).map((d) => d.id);
  assert.ok(stillOpen.includes(b), 'B must still be waiting for its own answer');
  assert.equal(
    researchPayloadFor({ resolvedDecisionId: b } as never as Parameters<typeof researchPayloadFor>[0])?.tool,
    'webSearch',
  );
});

test('the tool authorization does not spend a reply aimed at a research card', () => {
  // The live shape this came from: a git push waiting on approval while background research also
  // asked. pendingAuth is consulted first and holds no decision id, so before the gate it took
  // every "同意" that came past, whoever it was for.
  const { a } = seedTwoResearchCards();
  const { signalBus } = deliver('同意', { quoted: '后台研究「雅可比猜想」请求使用 webFetch' });

  // pendingAuth and askUserQuestion both stand down: they carry no id, and the message named one.
  assert.equal(claimedByAnotherDecision(signalBus), true, 'pendingAuth must not consume this');
  assert.equal(claimedByAnotherDecision(signalBus, undefined), true, 'nor askUserQuestion');
  // The research branch is the only one that recognises the address.
  assert.equal(researchPayloadFor(signalBus)?.decisionId, a);
});

test('with nothing addressed, the ordinary path is unchanged', () => {
  for (const d of pendingDecisions.list(SID)) pendingDecisions.resolve(SID, d.id);
  const { routed, signalBus } = deliver('帮我看下昨天的日志');
  assert.equal(routed.kind, 'unaddressed');
  // No id resolved → no module is locked out. The gate must not turn every message into a claim.
  assert.equal(claimedByAnotherDecision(signalBus), false);
  assert.equal(researchPayloadFor(signalBus), undefined);
});

test('two cards and a bare "同意" resolves nothing rather than guessing', () => {
  seedTwoResearchCards();
  const { routed, signalBus } = deliver('同意');
  assert.equal(routed.kind, 'ambiguous', 'with two open cards a bare yes has no address');
  assert.equal(researchPayloadFor(signalBus), undefined, 'and therefore no payload is acted on');
  assert.equal(pendingDecisions.list(SID).length, 2, 'both remain outstanding');
});

test('a number is an address only against a list the owner was actually shown', () => {
  const { a } = seedTwoResearchCards();
  // No snapshot yet: "1" is just a character, and not even an ambiguous one — it flows to the
  // ordinary turn rather than becoming a guess between two cards.
  assert.equal(deliver('1').routed.kind, 'unaddressed');

  // After the owner is shown the list, position 1 is A.
  pendingDecisions.snapshot(SID, pendingDecisions.list(SID));
  const { routed, signalBus } = deliver('1 同意');
  assert.equal(routed.kind === 'addressed' && routed.id, a);
  assert.equal(researchPayloadFor(signalBus)?.pursuitId, 'p-jacobian');
});

// ── applying, not just addressing ───────────────────────────────────────────────────────────────
// The seam above stops at "which card, and whose payload". These run the state change itself —
// real GrantStore, real audience, real failure — without an LLM turn, because the applier takes its
// effects as an argument.

test('a granted research request writes a grant nobody else can spend', async () => {
  const { applyResearchDecision } = await import('../src/chat-handler.js');
  const { GrantStore } = await import('@agent/policy');
  const grants = new GrantStore();
  const written: unknown[] = [];

  const outcome = applyResearchDecision({
    payload: {
      pursuitId: 'p-jacobian', questionId: 'q1', tool: 'webFetch',
      why: 'read the paper', ts: Date.now(), decisionId: 'r001', sessionId: SID,
    },
    verdict: 'grant',
    effects: {
      grant: (g) => { written.push(g); grants.grant(g); },
      withdrawRequest: () => assert.fail('a grant must not withdraw the request'),
    },
  });

  assert.equal(outcome.applied, true);
  assert.equal(written.length, 1);
  // The audience is the whole point: approving background research is not approving this
  // conversation's next webFetch.
  assert.match(JSON.stringify(written[0]), /"audience":"research:p-jacobian"/);
  assert.equal(grants.isGranted('webFetch', undefined, undefined, 'research:p-jacobian'), true);
  assert.equal(grants.isGranted('webFetch'), false, 'and it does not answer for the chat turn');
});

test('a denial that cannot withdraw the request is not reported as a denial', () => {
  // It was a console warning under a ledger entry saying `denied`, while the driver kept replaying
  // the request — the owner had refused and the research went on asking.
  const outcome = applyResearchDecisionSync('deny', {
    grant: () => assert.fail('a denial must not grant'),
    withdrawRequest: () => { throw new Error('db locked'); },
  });
  assert.equal(outcome.applied, false);
  assert.match(outcome.applied === false ? outcome.reason : '', /deny failed: db locked/);
});

test('a grant that cannot be written is not reported as granted', () => {
  const outcome = applyResearchDecisionSync('grant', {
    grant: () => { throw new Error('store unavailable'); },
    withdrawRequest: () => assert.fail('unreachable'),
  });
  assert.equal(outcome.applied, false);
  assert.match(outcome.applied === false ? outcome.reason : '', /grant failed: store unavailable/);
});

test('a denial withdraws exactly the request that was asked about', () => {
  const withdrawn: Array<[string, string]> = [];
  const outcome = applyResearchDecisionSync('deny', {
    grant: () => assert.fail('a denial must not grant'),
    withdrawRequest: (p, q) => { withdrawn.push([p, q]); },
  });
  assert.equal(outcome.applied, true);
  assert.deepEqual(withdrawn, [['p-jacobian', 'q1']]);
});

// ── naming a card is not answering it ───────────────────────────────────────────────────────────

test('quoting a card to ask what it means leaves it standing', () => {
  const { a, b } = seedTwoResearchCards();
  const { routed, signalBus } = deliver('这是什么意思？', {
    quoted: '后台研究「雅可比猜想」请求使用 webFetch',
  });

  // Addressed — we know which one they mean, and no other module may take the message.
  assert.equal(routed.kind === 'addressed' && routed.id, a);
  assert.equal(claimedByAnotherDecision(signalBus), true);

  // But nothing terminal was said, so both are still outstanding and both payloads survive. The
  // ask-tier version of this used to delete the offer before reading the reply at all.
  const open = pendingDecisions.list(SID).map((d) => d.id);
  assert.deepEqual(open.sort(), [a, b].sort(), 'a question is not a verdict');
  assert.equal(researchPayloadFor(signalBus)?.decisionId, a, 'and the payload is still there to act on');
});

test('an expiring card takes its payload with it, and leaves the request standing', async () => {
  const { pendingDecisions: book } = await import('../src/chat-handler.js');
  for (const d of book.list(SID)) book.resolve(SID, d.id);
  const id = registerResearchDecision(SID, {
    pursuitId: 'p-old', questionId: 'q9', tool: 'webFetch', why: 'stale', title: '旧研究',
  });
  assert.ok(researchPayloadFor({ resolvedDecisionId: id } as never as Parameters<typeof researchPayloadFor>[0]));

  // Read the book past the card's expiry — the same read the router does on the next message.
  const live = book.list(SID, Date.now() + 9 * 60 * 60_000);
  assert.equal(live.length, 0, 'the address is gone');
  assert.equal(
    researchPayloadFor({ resolvedDecisionId: id } as never as Parameters<typeof researchPayloadFor>[0]),
    undefined,
    'and so is the payload it could no longer be reached by',
  );
});

/**
 * Not covered here, and not claimed elsewhere.
 *
 * The grant write and the withdrawal ARE executed above, through the same applier production calls
 * with production's effects object. What is not executed is the handler branch around it: the audit
 * records, the reply text, and the order the two are written in. Those are held by source-shape
 * guards in policy_reachability.test.ts, which is weaker — a guard can only see that the call is
 * there, not that it ran.
 *
 * Also outside: pendingAuth's continuation resume (which is why it is not in the book yet), the
 * driver's next-tick replay of a granted request, and anything needing a real LLM turn.
 */
