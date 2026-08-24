import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

test('a completed resumed authorization is settled at both tool execution sites', () => {
  const calls = chat.match(/settleRunningPendingAuth\(sessionId, call\.id\);/g) ?? [];
  assert.equal(calls.length, 2, 'initial and subsequent tool loops must both settle a returned auth call');
  assert.match(
    chat,
    /function settleRunningPendingAuth[\s\S]*?pendingAuth\.delete\(sessionId\);[\s\S]*?persistContinuation\(sessionId\);/,
    'settlement must be durable before the long turn continues',
  );
});

test('a mechanism-initiated repair is a second budgeted tool execution', () => {
  assert.match(
    chat,
    /run: \(input\) => \{\s*totalToolCallsThisTurn\+\+;\s*return tools\.execute\(call\.name, input\);/,
  );
  assert.match(chat, /totalToolCallsThisTurn \+ 1 >= effectiveMax/);
});

test('action accounting keeps the failed input separate from the repaired input', () => {
  assert.match(chat, /originalFailure: failed,[\s\S]*?repairedInput: outcome\.repairedInput/);
  assert.match(chat, /params: originalInput,[\s\S]*?success: false/);
  assert.match(chat, /params: originalInput2,[\s\S]*?success: false/);
  assert.match(chat, /const actualInput = repair\.repairedInput \?\? originalInput/);
  assert.match(chat, /const actualInput2 = repair2\.repairedInput \?\? originalInput2/);
});

test('MCP boot reporting gives a connecting server a grace period before declaring it down', () => {
  assert.match(indexSource, /x\.state === 'connecting'/);
  assert.match(indexSource, /MCP still connecting:[\s\S]*?setTimeout\(\(\) => reportMcpBoot\(true\), 20_000\)/);
  assert.match(indexSource, /x\.state !== 'connected' && x\.state !== 'connecting'/);
});
