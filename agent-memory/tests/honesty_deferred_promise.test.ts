/**
 * A promise pushed into the future, with nothing armed to make that future happen.
 *
 * Production 2026-07-25 21:45. The owner picked direction 1; the reply was "我来原创构造… 几个小时内我会跑
 * 一轮大规模搜索" with ZERO tool calls, and the honesty gate passed it — every run-promise pattern anchors
 * on NOW (现在/这就/马上/let me/i'll now), so a deferred promise matched none of them. In an async channel
 * the end of a turn yields control until the owner speaks again, so "in a few hours" is a time that never
 * arrives: eight minutes later the owner had to ask "你在编写python脚本吗？" ("还没有"), then "为啥你没跑一
 * 轮？" ("你说得对，我应该直接写"). The owner had become the scheduler.
 *
 * The rule is not "never promise later" — deep_explore(auto_on) and schedule_reminder genuinely run
 * unattended. A deferred promise is honest exactly when one of them was armed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDeferredRunPromise, unattendedWorkArmed, evaluateHonesty } from '../src/honesty_gate.js';

const THE_REPLY = '好，方向 1。我来原创构造 16+ 顶点、P₆-自由、K₄-自由、χ=4、非可迹的图并验证 r(G)。几个小时内我会跑一轮大规模搜索。';

test('the production sentence is recognised as a deferred promise', () => {
  const m = findDeferredRunPromise(THE_REPLY);
  assert.ok(m, 'the 21:45 reply must not pass silently');
  assert.match(m!, /几个小时内|我会跑/);
});

test('other deferred shapes, both languages', () => {
  assert.ok(findDeferredRunPromise('稍后我再跑一遍完整搜索。'));
  assert.ok(findDeferredRunPromise('今晚会把脚本写完。'));
  assert.ok(findDeferredRunPromise("I'll run the full search in a few hours."));
  assert.ok(findDeferredRunPromise('Later tonight I will run the exhaustive search.'));
});

test('a promise the OWNER triggers is not an unattended promise', () => {
  // The ask-tier and "reply continue" flows depend on being able to say exactly this.
  assert.equal(findDeferredRunPromise('你回复"继续"，我就再跑一轮。'), null);
  assert.equal(findDeferredRunPromise('需要的话我再跑一遍。'), null);
});

test('a plain statement of not-having-run is not a promise', () => {
  assert.equal(findDeferredRunPromise('我还没跑，这轮只做了文献检索。'), null);
});

test('arming is what makes "later" real', () => {
  assert.equal(unattendedWorkArmed([{ toolName: 'webSearch' }]), false);
  assert.equal(unattendedWorkArmed([{ toolName: 'deep_explore', toolInput: { action: 'continue' } }]), false);
  assert.equal(unattendedWorkArmed([{ toolName: 'deep_explore', toolInput: { action: 'auto_on' } }]), true);
  assert.equal(unattendedWorkArmed([{ toolName: 'schedule_reminder', toolInput: {} }]), true);
  // toolInput arrives as raw JSON on some call sites — reading only the object shape would answer
  // "not armed" for half of them, which is this repo's recurring silent-miss class.
  assert.equal(unattendedWorkArmed([{ toolName: 'deep_explore', toolInput: '{"action":"auto_on"}' }]), true);
});

test('the gate fires high on the FIRST unarmed deferred promise', () => {
  const v = evaluateHonesty(THE_REPLY, { toolResults: [] });
  assert.ok(v, 'zero tools + deferred promise + nothing armed');
  assert.equal(v!.reason, 'deferred_promise_unarmed');
  assert.equal(v!.severity, 'high', 'not soft: the turn ends and no ticker picks the work up');
  assert.match(v!.evidence, /auto_on|schedule_reminder/, 'the correction must name the real mechanisms');
});

test('the same promise WITH the ticker armed passes', () => {
  const v = evaluateHonesty(THE_REPLY, {
    toolResults: [{ toolName: 'deep_explore', content: 'auto-advance enabled', toolInput: { action: 'auto_on' } }],
  });
  assert.equal(v?.reason, undefined, 'armed work makes a deferred promise honest');
});
