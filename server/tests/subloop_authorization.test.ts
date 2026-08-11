/**
 * planAndExecute's sub-loop ran on the bare registry.
 *
 * `subTurnToolRunner` called `tools.execute()`, which looks a tool up and invokes it. Every gate this
 * server has is inside createToolChecker, and the sub-loop was on the other side of it: no permission
 * matrix, no GrantStore, no validator chain, no pathAcl, no dangerous-command list, no command gate,
 * not even the catastrophic hard-denies. Its own blacklist covers nine self-domain tools; shell, http,
 * writeFile, patch, process, downloadFile and deleteFile were all callable.
 *
 * The owner approved `planAndExecute(task="…")`. What ran was whatever a sub-model composed at
 * runtime. This pins the rule that replaces it: a sub-task may use what the turn already has, and
 * cannot reach past it — including for the things that are never grantable at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolRegistry,
  createToolChecker,
  AuditLog,
  GrantStore,
  createReadOnlyMatrix,
  createDefaultChain,
  createPathAclValidator,
  createDangerousCommandValidator,
  DEFAULT_DANGEROUS_PATTERNS,
} from '@agent/policy';
import { shellTool, httpTool, readFileTool } from '@agent/tools';

/** The same wiring the sub-loop runner builds, kept in one place so this tests that shape. */
function subLoopChecker(grants: GrantStore) {
  const registry = new ToolRegistry();
  registry.register(shellTool);
  registry.register(httpTool);
  registry.register(readFileTool);
  return createToolChecker({
    permissions: createReadOnlyMatrix(),
    audit: new AuditLog(),
    grantStore: grants,
    classifyTool: (name, params) => registry.classify(name, params),
    validatorChain: createDefaultChain({
      pathAcl: createPathAclValidator({}),
      dangerousCommands: createDangerousCommandValidator({ patterns: DEFAULT_DANGEROUS_PATTERNS }),
    }),
  });
}

const call = (toolName: string, params: Record<string, unknown>) => ({
  toolName,
  approval: 'never',
  params: JSON.stringify(params),
});

test('a sub-task cannot reach for a capability nobody granted', async () => {
  const check = subLoopChecker(new GrantStore());
  assert.ok(await check(call('shell', { command: 'lake env lean k13.lean' })), 'shell');
  assert.ok(await check(call('http', { url: 'https://api.example.com/x', method: 'POST' })), 'http POST');
});

test('reads still flow — a plan that only reads must not start failing', async () => {
  const check = subLoopChecker(new GrantStore());
  assert.equal(await check(call('readFile', { path: 'server/src/index.ts' })), null);
  assert.equal(await check(call('http', { url: 'https://example.com/doc' })), null);
});

test('what the turn already approved keeps working — this is the inheritance', async () => {
  const grants = new GrantStore();
  // The 2026-08-09 shape: shell approved at 06:58, planAndExecute run at 07:14 under that grant.
  grants.grant('shell', 'execute', 'local', 'owner approved this turn', 30 * 60_000);
  const check = subLoopChecker(grants);
  assert.equal(await check(call('shell', { command: 'lake env lean k13.lean' })), null);
});

test('inheriting a grant does not inherit the things a grant never covers', async () => {
  const grants = new GrantStore();
  grants.grant('shell', 'execute', 'local', 'owner approved this turn', 30 * 60_000);
  const check = subLoopChecker(grants);

  // Command-gated: publishing is its own decision, and a tool-scope grant is not it.
  const push = await check(call('shell', { command: 'git push origin main' }));
  assert.ok(push, 'git push must still be gated inside a sub-loop');

  // Hard-denied: no grant of any shape reaches these.
  const rm = await check(call('shell', { command: 'rm -rf /' }));
  assert.ok(rm, 'catastrophic patterns must still be refused');
  assert.match(rm!, /DANGEROUS_CMD|Dangerous/i);
});

test('path ACL applies to the sub-loop too', async () => {
  const grants = new GrantStore();
  grants.grant('readFile', 'read', 'local', 'owner approved this turn', 30 * 60_000);
  const check = subLoopChecker(grants);
  assert.ok(await check(call('readFile', { path: '/root/.ssh/id_ed25519' })), 'private key');
  assert.ok(await check(call('readFile', { path: '/srv/app/.env' })), '.env');
});

test('the pre-fix behaviour, kept so the regression is visible', async () => {
  // The bare registry: what the sub-loop used to run on. Nothing is consulted, so nothing is refused.
  const registry = new ToolRegistry();
  registry.register(shellTool);
  assert.ok(registry.get('shell'), 'the tool is simply there to be called');
  // There is no checker in this path at all — that is the whole finding; the assertion is the absence.
  assert.equal(typeof (registry as unknown as { check?: unknown }).check, 'undefined');
});
