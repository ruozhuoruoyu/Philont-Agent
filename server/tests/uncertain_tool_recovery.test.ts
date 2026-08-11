import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyUncertainToolReply } from '../src/chat-handler.js';

test('uncertain tool recovery accepts only explicit retry/skip words', () => {
  for (const word of ['重试', '重新执行', 'retry', 'run again']) {
    assert.equal(classifyUncertainToolReply(word), 'retry');
  }
  for (const word of ['跳过', '不要重试', 'skip', 'do not retry']) {
    assert.equal(classifyUncertainToolReply(word), 'skip');
  }
  for (const ambiguous of ['继续', 'OK', '看看情况', 'is it safe?', 'retry maybe']) {
    assert.equal(classifyUncertainToolReply(ambiguous), 'unknown');
  }
});
