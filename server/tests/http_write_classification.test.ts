/**
 * Every external write this agent made over http was authorized as a page fetch.
 *
 * `http` and `securedHttp` declare `capability: 'read', domain: 'network'` statically and carry a
 * `classify(params)` that upgrades POST/PUT/PATCH/DELETE to write × network. The default matrix
 * permits read × network outright and denies write × network. So the dynamic classifier is the only
 * thing standing between "fetch a page" and "post to someone's API" — and the lambda handed to
 * createToolChecker dropped the params argument, so it was never consulted where it mattered.
 *
 * Registering an account, publishing content, calling a webhook: all of it went through as read.
 * The classifier was written and unit-tested; what was missing was one argument at the call site,
 * which is why nothing failed and no card was ever raised.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolRegistry,
  createToolChecker,
  AuditLog,
  GrantStore,
  createDefaultMatrix,
} from '@agent/policy';
import { httpTool } from '@agent/tools';

function checkerFor(passParams: boolean) {
  const registry = new ToolRegistry();
  registry.register(httpTool);
  const audit = new AuditLog();
  return createToolChecker({
    permissions: createDefaultMatrix(),
    audit,
    grantStore: new GrantStore(),
    classifyTool: passParams
      ? (name, params) => registry.classify(name, params)
      : (name) => registry.classify(name),
  });
}

const call = (params: Record<string, unknown>) => ({
  toolName: 'http',
  approval: 'never',
  params: JSON.stringify(params),
});

test('reads still pass without asking — this must not become a prompt on every fetch', async () => {
  const denial = await checkerFor(true)(call({ url: 'https://example.com/page' }));
  assert.equal(denial, null);
  const explicitGet = await checkerFor(true)(call({ url: 'https://example.com/x', method: 'GET' }));
  assert.equal(explicitGet, null);
});

test('an external write over http is denied until authorized', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const denial = await checkerFor(true)(
      call({ url: 'https://api.example.com/agents/register', method, body: '{"handle":"x"}' }),
    );
    assert.ok(denial, `${method} must not pass unasked`);
    assert.match(denial!, /denied by permission matrix/);
  }
});

test('the bug, kept as a test: without the params the same POST sails through as a read', async () => {
  const denial = await checkerFor(false)(
    call({ url: 'https://api.example.com/agents/register', method: 'POST', body: '{"handle":"x"}' }),
  );
  assert.equal(denial, null, 'this is what production did until 2026-08-11');
});

test('an approval covers it, so this costs one card and not a treadmill', async () => {
  const registry = new ToolRegistry();
  registry.register(httpTool);
  const grants = new GrantStore();
  const checker = createToolChecker({
    permissions: createDefaultMatrix(),
    audit: new AuditLog(),
    grantStore: grants,
    classifyTool: (name, params) => registry.classify(name, params),
  });

  const post = call({ url: 'https://api.example.com/posts', method: 'POST', body: '{}' });
  assert.ok(await checker(post), 'denied before approval');

  grants.grant('http', 'write', 'network', 'user approved', 30 * 60_000);
  assert.equal(await checker(post), null, 'and allowed after it, for the whole grant window');
});

test('the registry itself was never wrong — only the caller', () => {
  const registry = new ToolRegistry();
  registry.register(httpTool);
  assert.deepEqual(registry.classify('http', { url: 'u' }), { capability: 'read', domain: 'network' });
  assert.deepEqual(registry.classify('http', { url: 'u', method: 'POST' }), { capability: 'write', domain: 'network' });
  // Name only: falls back to the static declaration, which is the read the matrix waves through.
  assert.deepEqual(registry.classify('http'), { capability: 'read', domain: 'network' });
});
