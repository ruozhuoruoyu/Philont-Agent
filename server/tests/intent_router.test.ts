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
  userSignaledDepth,
  planRouteWantsSlow,
  buildDeepExploreNudge,
  deepExploreForceStartEnabled,
  shouldForceDeepExploreStart,
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

test('userSignaledDepth: explicit depth/commitment words → true', () => {
  for (const t of ['深度调研哪个适合', '深入分析一下', '系统地梳理', '彻底搞清楚', 'do a thorough investigation', 'deep dive into this']) {
    assert.equal(userSignaledDepth(t), true, t);
  }
  for (const t of ['调研有没有类似方案', '今天天气如何', 'what is X']) {
    assert.equal(userSignaledDepth(t), false, t);
  }
});

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
  assert.equal(deepExploreRouteTier(dec(0.95), env), 'force');
  assert.equal(deepExploreRouteTier(dec(0.9), env), 'force');
  assert.equal(deepExploreRouteTier(dec(0.8), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.7), env), 'ask');
  assert.equal(deepExploreRouteTier(dec(0.6), env), 'direct');
  assert.equal(deepExploreRouteTier(null, env), null);
  assert.equal(
    deepExploreRouteTier({ route: 'plan', confidence: 0.99 } as never, env),
    null,
  );
  // env overrides
  const custom = { PHILONT_DEEP_EXPLORE_FORCE_CONF: '0.95', PHILONT_DEEP_EXPLORE_ASK_CONF: '0.5' } as NodeJS.ProcessEnv;
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
