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

  // high confidence → start directly even without an explicit depth word
  const startByConf = buildDeepExploreNudge(dExplore({ confidence: 0.85 }), false);
  assert.match(startByConf, /START a deep_explore session/);

  // carries the domain through to mode=
  assert.match(buildDeepExploreNudge(dExplore({ domain: 'formal', confidence: 0.9 }), false), /mode=formal/);

  // non-deep_explore → empty (caller skips)
  assert.equal(buildDeepExploreNudge({ route: 'plan', confidence: 0.9, reason: 'r' }, true), '');
  assert.equal(buildDeepExploreNudge(null, true), '');
});
