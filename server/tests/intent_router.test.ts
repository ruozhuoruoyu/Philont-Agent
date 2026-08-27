/**
 * Turn-entry intent router (aux-LLM, 3-way: deep_explore / plan / direct).
 * Pure parts (pre-filter, prompt, parse) + classifyIntent with a mocked aux caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  intentRouterEnabled,
  shouldClassifyIntent,
  buildIntentPrompt,
  parseIntentDecision,
  classifyIntent,
  planRouteWantsSlow,
  buildDeepExploreNudge,
  deepExploreForceStartEnabled,
  shouldForceDeepExploreStart,
  shouldForceRoutedDeepExploreContinue,
  shouldForceDeepExploreAutoOn,
  buildForceStartInput,
  messageIsSelfContainedGoal,
  type IntentDecision,
} from '../src/intent_router.js';

test('intentRouterEnabled: default ON, =0/off disables', () => {
  const prev = process.env.PHILONT_INTENT_ROUTER;
  try {
    delete process.env.PHILONT_INTENT_ROUTER;
    assert.equal(intentRouterEnabled(), true);
    process.env.PHILONT_INTENT_ROUTER = '0';
    assert.equal(intentRouterEnabled(), false);
    process.env.PHILONT_INTENT_ROUTER = 'off';
    assert.equal(intentRouterEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_INTENT_ROUTER;
    else process.env.PHILONT_INTENT_ROUTER = prev;
  }
});

test('shouldClassifyIntent: skip trivial (acks / 继续 / short), classify substantive', () => {
  // trivial → skip (no aux call wasted)
  for (const t of ['继续', '好的', 'ok', '谢谢', '停', 'yes', '嗯嗯', '收到了']) {
    assert.equal(shouldClassifyIntent(t), false, `trivial: ${t}`);
  }
  // substantive → classify (broad coverage across deep_explore + plan + direct)
  for (const t of [
    '调研有没有类似的开源方案？',
    '深度调研，看哪个适合GLM5.2的推理优化方案',
    '为什么这个服务在高并发下会崩？',
    '帮我把 TileRT 接入并在本机跑通',
    '评估一下自研推理引擎值不值得做',
    '北京今天天气怎么样还有顺便看下明天', // even a longer lookup gets classified → aux says "direct"
    '调研深度不够，重做', // dense Chinese (9 chars) — must NOT be skipped (the prod miss)
    '为什么会崩', // 5 chars, substantive diagnosis
  ]) {
    assert.equal(shouldClassifyIntent(t), true, `substantive: ${t}`);
  }
});

test('buildIntentPrompt: names all three routes + the THINK-vs-DO boundary', () => {
  const p = buildIntentPrompt('调研有没有类似方案');
  assert.match(p, /deep_explore/);
  assert.match(p, /"plan"/);
  assert.match(p, /"direct"/);
  assert.match(p, /THINK \/ DECIDE/);
  assert.match(p, /DO \/ BUILD/);
  assert.match(p, /调研有没有类似方案/, 'embeds the user message');
});

test('parseIntentDecision: valid / embedded-in-prose / enum-guard / junk', () => {
  const a = parseIntentDecision('{"route":"deep_explore","domain":"deliberate","confidence":0.9,"reason":"survey"}');
  assert.equal(a?.route, 'deep_explore');
  assert.equal(a?.domain, 'deliberate');
  assert.equal(a?.confidence, 0.9);

  // prose around the JSON still parses
  const b = parseIntentDecision('Sure! {"route":"plan","confidence":0.8,"reason":"build"} hope this helps');
  assert.equal(b?.route, 'plan');
  assert.equal(b?.domain, undefined, 'no domain for plan');

  // deep_explore with a bad/missing domain → defaults to deliberate (never undefined for explore)
  const c = parseIntentDecision('{"route":"deep_explore","domain":"nonsense","confidence":2,"reason":"x"}');
  assert.equal(c?.domain, 'deliberate');
  assert.equal(c?.confidence, 1, 'confidence clamped to [0,1]');

  // bad route enum → null
  assert.equal(parseIntentDecision('{"route":"banana"}'), null);
  // not JSON → null
  assert.equal(parseIntentDecision('I think this is a plan task'), null);
  assert.equal(parseIntentDecision(''), null);
});

test('parseIntentDecision preserves the router self-contained judgment', () => {
  const r = parseIntentDecision('{"route":"deep_explore","domain":"formal","confidence":0.9,"reason":"continues prior proof","selfContained":false,"continuous":true}');
  assert.equal(r?.selfContained, false);
  assert.equal(r?.continuous, true);
  assert.match(buildIntentPrompt('你说的这个新视角值得推吗？'), /selfContained/);
  assert.match(buildIntentPrompt('继续推'), /continuous/);
});

test('contextual deep-explore route forces a live session to continue, but status/new goals do not', () => {
  const base = {
    decision: { route: 'deep_explore', domain: 'discover', confidence: 0.8, reason: 'continue', selfContained: false } as IntentDecision,
    hasActiveSession: true,
    advanceRanThisTurn: false,
    alreadyForced: false,
    selfReferentialMeta: false,
    userAsksStatus: false,
  };
  assert.equal(shouldForceRoutedDeepExploreContinue(base), true);
  assert.equal(shouldForceRoutedDeepExploreContinue({ ...base, userAsksStatus: true }), false);
  assert.equal(shouldForceRoutedDeepExploreContinue({ ...base, advanceRanThisTurn: true }), false);
  assert.equal(shouldForceRoutedDeepExploreContinue({
    ...base,
    decision: { ...base.decision, selfContained: true },
  }), false, 'a standalone new goal must not be attached to the old tree');
});

test('continuous route arms auto advance only after a real round on a live session', () => {
  const base = {
    decision: { route: 'deep_explore', confidence: 0.8, reason: 'keep pushing', continuous: true } as IntentDecision,
    advanceRanThisTurn: true,
    hasActiveSession: true,
    autoOnRanThisTurn: false,
    selfReferentialMeta: false,
    userAsksStatus: false,
  };
  assert.equal(shouldForceDeepExploreAutoOn(base), true);
  assert.equal(shouldForceDeepExploreAutoOn({ ...base, advanceRanThisTurn: false }), false);
  assert.equal(shouldForceDeepExploreAutoOn({ ...base, autoOnRanThisTurn: true }), false);
  assert.equal(shouldForceDeepExploreAutoOn({
    ...base,
    decision: { ...base.decision, continuous: false },
  }), false);
});

test('classifyIntent: uses injected caller; routes a research turn to deep_explore', async () => {
  const dec = await classifyIntent('深度调研，看哪个适合GLM5.2的推理优化方案', {
    call: async () => '{"route":"deep_explore","domain":"deliberate","confidence":0.92,"reason":"compare inference stacks"}',
  });
  assert.equal(dec?.route, 'deep_explore');
  assert.equal(dec?.domain, 'deliberate');
});

test('classifyIntent: a build task routes to plan (not deep_explore)', async () => {
  const dec = await classifyIntent('帮我把 TileRT 接入并在本机部署跑通', {
    call: async () => '{"route":"plan","confidence":0.85,"reason":"multi-step build with side effects"}',
  });
  assert.equal(dec?.route, 'plan');
});

test('classifyIntent: trivial turn → null (pre-filter, no aux call)', async () => {
  let called = false;
  const dec = await classifyIntent('继续', { call: async () => { called = true; return '{}'; } });
  assert.equal(dec, null);
  assert.equal(called, false, 'pre-filter must short-circuit before the aux call');
});

test('classifyIntent: disabled flag → null', async () => {
  const prev = process.env.PHILONT_INTENT_ROUTER;
  process.env.PHILONT_INTENT_ROUTER = '0';
  try {
    const dec = await classifyIntent('调研有没有类似方案', { call: async () => '{"route":"deep_explore","confidence":1,"reason":"x"}' });
    assert.equal(dec, null);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_INTENT_ROUTER;
    else process.env.PHILONT_INTENT_ROUTER = prev;
  }
});

test('classifyIntent: aux call throws → null (degrade to today behavior, never throws)', async () => {
  const dec = await classifyIntent('调研有没有类似方案', {
    call: async () => { throw new Error('aux down'); },
  });
  assert.equal(dec, null);
});

const dExplore = (over: Partial<IntentDecision> = {}): IntentDecision => ({ route: 'deep_explore', domain: 'deliberate', confidence: 0.6, reason: 'r', ...over });


test('planRouteWantsSlow: plan route ≥0.6 → reuse slow protocol; below / other routes → no', () => {
  assert.equal(planRouteWantsSlow({ route: 'plan', confidence: 0.7, reason: 'r' }), true);
  assert.equal(planRouteWantsSlow({ route: 'plan', confidence: 0.4, reason: 'r' }), false);
  assert.equal(planRouteWantsSlow(dExplore({ confidence: 0.99 })), false, 'deep_explore is not plan');
  assert.equal(planRouteWantsSlow(null), false);
});

test('buildDeepExploreNudge: SUGGEST when ambiguous, START when explicit-depth or high-confidence', () => {
  // ambiguous (no depth word, mid confidence) → offer
  const offer = buildDeepExploreNudge(dExplore({ confidence: 0.6 }), false);
  assert.match(offer, /OFFER the user ONE sentence/i);
  assert.doesNotMatch(offer, /START a deep_explore session/);

  // explicit depth → start directly
  const startByDepth = buildDeepExploreNudge(dExplore({ confidence: 0.6 }), true);
  assert.match(startByDepth, /START a deep_explore session/);

  // high confidence but NO explicit depth → still only OFFER (conf measures route, not desired depth)
  const highConfNoDepth = buildDeepExploreNudge(dExplore({ confidence: 0.95 }), false);
  assert.match(highConfNoDepth, /OFFER the user ONE sentence/i);
  assert.doesNotMatch(highConfNoDepth, /START a deep_explore session/);

  // carries the domain through to mode=
  assert.match(buildDeepExploreNudge(dExplore({ domain: 'formal', confidence: 0.9 }), true), /mode=formal/);

  // non-deep_explore → empty (caller skips)
  assert.equal(buildDeepExploreNudge({ route: 'plan', confidence: 0.9, reason: 'r' }, true), '');
  assert.equal(buildDeepExploreNudge(null, true), '');
});

test('deepExploreForceStartEnabled: default ON, =0 disables', () => {
  const prev = process.env.PHILONT_DEEP_EXPLORE_FORCE_START;
  try {
    delete process.env.PHILONT_DEEP_EXPLORE_FORCE_START;
    assert.equal(deepExploreForceStartEnabled(), true);
    process.env.PHILONT_DEEP_EXPLORE_FORCE_START = '0';
    assert.equal(deepExploreForceStartEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PHILONT_DEEP_EXPLORE_FORCE_START;
    else process.env.PHILONT_DEEP_EXPLORE_FORCE_START = prev;
  }
});

test('shouldForceDeepExploreStart: fires only on deep_explore + explicit depth + no session + model skipped it', () => {
  const base = {
    decision: dExplore({ confidence: 0.9 }),
    explicitDepth: true,
    goalSubstantial: true,
    alreadyForcedStart: false,
    alreadyForcedContinue: false,
    deepExploreRanThisTurn: false,
    hasActiveSession: false,
  };
  assert.equal(shouldForceDeepExploreStart(base), true, 'the canonical case');
  assert.equal(shouldForceDeepExploreStart({ ...base, explicitDepth: false }), false, 'no explicit depth → only soft OFFER, never force');
  assert.equal(shouldForceDeepExploreStart({ ...base, goalSubstantial: false }), false, 'short context-dependent msg (重做) → no goal to start from');
  assert.equal(shouldForceDeepExploreStart({ ...base, deepExploreRanThisTurn: true }), false, 'model already used the engine');
  assert.equal(shouldForceDeepExploreStart({ ...base, hasActiveSession: true }), false, 'a session exists → continue path handles it');
  assert.equal(shouldForceDeepExploreStart({ ...base, alreadyForcedStart: true }), false, 'anti-reentry');
  assert.equal(shouldForceDeepExploreStart({ ...base, alreadyForcedContinue: true }), false, 'do not double-force in one turn');
  assert.equal(shouldForceDeepExploreStart({ ...base, decision: { route: 'plan', confidence: 0.9, reason: 'r' } }), false, 'plan route → never force a deep_explore start');
  assert.equal(shouldForceDeepExploreStart({ ...base, decision: null }), false);
});

test('buildForceStartInput: goal from message; mode only for formal/deliberate (discover omitted)', () => {
  const a = buildForceStartInput(dExplore({ domain: 'deliberate' }), '深度调研 GLM5.2 在 910C 上的推理栈');
  assert.deepEqual(a, { action: 'start', goal: '深度调研 GLM5.2 在 910C 上的推理栈', mode: 'deliberate' });

  const f = buildForceStartInput(dExplore({ domain: 'formal' }), '证明 X');
  assert.equal(f.mode, 'formal');

  // discover is an ACTION not a mode → omit mode (engine auto-detects from goal)
  const d = buildForceStartInput(dExplore({ domain: 'discover' }), '探索新角度');
  assert.equal(d.mode, undefined);
  assert.equal(d.action, 'start');

  // goal is trimmed
  assert.equal(buildForceStartInput(dExplore(), '  hi there  ').goal, 'hi there');
});

test('messageIsSelfContainedGoal: long enough to stand alone vs short context-dependent', () => {
  assert.equal(messageIsSelfContainedGoal('深度探索基于昇腾910C集群的GLM5.2推理方案'), true);
  assert.equal(messageIsSelfContainedGoal('调研深度不够，重做'), false, 'references prior topic, not a goal');
  assert.equal(messageIsSelfContainedGoal('深入点'), false);
});

// ── Cleanup/cancel deterministic override (prod: "清除mycox记忆定时技能" mis-routed to plan/deep_explore) ──
import {
  looksLikeCleanupIntent,
  directRouteWantsFast,
  classifyIntent as _classifyIntent,
} from '../src/intent_router.js';

test('looksLikeCleanupIntent: pure delete/cancel commands → true', () => {
  assert.equal(looksLikeCleanupIntent('清除mycox记忆、定时和技能'), true);
  assert.equal(looksLikeCleanupIntent('清除mycox相关的记忆和技能'), true);
  assert.equal(looksLikeCleanupIntent('清除所有定时'), true);
  assert.equal(looksLikeCleanupIntent('取消 mycox 的定时任务'), true);
  assert.equal(looksLikeCleanupIntent('delete all mycox skills and schedules'), true);
});

test('looksLikeCleanupIntent: real tasks that mention cleanup → false', () => {
  assert.equal(looksLikeCleanupIntent('清除旧配置然后重新部署服务'), false); // has 部署/deploy
  assert.equal(looksLikeCleanupIntent('注册 mycox 并设置定时心跳'), false); // 注册/register
  assert.equal(looksLikeCleanupIntent('研究一下哥德巴赫猜想'), false); // no cleanup verb/target
  assert.equal(looksLikeCleanupIntent(''), false);
});

test('cleanup override routes direct with confidence 1 (no aux call)', async () => {
  let auxCalled = false;
  const dec = await _classifyIntent('清除mycox记忆、定时和技能', {
    call: async () => { auxCalled = true; return '{"route":"plan","confidence":0.9}'; },
  });
  assert.equal(dec?.route, 'direct');
  assert.equal(dec?.confidence, 1);
  assert.equal(auxCalled, false, 'aux must be skipped for a cleanup command');
});

test('directRouteWantsFast: confident direct only', () => {
  assert.equal(directRouteWantsFast({ route: 'direct', confidence: 1 } as never), true);
  assert.equal(directRouteWantsFast({ route: 'direct', confidence: 0.5 } as never), false);
  assert.equal(directRouteWantsFast({ route: 'plan', confidence: 1 } as never), false);
  assert.equal(directRouteWantsFast(null), false);
});

// ── Three-tier deep_explore routing (2026-07-09) ─────────────────────────────

test('deepExploreRouteTier: force/ask/direct by confidence; env-tunable; non-explore route → null', async () => {
  const { deepExploreRouteTier } = await import('../src/intent_router.js');
  const dec = (conf: number) => ({ route: 'deep_explore' as const, confidence: conf, domain: 'deliberate' as const });
  const env = {} as NodeJS.ProcessEnv;
  // 2026-07-12: FORCE defaults to 1.01 (unreachable) — router CONFIDENCE ALONE never force-starts.
  // Even a 0.99 research route only ASKS the owner; an explicit depth keyword is the way in.
  assert.equal(deepExploreRouteTier(dec(0.99), env), 'ask', 'confidence alone must never force');
  assert.equal(deepExploreRouteTier(dec(0.95), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.9), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.8), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.7), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.6), env), 'direct');
  assert.equal(deepExploreRouteTier(null, env), null);
  assert.equal(
    deepExploreRouteTier({ route: 'plan', confidence: 0.99 } as never, env),
    null,
  );
  // env overrides — the old confidence-force behavior is restorable.
  const custom = { PHILONT_DEEP_EXPLORE_FORCE_CONF: '0.95', PHILONT_DEEP_EXPLORE_ASK_CONF: '0.5' } as NodeJS.ProcessEnv;
  assert.equal(deepExploreRouteTier(dec(0.96), custom), 'force');
  assert.equal(deepExploreRouteTier(dec(0.9), custom), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.4), custom), 'direct');
});

test('shouldForceDeepExploreStart: force tier or ask approval works WITHOUT explicit depth keywords', async () => {
  const { shouldForceDeepExploreStart } = await import('../src/intent_router.js');
  const base = {
    decision: { route: 'deep_explore' as const, confidence: 0.95, domain: 'deliberate' as const },
    explicitDepth: false,
    goalSubstantial: true,
    alreadyForcedStart: false,
    alreadyForcedContinue: false,
    deepExploreRanThisTurn: false,
    hasActiveSession: false,
  };
  // prod 2026-07-09: conf 0.9-0.95 research tasks flattened because explicitDepth was mandatory
  assert.equal(shouldForceDeepExploreStart({ ...base, tier: 'force' }), true);
  assert.equal(shouldForceDeepExploreStart({ ...base, approvedViaAsk: true }), true);
  // ask/direct tier without approval and without depth keywords → no force
  assert.equal(shouldForceDeepExploreStart({ ...base, tier: 'ask' }), false);
  assert.equal(shouldForceDeepExploreStart({ ...base, tier: 'direct' }), false);
  // legacy path unchanged: explicit depth still forces regardless of tier
  assert.equal(shouldForceDeepExploreStart({ ...base, explicitDepth: true, tier: 'direct' }), true);
  // guards still hold under force tier
  assert.equal(shouldForceDeepExploreStart({ ...base, tier: 'force', hasActiveSession: true }), false);
  assert.equal(shouldForceDeepExploreStart({ ...base, tier: 'force', deepExploreRanThisTurn: true }), false);
});

// ── Self-referential meta-question guard (2026-07-09 KV-cache log) ───────────

test('isSelfReferentialMetaQuestion: catches questions about the agent itself', async () => {
  const { isSelfReferentialMetaQuestion } = await import('../src/intent_router.js');
  // prod: this exact message got conf=1 from the keyword "deepexplore" and force-started a
  // 558s session (web-searched 平铺 in a dictionary) to answer a 2-second question
  assert.equal(isSelfReferentialMetaQuestion('你这个分析是平铺的还是使用deepexplore做的？'), true);
  assert.equal(isSelfReferentialMetaQuestion('你刚才用了什么工具？'), true);
  assert.equal(isSelfReferentialMetaQuestion('你之前的报告里 deep_explore 跑了几轮?'), true);
  // machinery mention alone is NOT meta — a genuine research request must stay routable
  assert.equal(isSelfReferentialMetaQuestion('用deep_explore研究一下KV-cache的最新进展'), false);
  assert.equal(isSelfReferentialMetaQuestion('调研KV-cache压缩方向'), false);
  // prior-turn reference alone is fine too (follow-up on content, not on mechanism)
  assert.equal(isSelfReferentialMetaQuestion('研究一下量子计算对密码学的影响'), false);
  assert.equal(isSelfReferentialMetaQuestion(''), false);
});

test('shouldForceDeepExploreStart: selfReferentialMeta blocks force even at force tier', async () => {
  const { shouldForceDeepExploreStart } = await import('../src/intent_router.js');
  const base = {
    decision: { route: 'deep_explore' as const, confidence: 1, domain: 'deliberate' as const },
    explicitDepth: true,
    goalSubstantial: true,
    alreadyForcedStart: false,
    alreadyForcedContinue: false,
    deepExploreRanThisTurn: false,
    hasActiveSession: false,
    tier: 'force' as const,
  };
  assert.equal(shouldForceDeepExploreStart(base), true);
  assert.equal(shouldForceDeepExploreStart({ ...base, selfReferentialMeta: true }), false);
});

test('classifyExploreAskReply: the words the ask itself offered are matched, not inferred (prod 2026-07-13)', async () => {
  const { classifyExploreAskReply } = await import('../src/intent_router.js');
  // 直接 is OUR deny word (回复"直接"就快速平铺作答) — the generic auth classifier read it as
  // "just go ahead" and logged ask-tier APPROVED on an explicit refusal.
  assert.equal(classifyExploreAskReply('直接'), 'deny');
  assert.equal(classifyExploreAskReply('直接。'), 'deny');
  assert.equal(classifyExploreAskReply('平铺'), 'deny');
  assert.equal(classifyExploreAskReply('进'), 'grant');
  assert.equal(classifyExploreAskReply('深度推理'), 'grant');
  // Anything outside the offered vocabulary defers to the generic classifier.
  assert.equal(classifyExploreAskReply('帮我看看这个文件'), null);
  assert.equal(classifyExploreAskReply(''), null);
});

test('the ask is one line and its digits are matched — the owner should not retype the subject line', async () => {
  const { buildDeepExploreAskText, classifyExploreAskReply } = await import('../src/intent_router.js');
  // Production 2026-07-24 16:33 and 17:34: the question offered 进 / 直接 and the owner typed 深度推理
  // both times — four characters, on a phone, for a prompt that fires on every borderline task.
  const ask = buildDeepExploreAskText({ route: 'deep_explore', confidence: 0.9, domain: 'deliberate' } as never);
  assert.ok(ask.split('\n').length <= 2, 'two lines at most');
  assert.ok(ask.length <= 90, `the ask must stay short, got ${ask.length}`);
  assert.match(ask, /1/, 'the grant answer must appear in the question that offers it');
  assert.match(ask, /2/, 'and the deny answer too');

  // Every answer the question hands out is matched deterministically — the 2026-07-13 lesson.
  assert.equal(classifyExploreAskReply('1'), 'grant');
  assert.equal(classifyExploreAskReply('2'), 'deny', 'the meaning of an offered digit may be extended, never moved');
  assert.equal(classifyExploreAskReply('3'), 'auto', 'the third option is additive');
  assert.equal(classifyExploreAskReply('１'), 'grant', 'full-width digits come from Chinese IMEs');
  assert.equal(classifyExploreAskReply('2.'), 'deny', 'trailing punctuation is stripped');
  assert.equal(classifyExploreAskReply('３'), 'auto', 'full-width digits reach the new option too');
  // The older vocabulary keeps working: a habit we taught must not become an error.
  assert.equal(classifyExploreAskReply('进'), 'grant');
  assert.equal(classifyExploreAskReply('直接'), 'deny');
  assert.equal(classifyExploreAskReply('自动'), 'auto');
  assert.equal(classifyExploreAskReply('开始深度推理'), 'grant', 'what the owner actually typed');
  // A digit that is not one of the offered answers is NOT an answer.
  assert.equal(classifyExploreAskReply('4'), null);
});

test('buildIntentPrompt: carries the "debugging our own artifact is NOT deep_explore" boundary', () => {
  const p = buildIntentPrompt('问题1就是定位不到检索的节点');
  assert.match(p, /debugging OUR OWN artifact is NOT deep_explore/i);
  assert.match(p, /READING THE FILE/i);
  // The prod misroutes it must now steer: a bug report on a file we wrote is a work item.
  assert.match(p, /work item, not an investigation/i);
});


test('the ask tier has NO keyword bypass: a depth-ish NOUN cannot skip the owner\'s choice', async () => {
  const { shouldForceDeepExploreStart } = await import('../src/intent_router.js');
  const base = {
    decision: { route: 'deep_explore' as const, domain: 'deliberate' as const, confidence: 0.95, reason: 'r' },
    goalSubstantial: true,
    alreadyForcedStart: false,
    alreadyForcedContinue: false,
    deepExploreRanThisTurn: false,
    hasActiveSession: false,
    tier: 'ask' as const,
  };
  // Depth is ESTABLISHED, never inferred. Without the owner's yes, no force — no matter what the
  // message says. (Prod 2026-07-13: "完整多智能体编排系统" was read as a depth request and force-started.)
  assert.equal(
    shouldForceDeepExploreStart({ ...base, explicitDepth: false, approvedViaAsk: false }),
    false,
    'no approval → never force, whatever nouns the message contains',
  );
  // The owner said yes → in we go.
  assert.equal(
    shouldForceDeepExploreStart({ ...base, explicitDepth: true, approvedViaAsk: true }),
    true,
  );
});

test('the ask-tier auto choice arms exactly one session, and only within the card lifetime', async () => {
  const { takeArmedAutoAdvance } = await import('../src/chat-handler.js');
  const now = 1_787_700_000_000;
  const armed = new Map<string, number>([['owner-a', now - 1_000]]);

  assert.equal(takeArmedAutoAdvance(armed, 'owner-b', now), false, 'another owner is not armed');
  assert.equal(takeArmedAutoAdvance(armed, 'owner-a', now), true);
  assert.equal(
    takeArmedAutoAdvance(armed, 'owner-a', now),
    false,
    'read-and-clear: one choice must not arm a second session',
  );

  // A choice that never produced a session must not arm an unrelated one hours later.
  const stale = new Map<string, number>([['owner-a', now - 60 * 60_000]]);
  assert.equal(takeArmedAutoAdvance(stale, 'owner-a', now), false);
  assert.equal(stale.has('owner-a'), false, 'an expired arming is cleared, not left to accumulate');
});
