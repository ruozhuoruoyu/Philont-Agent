import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  callAuxLLM,
  registerMainLLM,
  clearMainLLMRegistration,
  hasMainLLMRegistered,
  isAuxLLMConfigured,
  auxLLMHealth,
  probeAuxLLM,
  AuxLLMError,
  type AuxLLMCaller,
  type AuxLLMRequest,
} from '../src/utils/aux-llm.js';

// ── 测试工具 ──────────────────────────────────────────────

const ENV_KEYS = [
  'AUX_LLM_BASE_URL',
  'AUX_LLM_API_KEY',
  'AUX_LLM_MODEL',
  'AUX_LLM_PROTOCOL',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function saveEnv() {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function setAuxEnv(base = 'https://api.example.com/v1', key = 'sk-test', model = 'mini-llm') {
  process.env.AUX_LLM_BASE_URL = base;
  process.env.AUX_LLM_API_KEY = key;
  process.env.AUX_LLM_MODEL = model;
}

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: unknown;
}

function mockFetch(
  responder: (call: CapturedCall) => Response | Promise<Response>,
): { restore: () => void; calls: CapturedCall[] } {
  const original = globalThis.fetch;
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let body: unknown;
    try {
      body = init.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      body = init.body;
    }
    const call: CapturedCall = { url, init, body };
    calls.push(call);
    return responder(call);
  }) as typeof globalThis.fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

function makeOpenAIResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function makeAnthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ── 套件 ──────────────────────────────────────────────────

