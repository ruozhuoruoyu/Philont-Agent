/**
 * ProviderProfile reasoning-wire tests.
 *
 * 2026-06-07: locks in the per-provider thinking/reasoning translation introduced
 * with the ProviderProfile layer — notably the DeepSeek reasoning_content echo-400
 * defence (thinking field ALWAYS pinned on capable models) and the empty-text fix
 * (max_tokens raised for high/max effort).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProfile,
  DeepSeekProfile,
  AnthropicNativeProfile,
  KimiProfile,
  OpenAICompatProfile,
} from '../src/providers/index.js';

const BASE = 16000;

test('resolveProfile picks the right profile by model id', () => {
  assert.equal(resolveProfile('deepseek-v4-pro').name, 'deepseek');
  assert.equal(resolveProfile('deepseek-v4-flash').name, 'deepseek');
  assert.equal(resolveProfile('deepseek-chat').name, 'deepseek'); // v3 → deepseek profile, but no thinking
  assert.equal(resolveProfile('claude-opus-4-8').name, 'anthropic-native');
  assert.equal(resolveProfile('moonshot-v1-128k').name, 'kimi');
  assert.equal(resolveProfile('kimi-k2').name, 'kimi');
  assert.equal(resolveProfile('gpt-4o').name, 'openai-compat');
});

test('DeepSeek: V4 thinks, V3 does not', () => {
  const p = new DeepSeekProfile();
  assert.equal(p.supportsThinking('deepseek-v4-pro'), true);
  assert.equal(p.supportsThinking('deepseek-v4-flash'), true);
  assert.equal(p.supportsThinking('deepseek-reasoner'), true);
  assert.equal(p.supportsThinking('deepseek-v3'), false);
  assert.equal(p.supportsThinking('deepseek-chat'), false);
});

test('DeepSeek echo-400 defence: thinking field pinned even with no reasoning passed', () => {
  const p = new DeepSeekProfile();
  // undefined reasoning → default ENABLED, but the field is still emitted explicitly
  const wire = p.buildReasoningWire('deepseek-v4-pro', undefined);
  assert.deepEqual(wire.anthropicParams?.thinking, { type: 'enabled', budget_tokens: 12000 });
  assert.deepEqual(wire.openaiExtraBody?.thinking, { type: 'enabled' });
});

test('DeepSeek: enabled:false emits explicit disabled (both wire formats)', () => {
  const p = new DeepSeekProfile();
  const wire = p.buildReasoningWire('deepseek-v4-pro', { enabled: false });
  assert.deepEqual(wire.anthropicParams?.thinking, { type: 'disabled' });
  assert.deepEqual(wire.openaiExtraBody?.thinking, { type: 'disabled' });
  assert.equal(wire.openaiTopLevel, undefined);
});

test('DeepSeek: effort maps to output_config (anthropic) + reasoning_effort (openai)', () => {
  const p = new DeepSeekProfile();
  const wire = p.buildReasoningWire('deepseek-v4-pro', { enabled: true, effort: 'max' });
  assert.deepEqual(wire.anthropicParams?.output_config, { effort: 'max' });
  assert.equal(wire.openaiTopLevel?.reasoning_effort, 'max');
});

test('DeepSeek: effort omitted → no effort field (server default)', () => {
  const p = new DeepSeekProfile();
  const wire = p.buildReasoningWire('deepseek-v4-pro', { enabled: true });
  assert.equal(wire.anthropicParams?.output_config, undefined);
  assert.equal(wire.openaiTopLevel?.reasoning_effort, undefined);
});

test('DeepSeek: V3 leaves wire untouched', () => {
  const p = new DeepSeekProfile();
  assert.deepEqual(p.buildReasoningWire('deepseek-chat', { enabled: true, effort: 'max' }), {});
});

test('DeepSeek max_tokens: raised only for high/max effort', () => {
  const p = new DeepSeekProfile();
  assert.equal(p.resolveMaxTokens('deepseek-v4-pro', { enabled: true, effort: 'max' }, BASE), 32000);
  assert.equal(p.resolveMaxTokens('deepseek-v4-pro', { enabled: true, effort: 'high' }, BASE), 32000);
  assert.equal(p.resolveMaxTokens('deepseek-v4-pro', { enabled: true, effort: 'low' }, BASE), BASE);
  assert.equal(p.resolveMaxTokens('deepseek-v4-pro', { enabled: false }, BASE), BASE);
  assert.equal(p.resolveMaxTokens('deepseek-chat', { enabled: true, effort: 'max' }, BASE), BASE);
});

test('Anthropic-native (Claude): thinking is opt-in, no output_config', () => {
  const p = new AnthropicNativeProfile();
  // default (no reasoning) → standard non-thinking request (field omitted)
  assert.deepEqual(p.buildReasoningWire('claude-opus-4-8', undefined), {});
  assert.deepEqual(p.buildReasoningWire('claude-opus-4-8', { enabled: false }), {});
  // opt-in
  const on = p.buildReasoningWire('claude-opus-4-8', { enabled: true });
  assert.deepEqual(on.anthropicParams?.thinking, { type: 'enabled', budget_tokens: 12000 });
  assert.equal(on.anthropicParams?.output_config, undefined); // Claude has no effort wire
  // max_tokens guarantees headroom over budget_tokens when enabled
  assert.ok(p.resolveMaxTokens('claude-opus-4-8', { enabled: true }, BASE) > 12000);
});

test('Kimi supports thinking; plain OpenAI-compat does not', () => {
  const k = new KimiProfile();
  const on = k.buildReasoningWire('moonshot-v1-128k', { enabled: true, effort: 'high' });
  assert.deepEqual(on.openaiExtraBody?.thinking, { type: 'enabled' });
  assert.equal(on.openaiTopLevel?.reasoning_effort, 'high');

  const plain = new OpenAICompatProfile();
  assert.equal(plain.supportsThinking('gpt-4o'), false);
  assert.deepEqual(plain.buildReasoningWire('gpt-4o', { enabled: true, effort: 'max' }), {});
});

// ── GLM (2026-10-09) ──────────────────────────────────────────────────────────────────────────────
// Prod: glm5.3-flash-b30t over the Anthropic protocol resolved to OpenAICompatProfile (empty wire), so
// the endpoint's default-on thinking ran until max_tokens on every call — 31 thinking-only retries in a
// day, one of them 32000 thinking tokens on a 61-token prompt — and "retrying at effort=low" changed
// nothing on the wire.

import { GlmProfile } from '../src/providers/index.js';
import { planThinkingOnlyRetry as adapterPlan } from '../src/llm-adapter.js';

test('resolveProfile: glm* gets the GLM profile, not the empty OpenAI-compat wire', () => {
  assert.equal(resolveProfile('glm5.3-flash-b30t').name, 'glm');
  assert.equal(resolveProfile('GLM-4.5-air').name, 'glm');
  assert.equal(resolveProfile('gpt-4o').name, 'openai-compat');
});

test('GLM: the thinking toggle is ALWAYS pinned, on both wire formats, with no budget_tokens', () => {
  const p = new GlmProfile();
  const on = p.buildReasoningWire('glm5.3-flash-b30t', { enabled: true, effort: 'high' });
  assert.deepEqual(on.anthropicParams?.thinking, { type: 'enabled' });
  assert.deepEqual(on.openaiExtraBody?.thinking, { type: 'enabled' });
  assert.equal(on.openaiTopLevel, undefined, 'GLM has no effort knob to send');
  const dflt = p.buildReasoningWire('glm5.3-flash-b30t', undefined);
  assert.deepEqual(dflt.anthropicParams?.thinking, { type: 'enabled' }, 'no config still pins the field');
  const off = p.buildReasoningWire('glm5.3-flash-b30t', { enabled: false });
  assert.deepEqual(off.anthropicParams?.thinking, { type: 'disabled' });
  assert.deepEqual(off.openaiExtraBody?.thinking, { type: 'disabled' });
});

test('GLM: low effort IS thinking off — the only cheap variant the model has', () => {
  const p = new GlmProfile();
  const low = p.buildReasoningWire('glm5.3-flash-b30t', { enabled: true, effort: 'low' });
  assert.deepEqual(low.anthropicParams?.thinking, { type: 'disabled' });
  assert.equal(p.resolveMaxTokens('glm5.3-flash-b30t', { enabled: true, effort: 'low' }, BASE), BASE);
  assert.equal(p.resolveMaxTokens('glm5.3-flash-b30t', { enabled: true, effort: 'max' }, BASE), 32000);
  assert.equal(p.resolveMaxTokens('glm5.3-flash-b30t', { enabled: true, effort: 'medium' }, BASE), BASE);
  assert.equal(p.supportsEffort('glm5.3-flash-b30t'), false);
});

test('thinking-only retry on a profile without an effort knob goes straight to thinking off', () => {
  // With the knob: max → high (one notch). Without it: off — the only change the wire can carry.
  const withKnob = adapterPlan({ enabled: true, effort: 'max' }, 16000, true);
  assert.deepEqual(withKnob?.reasoning, { enabled: true, effort: 'high' });
  const noKnob = adapterPlan({ enabled: true, effort: 'max' }, 16000, false);
  assert.deepEqual(noKnob?.reasoning, { enabled: false });
  assert.equal(noKnob?.maxTokens, 32000);
  assert.equal(adapterPlan({ enabled: false }, 16000, false), null, 'thinking was already off — some other failure');
});
