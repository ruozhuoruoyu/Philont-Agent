/**
 * Regressions in the mount bookkeeping, all of the same kind: the supervisor and its owner disagreeing
 * about what is mounted, or a reconnect silently losing capability.
 *
 *  - name collision: the owner skips a tool whose name is already taken, but the supervisor booked the
 *    server's full list — so unmounting the loser deleted the WINNER's tool, and the winner never
 *    remounts because it never disconnected;
 *  - pinned protocol version: pinning used to skip the handshake entirely, and a conforming pre-2026
 *    server refuses every call until it is initialized — the escape hatch broke exactly where it was
 *    needed;
 *  - list_changed: re-discovery returned only tools/*, so a server announcing a tool change
 *    permanently dropped its resource and prompt tools.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { McpBridge } from '../src/bridge.js';
import { McpSupervisor } from '../src/supervisor.js';

const VERSION = '2025-06-18';

interface ServerOpts {
  /** Tool names the server offers (changes take effect on the next tools/list). */
  tools: () => string[];
  capabilities?: Record<string, unknown>;
  /** Refuse everything before initialize, the way a conforming server does. */
  strictInit?: boolean;
}

function fakeServer(opts: ServerOpts): Promise<{ server: Server; url: string }> {
  let initialized = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      if (msg.method === 'initialize') {
        initialized = true;
        return reply({ result: { protocolVersion: VERSION, capabilities: opts.capabilities ?? { tools: {} }, serverInfo: { name: 'fake' } } });
      }
      if (opts.strictInit && !initialized) {
        return reply({ error: { code: -32002, message: 'Server not initialized' } });
      }
      switch (msg.method) {
        case 'server/discover':
          return reply({ error: { code: -32601, message: 'Method not found' } });
        case 'tools/list':
          return reply({
            result: {
              tools: opts.tools().map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
            },
          });
        case 'resources/list':
          return reply({ result: { resources: [{ uri: 'file:///a.md', name: 'a' }] } });
        case 'prompts/list':
          return reply({ result: { prompts: [{ name: 'p' }] } });
        default:
          return reply({ result: { content: [{ type: 'text', text: 'ok' }] } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

describe('mount bookkeeping under name collisions', () => {
  let a: Awaited<ReturnType<typeof fakeServer>>;
  let b: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => {
    a = await fakeServer({ tools: () => ['ping'] });
    b = await fakeServer({ tools: () => ['ping'] });
  });
  after(() => { a.server.close(); b.server.close(); });

  it("a dying server does not take another server's identically named tool with it", async () => {
    // Both servers use the same prefix, so both produce a tool called dup_ping — the owner keeps the
    // first and skips the second, exactly as chat-handler does.
    const mounted = new Map<string, string>(); // toolName -> owning server
    const sup = new McpSupervisor(
      [
        { name: 'a', toolPrefix: 'dup', transport: { transport: 'http', url: a.url }, timeout: 3000 },
        { name: 'b', toolPrefix: 'dup', transport: { transport: 'http', url: b.url }, timeout: 3000 },
      ],
      {
        onMount: (server, tools) => {
          const accepted: string[] = [];
          for (const t of tools) {
            if (mounted.has(t.name)) continue; // taken by someone else
            mounted.set(t.name, server);
            accepted.push(t.name);
          }
          return accepted;
        },
        onUnmount: (_server, names) => { for (const n of names) mounted.delete(n); },
        healthIntervalMs: 0,
        baseBackoffMs: 10_000, // no reconnect during the test
        log: () => {},
      },
    );

    await sup.start();
    assert.equal(mounted.size, 1, 'only one dup_ping can be mounted');
    const owner = mounted.get('dup_ping');
    const loser = owner === 'a' ? 'b' : 'a';

    // The server that lost the name goes away.
    const loserEntry = sup.status().find((s) => s.name === loser)!;
    assert.deepEqual(loserEntry.tools, [], 'the loser must not book a tool it never mounted');

    (loser === 'a' ? a : b).server.close();
    await sup.checkHealth();

    assert.equal(mounted.get('dup_ping'), owner, "the winner's tool must survive the loser's death");
    await sup.stop();
  });
});

describe('pinned protocol version', () => {
  let ctx: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => { ctx = await fakeServer({ tools: () => ['ping'], strictInit: true }); });
  after(() => ctx.server.close());

  it('still performs the handshake (a conforming server refuses everything before initialize)', async () => {
    const bridge = new McpBridge({
      name: 'pinned',
      transport: { transport: 'http', url: ctx.url },
      protocolVersion: VERSION,
      timeout: 3000,
    });
    const tools = await bridge.connectAndDiscover();
    assert.deepEqual(tools.map((t) => t.name), ['pinned_ping']);
    assert.equal(bridge.protocol?.version, VERSION);
    assert.equal(bridge.protocol?.via, 'assumed');
    await bridge.close();
  });

  it('works without a pin against the same strict server', async () => {
    const bridge = new McpBridge({ name: 'auto', transport: { transport: 'http', url: ctx.url }, timeout: 3000 });
    const tools = await bridge.connectAndDiscover();
    assert.equal(tools.length, 1);
    assert.equal(bridge.protocol?.via, 'initialize');
    await bridge.close();
  });
});

describe('re-discovery after tools/list_changed', () => {
  let ctx: Awaited<ReturnType<typeof fakeServer>>;
  let names = ['ping'];
  before(async () => {
    ctx = await fakeServer({ tools: () => names, capabilities: { tools: {}, resources: {}, prompts: {} } });
  });
  after(() => ctx.server.close());

  it('keeps the resource and prompt tools instead of dropping them', async () => {
    const bridge = new McpBridge({ name: 'srv', transport: { transport: 'http', url: ctx.url }, timeout: 3000 });
    const first = (await bridge.connectAndDiscover()).map((t) => t.name);
    assert.ok(first.includes('srv_list_resources'));
    assert.ok(first.includes('srv_get_prompt'));

    names = ['ping', 'pong'];
    const second = (await bridge.rediscover()).map((t) => t.name);
    assert.ok(second.includes('srv_pong'), 'the new tool shows up');
    assert.ok(second.includes('srv_list_resources'), 'resource tools must not vanish on re-discovery');
    assert.ok(second.includes('srv_read_resource'));
    assert.ok(second.includes('srv_get_prompt'));
    await bridge.close();
  });
});
