import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAuxLLM } from '../src/utils/aux-llm.js';

const KEYS = ['AUX_LLM_BASE_URL', 'AUX_LLM_API_KEY', 'AUX_LLM_MODEL', 'AUX_LLM_PROTOCOL'] as const;
function setEnv(base: string, protocol?: string) {
  process.env.AUX_LLM_BASE_URL = base;
  process.env.AUX_LLM_API_KEY = 'k';
  process.env.AUX_LLM_MODEL = 'm';
  if (protocol) process.env.AUX_LLM_PROTOCOL = protocol; else delete process.env.AUX_LLM_PROTOCOL;
}

async function capture(base: string, protocol?: string): Promise<string> {
  setEnv(base, protocol);
  const orig = globalThis.fetch;
  let seen = '';
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string) => {
    seen = String(url);
    const payload = protocol === 'anthropic'
      ? { content: [{ type: 'text', text: 'ok' }] }
      : { choices: [{ message: { content: 'ok' } }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { await callAuxLLM({ user: 'hi' }); } finally { globalThis.fetch = orig; }
  return seen;
}

test('openai: bare host gets /v1/chat/completions (the prod 404 case)', async () => {
  assert.equal(await capture('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
});
test('openai: host+/v1 gets /chat/completions', async () => {
  assert.equal(await capture('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
});
test('openai: full endpoint used as-is', async () => {
  assert.equal(await capture('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
});
test('openai: non-/v1 path prefix (GLM style) just gets the method', async () => {
  assert.equal(await capture('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
});
test('anthropic: bare host gets /v1/messages', async () => {
  assert.equal(await capture('https://gw.example.com', 'anthropic'), 'https://gw.example.com/v1/messages');
});
test('anthropic: host+/v1 does not double to /v1/v1/messages', async () => {
  assert.equal(await capture('https://gw.example.com/v1', 'anthropic'), 'https://gw.example.com/v1/messages');
});

for (const k of KEYS) if (process.env[k]) delete process.env[k];

test('anthropic: non-version path prefix (/api) still gets /v1/messages', async () => {
  assert.equal(await capture('https://neolink.vnet.com/api', 'anthropic'), 'https://neolink.vnet.com/api/v1/messages');
});