describe('aux-llm', () => {
  before(saveEnv);
  after(restoreEnv);
  beforeEach(() => {
    clearEnv();
    clearMainLLMRegistration();
  });
  afterEach(() => {
    clearMainLLMRegistration();
  });

  describe('configuration detection', () => {
    it('isAuxLLMConfigured returns false when env not set', () => {
      assert.equal(isAuxLLMConfigured(), false);
    });

    it('isAuxLLMConfigured returns true only when all three env vars set', () => {
      process.env.AUX_LLM_BASE_URL = 'https://x';
      assert.equal(isAuxLLMConfigured(), false);
      process.env.AUX_LLM_API_KEY = 'k';
      assert.equal(isAuxLLMConfigured(), false);
      process.env.AUX_LLM_MODEL = 'm';
      assert.equal(isAuxLLMConfigured(), true);
    });

    it('hasMainLLMRegistered reflects registration state', () => {
      assert.equal(hasMainLLMRegistered(), false);
      registerMainLLM(async () => 'x');
      assert.equal(hasMainLLMRegistered(), true);
      clearMainLLMRegistration();
      assert.equal(hasMainLLMRegistered(), false);
    });
  });

  describe('callAuxLLM — env path (small model)', () => {
    it('calls OpenAI-compatible endpoint with correct shape', async () => {
      setAuxEnv('https://api.example.com/v1', 'sk-test-123', 'mini-llm');
      const fakeFetch = mockFetch(() => makeOpenAIResponse('answer text'));
      try {
        const out = await callAuxLLM({ system: 'sys', user: 'hello' });
        assert.equal(out, 'answer text');
        assert.equal(fakeFetch.calls.length, 1);
        const call = fakeFetch.calls[0];
        assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer sk-test-123');
        assert.equal(headers['Content-Type'], 'application/json');
        const body = call.body as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          stream: boolean;
        };
        assert.equal(body.model, 'mini-llm');
        assert.equal(body.stream, false);
        assert.deepEqual(body.messages, [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' },
        ]);
      } finally {
        fakeFetch.restore();
      }
    });

    it('omits system message when not provided', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        const body = fakeFetch.calls[0].body as {
          messages: Array<{ role: string }>;
        };
        assert.equal(body.messages.length, 1);
        assert.equal(body.messages[0].role, 'user');
      } finally {
        fakeFetch.restore();
      }
    });

    it('handles base url that already includes /chat/completions', async () => {
      setAuxEnv('https://api.example.com/v1/chat/completions', 'k', 'm');
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(
          fakeFetch.calls[0].url,
          'https://api.example.com/v1/chat/completions',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws AuxLLMError on HTTP error', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () => new Response('rate limited', { status: 429 }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            assert.ok(e instanceof AuxLLMError);
            assert.equal((e as AuxLLMError).kind, 'http_error');
            assert.equal((e as AuxLLMError).status, 429);
            return true;
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on empty choice content', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
            status: 200,
          }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => (e as AuxLLMError).kind === 'invalid_response',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('diagnoses reasoning-only responses instead of hiding why content is empty', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () => new Response(JSON.stringify({
          choices: [{
            message: { content: '', reasoning_content: 'thinking without a final answer' },
            finish_reason: 'length',
          }],
        }), { status: 200 }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q', maxTokens: 256 }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            assert.equal(err.kind, 'output_truncated');
            assert.match(err.message, /finish_reason=length, content_chars=0, reasoning_chars=31, max_tokens=1024/);
            return true;
          },
        );
        assert.deepEqual(
          fakeFetch.calls.map((call) => (call.body as { max_tokens: number }).max_tokens),
          [256, 512, 1024],
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('a budget spent with NO content and NO reasoning is retried with thinking off, not with a bigger budget', async () => {
      // Prod 2026-09-02: the owner switched aux to glm5.3-flash-b30t. `auxThinkingDisabled` is a list
      // of model-name prefixes (deepseek-v4+/reasoner/kimi/moonshot) and GLM was not on it, so nothing
      // turned thinking off; the ladder walked 256 → 512 → 1024 and every reply came back
      // `content_chars=0, reasoning_chars=0`. Doubling a budget that something invisible is eating
      // just buys a bigger nothing, and a hard-coded family list silently misses every model nobody
      // has added yet — so the ladder reacts to the SIGNATURE, which needs no model name.
      setAuxEnv(undefined, undefined, 'some-new-thinking-model-nobody-listed');
      const fakeFetch = mockFetch((call) => {
        const body = call.body as { thinking?: { type: string } };
        if (body.thinking?.type === 'disabled') {
          return new Response(JSON.stringify({
            choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        }), { status: 200 });
      });
      try {
        assert.equal(await callAuxLLM({ user: 'q', maxTokens: 256 }), 'the answer');
        const sent = fakeFetch.calls.map((c) => c.body as { max_tokens: number; thinking?: { type: string } });
        assert.equal(sent.length, 2, 'one failure, then one retry — not a walk up the ladder');
        assert.equal(sent[0].thinking, undefined, 'an unlisted model gets no thinking field on the first try');
        assert.equal(sent[1].thinking?.type, 'disabled');
        // ONE variable at a time. The signature says the budget was spent producing nothing, so more
        // of it is not indicated — and raising it here also hides which change was the one that worked.
        assert.equal(sent[1].max_tokens, sent[0].max_tokens, 'same budget, only the mode changed');
      } finally {
        fakeFetch.restore();
      }
    });

    it('a truncation that DID return reasoning still walks the token ladder', async () => {
      // The other failure wearing the same finish_reason: the model really did produce output and ran
      // out of room. More budget is the right answer there, and must stay the answer.
      setAuxEnv(undefined, undefined, 'some-new-thinking-model-nobody-listed');
      const fakeFetch = mockFetch(() => new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'partial thought' }, finish_reason: 'length' }],
      }), { status: 200 }));
      try {
        await assert.rejects(() => callAuxLLM({ user: 'q', maxTokens: 256 }));
        const sent = fakeFetch.calls.map((c) => c.body as { max_tokens: number; thinking?: { type: string } });
        assert.deepEqual(sent.map((b) => b.max_tokens), [256, 512, 1024]);
        assert.ok(sent.every((b) => b.thinking === undefined), 'visible reasoning is not the invisible-thinking case');
      } finally {
        fakeFetch.restore();
      }
    });

    it('a GLM model has thinking off on the FIRST call, not the second', () => {
      setAuxEnv(undefined, undefined, 'glm5.3-flash-b30t');
      const fakeFetch = mockFetch(() => new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200 }));
      return callAuxLLM({ user: 'q', maxTokens: 256 }).then(() => {
        const body = fakeFetch.calls[0].body as { thinking?: { type: string } };
        assert.equal(body.thinking?.type, 'disabled');
      }).finally(() => fakeFetch.restore());
    });

    it('retries a length-truncated response once with a larger token budget', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch((call) => {
        const maxTokens = (call.body as { max_tokens: number }).max_tokens;
        if (maxTokens === 256) {
          // Reasoning came back, so the model really did generate and run out of room — the case a
          // bigger budget answers. (A reply with NEITHER content nor reasoning is a different
          // failure and takes the thinking-off path; see the test above.)
          return new Response(JSON.stringify({
            choices: [{
              message: { content: '', reasoning_content: 'partial thought' },
              finish_reason: 'length',
            }],
          }), { status: 200 });
        }
        return makeOpenAIResponse('selected');
      });
      try {
        assert.equal(await callAuxLLM({ user: 'q', maxTokens: 256 }), 'selected');
        assert.deepEqual(
          fakeFetch.calls.map((call) => (call.body as { max_tokens: number }).max_tokens),
          [256, 512],
        );
        assert.equal(auxLLMHealth().circuitOpen, false);
      } finally {
        fakeFetch.restore();
      }
    });

    it('rejects partial content when finish_reason says it was truncated', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch((call) => {
        const maxTokens = (call.body as { max_tokens: number }).max_tokens;
        if (maxTokens < 1024) {
          return new Response(JSON.stringify({
            choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
          }), { status: 200 });
        }
        return makeOpenAIResponse('{"complete":true}');
      });
      try {
        assert.equal(await callAuxLLM({ user: 'json', maxTokens: 256, requireComplete: true }), '{"complete":true}');
        assert.deepEqual(
          fakeFetch.calls.map((call) => (call.body as { max_tokens: number }).max_tokens),
          [256, 512, 1024],
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('accepts usable truncated text for a closed-set classifier without retrying', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(() => new Response(JSON.stringify({
        choices: [{ message: { content: 'grant' }, finish_reason: 'length' }],
      }), { status: 200 }));
      try {
        assert.equal(await callAuxLLM({ user: 'classify', maxTokens: 4 }), 'grant');
        assert.equal(fakeFetch.calls.length, 1);
      } finally {
        fakeFetch.restore();
      }
    });

    it('health probe uses a representative budget and never permits main fallback', async () => {
      setAuxEnv();
      registerMainLLM(async () => 'main-must-not-mask-aux');
      const fakeFetch = mockFetch(() => makeOpenAIResponse('ok'));
      try {
        assert.deepEqual(await probeAuxLLM(), { ok: true });
        const body = fakeFetch.calls[0].body as { max_tokens?: number };
        assert.equal(body.max_tokens, 256);
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on provider error JSON', async () => {
      setAuxEnv();
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({ error: { message: 'invalid api key', type: 'auth_error' } }),
            { status: 200 },
          ),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return err.kind === 'http_error' && /invalid api key/.test(err.message);
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — anthropic protocol', () => {
    it('uses /v1/messages and x-api-key header when AUX_LLM_PROTOCOL=anthropic', async () => {
      setAuxEnv('https://neolink.vnet.com/api', 'sk-ant-test', 'deepseek-v4-flash');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(() => makeAnthropicResponse('anthropic reply'));
      try {
        const out = await callAuxLLM({ system: 'you are helpful', user: 'hi' });
        assert.equal(out, 'anthropic reply');
        assert.equal(fakeFetch.calls.length, 1);
        const call = fakeFetch.calls[0];
        assert.equal(call.url, 'https://neolink.vnet.com/api/v1/messages');
        const headers = call.init.headers as Record<string, string>;
        assert.equal(headers['x-api-key'], 'sk-ant-test');
        assert.equal(headers['anthropic-version'], '2023-06-01');
        const body = call.body as {
          model: string;
          system?: string;
          messages: Array<{ role: string; content: string }>;
        };
        assert.equal(body.model, 'deepseek-v4-flash');
        assert.equal(body.system, 'you are helpful');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
      } finally {
        fakeFetch.restore();
      }
    });

    it('auto-detects anthropic protocol from baseUrl containing "anthropic"', async () => {
      setAuxEnv('https://api.anthropic.com', 'sk-ant', 'claude-haiku-4-5');
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(fakeFetch.calls[0].url, 'https://api.anthropic.com/v1/messages');
      } finally {
        fakeFetch.restore();
      }
    });

    it('explicit AUX_LLM_PROTOCOL=openai overrides anthropic-looking baseUrl', async () => {
      setAuxEnv('https://anthropic-proxy.example.com/v1', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'openai';
      const fakeFetch = mockFetch(() => makeOpenAIResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(
          fakeFetch.calls[0].url,
          'https://anthropic-proxy.example.com/v1/chat/completions',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('handles base url that already includes /v1/messages', async () => {
      setAuxEnv('https://neolink.vnet.com/api/v1/messages', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        assert.equal(fakeFetch.calls[0].url, 'https://neolink.vnet.com/api/v1/messages');
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws invalid_response with HTML hint when endpoint returns HTML', async () => {
      setAuxEnv('https://neolink.vnet.com/api', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(
        () =>
          new Response('<html>404 not found</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return (
              err.kind === 'invalid_response' &&
              /anthropic/.test(err.message) &&
              /\[hint\]/.test(err.message)
            );
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('omits system field when not provided', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(() => makeAnthropicResponse('y'));
      try {
        await callAuxLLM({ user: 'q' });
        const body = fakeFetch.calls[0].body as { system?: string };
        assert.equal(body.system, undefined);
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws on empty content array', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(
        () =>
          new Response(
            JSON.stringify({ content: [], stop_reason: 'end_turn' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => (e as AuxLLMError).kind === 'invalid_response',
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('throws AuxLLMError on HTTP error in anthropic path', async () => {
      setAuxEnv('https://api.anthropic.com', 'k', 'm');
      const fakeFetch = mockFetch(
        () => new Response('rate limited', { status: 429 }),
      );
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'q' }),
          (e: unknown) => {
            const err = e as AuxLLMError;
            return err.kind === 'http_error' && err.status === 429 &&
                   /anthropic/.test(err.message);
          },
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('does not accept partial Anthropic text stopped by max_tokens', async () => {
      setAuxEnv('https://api.anthropic.com/v1', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch((call) => {
        const maxTokens = (call.body as { max_tokens: number }).max_tokens;
        if (maxTokens < 1024) {
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: '{"partial":' }],
            stop_reason: 'max_tokens',
          }), { status: 200 });
        }
        return makeAnthropicResponse('{"complete":true}');
      });
      try {
        assert.equal(await callAuxLLM({ user: 'json', maxTokens: 256, requireComplete: true }), '{"complete":true}');
        assert.deepEqual(
          fakeFetch.calls.map((call) => (call.body as { max_tokens: number }).max_tokens),
          [256, 512, 1024],
        );
      } finally {
        fakeFetch.restore();
      }
    });

    it('accepts usable max_tokens text for a closed-set Anthropic classifier', async () => {
      setAuxEnv('https://api.anthropic.com/v1', 'k', 'm');
      process.env.AUX_LLM_PROTOCOL = 'anthropic';
      const fakeFetch = mockFetch(() => new Response(JSON.stringify({
        content: [{ type: 'text', text: 'ACCEPT' }],
        stop_reason: 'max_tokens',
      }), { status: 200 }));
      try {
        assert.equal(await callAuxLLM({ user: 'classify', maxTokens: 8 }), 'ACCEPT');
        assert.equal(fakeFetch.calls.length, 1);
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — fallback to main LLM', () => {
    it('uses registered main caller when env not configured', async () => {
      const calls: AuxLLMRequest[] = [];
      const main: AuxLLMCaller = async (req) => {
        calls.push(req);
        return 'main-result';
      };
      registerMainLLM(main);

      const out = await callAuxLLM({ system: 's', user: 'u' });
      assert.equal(out, 'main-result');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].user, 'u');
      assert.equal(calls[0].system, 's');
    });

    it('honours fallbackToMain=false even when aux env is entirely absent', async () => {
      let mainCalled = false;
      registerMainLLM(async () => {
        mainCalled = true;
        return 'must-not-run';
      });
      await assert.rejects(
        () => callAuxLLM({ user: 'background classification', fallbackToMain: false }),
        (e: unknown) => e instanceof AuxLLMError && e.kind === 'not_configured',
      );
      assert.equal(mainCalled, false);
    });

    it('prefers env config over main caller when both set', async () => {
      setAuxEnv();
      let mainCalled = false;
      registerMainLLM(async () => {
        mainCalled = true;
        return 'should-not-be-called';
      });
      const fakeFetch = mockFetch(() => makeOpenAIResponse('from-env'));
      try {
        const out = await callAuxLLM({ user: 'q' });
        assert.equal(out, 'from-env');
        assert.equal(mainCalled, false);
      } finally {
        fakeFetch.restore();
      }
    });

    it('falls back to the registered main caller when configured aux returns empty content', async () => {
      setAuxEnv();
      const mainCalls: AuxLLMRequest[] = [];
      registerMainLLM(async (req) => {
        mainCalls.push(req);
        return 'recovered-by-main';
      });
      const fakeFetch = mockFetch(() => makeOpenAIResponse(''));
      try {
        const out = await callAuxLLM({ system: 'classify', user: 'q', maxTokens: 20 });
        assert.equal(out, 'recovered-by-main');
        assert.equal(fakeFetch.calls.length, 1);
        assert.equal(mainCalls.length, 1);
        assert.equal(mainCalls[0].user, 'q');
      } finally {
        fakeFetch.restore();
      }
    });

    it('does not let a main fallback mask aux failure when fallbackToMain is false', async () => {
      setAuxEnv();
      let mainCalled = false;
      registerMainLLM(async () => {
        mainCalled = true;
        return 'main';
      });
      const fakeFetch = mockFetch(() => makeOpenAIResponse(''));
      try {
        await assert.rejects(
          () => callAuxLLM({ user: 'probe', fallbackToMain: false }),
          /Aux LLM returned empty content/,
        );
        assert.equal(mainCalled, false);
      } finally {
        fakeFetch.restore();
      }
    });

    it('opens a circuit after repeated aux failures and sends later calls straight to main', async () => {
      setAuxEnv();
      registerMainLLM(async () => 'main');
      const fakeFetch = mockFetch(() => makeOpenAIResponse(''));
      try {
        assert.equal(await callAuxLLM({ user: 'one' }), 'main');
        assert.equal(await callAuxLLM({ user: 'two' }), 'main');
        assert.equal(await callAuxLLM({ user: 'three' }), 'main');
        assert.equal(fakeFetch.calls.length, 3);

        assert.equal(await callAuxLLM({ user: 'four' }), 'main');
        assert.equal(fakeFetch.calls.length, 3);
        assert.equal(auxLLMHealth().circuitOpen, true);
      } finally {
        fakeFetch.restore();
      }
    });

    it('does not open the endpoint circuit for repeated output-budget truncation', async () => {
      setAuxEnv();
      registerMainLLM(async () => 'main');
      const fakeFetch = mockFetch(() => new Response(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
      }), { status: 200 }));
      try {
        assert.equal(await callAuxLLM({ user: 'one', maxTokens: 4 }), 'main');
        assert.equal(await callAuxLLM({ user: 'two', maxTokens: 4 }), 'main');
        assert.equal(await callAuxLLM({ user: 'three', maxTokens: 4 }), 'main');
        assert.equal(auxLLMHealth().circuitOpen, false);
        assert.equal(fakeFetch.calls.length, 9, 'each call should try 4, 512, then 1024 tokens');
      } finally {
        fakeFetch.restore();
      }
    });
  });

  describe('callAuxLLM — not configured', () => {
    it('throws AuxLLMError(not_configured) when neither env nor main caller set', async () => {
      await assert.rejects(
        () => callAuxLLM({ user: 'q' }),
        (e: unknown) => {
          assert.ok(e instanceof AuxLLMError);
          assert.equal((e as AuxLLMError).kind, 'not_configured');
          return true;
        },
      );
    });
  });
});

it('a max_tokens too small to answer in is raised to the floor', async () => {
  // Prod 2026-09-02: this endpoint truncated at max_tokens 4, 8 and 96 with
  // `content_chars=0, reasoning_chars=0` — the budget was gone before a character came back, and each
  // call then paid for the retry ladder to rediscover it. Callers write `maxTokens: 4` for a one-word
  // verdict, which is a reasonable thing to want and an unreasonable budget to grant.
  const seen: Array<number | undefined> = [];
  registerMainLLM(async (req) => {
    seen.push(req.maxTokens);
    return 'yes';
  });
  const prev = process.env.AUX_LLM_BASE_URL;
  delete process.env.AUX_LLM_BASE_URL; // force the registered main-LLM path
  try {
    await callAuxLLM({ system: 's', user: 'u', maxTokens: 4 });
    await callAuxLLM({ system: 's', user: 'u', maxTokens: 8 });
    await callAuxLLM({ system: 's', user: 'u', maxTokens: 2048 });
    assert.deepEqual(seen, [256, 256, 2048], 'raised to the floor, never lowered');
    const untouched = await callAuxLLM({ system: 's', user: 'u' });
    assert.equal(untouched, 'yes');
    assert.equal(seen[3], undefined, 'an unset budget stays unset — the default is elsewhere');
  } finally {
    if (prev !== undefined) process.env.AUX_LLM_BASE_URL = prev;
  }
});

describe('callAuxLLM — reporting enough to diagnose an empty reply', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('an empty reply reports the provider token usage', async () => {
    // Three failures wear the same `finish_reason=length` with nothing returned — tokens spent on an
    // invisible thinking block, a prompt that filled the context leaving no room to generate in, or a
    // proxy dropping the body. They are told apart by these numbers, and until 2026-09-02 the response
    // was parsed without ever reading them, so each diagnosis was a guess. Two of mine were wrong.
    setAuxEnv();
    const fakeFetch = mockFetch(() => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 31_402, completion_tokens: 0, total_tokens: 31_402 },
    }), { status: 200 }));
    try {
      await assert.rejects(
        () => callAuxLLM({ user: 'q', maxTokens: 256, fallbackToMain: false }),
        (e: unknown) => {
          assert.match((e as AuxLLMError).message, /prompt=31402 completion=0 total=31402/);
          return true;
        },
      );
    } finally {
      fakeFetch.restore();
    }
  });

  it('says so plainly when the provider reports no usage at all', async () => {
    setAuxEnv();
    const fakeFetch = mockFetch(() => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200 }));
    try {
      await assert.rejects(
        () => callAuxLLM({ user: 'q', maxTokens: 256, fallbackToMain: false }),
        (e: unknown) => {
          assert.match((e as AuxLLMError).message, /usage=not-reported/);
          return true;
        },
      );
    } finally {
      fakeFetch.restore();
    }
  });
});
