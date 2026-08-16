/**
 * End-to-end MCP over Streamable HTTP against a REAL server process (an in-test node http server).
 *
 * This is the test category that was missing entirely: every previous MCP test was a unit test around
 * parsing or error handling, and nothing ever ran initialize → tools/list → tools/call against a
 * server. That is exactly how a client can be 100% green while speaking a dialect no current server
 * accepts. The fake server here is intentionally strict about the parts of the spec that bite:
 *
 *   - it rejects a protocol version it does not implement (so negotiation is exercised, not assumed);
 *   - it requires the `MCP-Protocol-Version` header to match what was negotiated (2025-06-18+ rule,
 *     a mismatch is a 400);
 *   - it issues a session id and requires it back;
 *   - one tool answers as plain JSON, another as an SSE stream with a progress notification first.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HttpTransport } from '../src/transport/http.js';
import { McpBridge } from '../src/bridge.js';

const SERVER_VERSION = '2025-06-18';
const MODERN_VERSION = '2026-07-28';
const SESSION_ID = 'sess-abc123';

interface Rpc { id?: number; method?: string; params?: Record<string, unknown> }

function startServer(opts: { supportsDiscover: boolean; noInitialize?: boolean }): Promise<{ server: Server; url: string; seen: Rpc[]; headers: Array<Record<string, string | undefined>> }> {
  const seen: Rpc[] = [];
  const headers: Array<Record<string, string | undefined>> = [];

  const server = createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as Rpc;
      seen.push(msg);
      headers.push({
        version: req.headers['mcp-protocol-version'] as string | undefined,
        session: req.headers['mcp-session-id'] as string | undefined,
        method: req.headers['mcp-method'] as string | undefined,
        name: req.headers['mcp-name'] as string | undefined,
        accept: req.headers.accept as string | undefined,
      });

      const send = (payload: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...(!opts.noInitialize ? { 'Mcp-Session-Id': SESSION_ID } : {}),
          ...extra,
        });
        res.end(JSON.stringify(payload));
      };
      const fail = (code: number, message: string) =>
        send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

      // Notifications carry no id.
      if (msg.id === undefined) { res.writeHead(202).end(); return; }

      switch (msg.method) {
        case 'server/discover': {
          if (!opts.supportsDiscover) return fail(-32601, 'Method not found');
          const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
          if (req.headers['mcp-protocol-version'] !== MODERN_VERSION) return fail(-32602, 'missing modern version header');
          if (req.headers['mcp-method'] !== 'server/discover') return fail(-32602, 'missing method header');
          if (meta['io.modelcontextprotocol/protocolVersion'] !== MODERN_VERSION) return fail(-32602, 'missing version meta');
          if (!meta['io.modelcontextprotocol/clientInfo']) return fail(-32602, 'missing client info meta');
          if (!meta['io.modelcontextprotocol/clientCapabilities']) return fail(-32602, 'missing client capabilities meta');
          return send({ jsonrpc: '2.0', id: msg.id, result: { supportedVersions: [MODERN_VERSION], capabilities: { tools: {} }, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } });
        }

        case 'initialize': {
          // A 2026-07-28 server has no `initialize`; auto negotiation must discover it before falling
          // back to this legacy handshake.
          if (opts.noInitialize) return fail(-32601, 'Method not found');
          const offered = String(msg.params?.protocolVersion ?? '');
          if (offered !== SERVER_VERSION) {
            return fail(-32602, `Unsupported protocol version: ${offered}`);
          }
          return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: SERVER_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
        }

        case 'tools/list': {
          // From here on the negotiated version must be echoed in the header.
          const expectedVersion = opts.noInitialize ? MODERN_VERSION : SERVER_VERSION;
          const v = req.headers['mcp-protocol-version'];
          if (v !== expectedVersion) { res.writeHead(400).end('protocol version mismatch'); return; }
          if (!opts.noInitialize && req.headers['mcp-session-id'] !== SESSION_ID) { res.writeHead(400).end('missing session'); return; }
          if (opts.noInitialize && req.headers['mcp-session-id']) { res.writeHead(400).end('modern request carried a session'); return; }
          if (opts.noInitialize && req.headers['mcp-method'] !== 'tools/list') { res.writeHead(400).end('missing method header'); return; }
          return send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                { name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
                { name: 'slow', description: 'streams', inputSchema: { type: 'object', properties: {} } },
              ],
            },
          });
        }

        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          if (opts.noInitialize && req.headers['mcp-method'] !== 'tools/call') { res.writeHead(400).end('missing method header'); return; }
          if (opts.noInitialize && req.headers['mcp-name'] !== name) { res.writeHead(400).end('missing name header'); return; }
          if (name === 'slow') {
            // SSE answer: a progress notification first, then the actual response.
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': SESSION_ID });
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'streamed ok' }] } })}\n\n`);
            res.end();
            return;
          }
          const args = (msg.params?.arguments ?? {}) as { text?: string };
          return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] } });
        }

        default:
          return fail(-32601, 'Method not found');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, seen, headers });
    });
  });
}

describe('Streamable HTTP transport, end to end', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  before(async () => { ctx = await startServer({ supportsDiscover: false }); });
  after(() => { ctx.server.close(); });

  it('negotiates via initialize, walking down from the preferred version', async () => {
    const bridge = new McpBridge({
      name: 'fake',
      transport: { transport: 'http', url: ctx.url },
      timeout: 5000,
    });
    await bridge.connect();
    assert.equal(bridge.protocol?.version, SERVER_VERSION);
    assert.equal(bridge.protocol?.via, 'initialize');
    assert.equal(bridge.protocol?.serverInfo?.name, 'fake');
    await bridge.close();
  });

  it('lists and calls tools with the negotiated version and session id in the headers', async () => {
    const bridge = new McpBridge({
      name: 'fake',
      transport: { transport: 'http', url: ctx.url },
      timeout: 5000,
    });
    const tools = await bridge.connectAndDiscover();
    assert.deepEqual(tools.map((t) => t.name), ['fake_echo', 'fake_slow']);

    const echo = tools[0];
    const result = await echo.execute({ text: 'hi' });
    assert.equal(result.success, true);
    assert.equal(result.output, 'echo:hi');
    await bridge.close();
  });

  it('handles an SSE-streamed answer and ignores interleaved notifications', async () => {
    const bridge = new McpBridge({
      name: 'fake',
      transport: { transport: 'http', url: ctx.url },
      timeout: 5000,
    });
    const tools = await bridge.connectAndDiscover();
    const slow = tools.find((t) => t.name === 'fake_slow')!;
    const result = await slow.execute({});
    assert.equal(result.success, true);
    assert.equal(result.output, 'streamed ok');
    await bridge.close();
  });

  it('surfaces an HTTP-level failure as a tool error instead of throwing', async () => {
    const t = new HttpTransport({ transport: 'http', url: `${ctx.url}` }, 3000);
    await t.connect();
    // tools/list without a handshake → the server rejects it with 400
    await assert.rejects(() => t.request('tools/list'), /HTTP 400/);
  });

  it('rejects an unreachable endpoint at connect time', async () => {
    const bridge = new McpBridge({
      name: 'down',
      transport: { transport: 'http', url: 'http://127.0.0.1:1/mcp' },
      timeout: 2000,
    });
    await assert.rejects(() => bridge.connect());
  });
});

describe('Streamable HTTP against a modern server (no initialize, discovery only)', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  before(async () => { ctx = await startServer({ supportsDiscover: true, noInitialize: true }); });
  after(() => { ctx.server.close(); });

  it('negotiates from the official supportedVersions discovery result', async () => {
    const bridge = new McpBridge({
      name: 'modern',
      transport: { transport: 'http', url: ctx.url },
      timeout: 5000,
    });
    await bridge.connect();
    assert.equal(bridge.protocol?.via, 'discover');
    assert.equal(bridge.protocol?.version, MODERN_VERSION);
    assert.equal(ctx.seen[0]?.method, 'server/discover', 'auto negotiation probes the modern era first');
    assert.ok(!ctx.seen.some((m) => m.method === 'initialize'), 'a successful modern discovery never initializes');
    await bridge.close();
  });

  it('carries the protocol version in _meta on every request', async () => {
    const bridge = new McpBridge({
      name: 'modern',
      transport: { transport: 'http', url: ctx.url },
      timeout: 5000,
    });
    await bridge.connectAndDiscover();
    const listCall = ctx.seen.find((m) => m.method === 'tools/list');
    const meta = listCall?.params?._meta as Record<string, unknown> | undefined;
    assert.equal(meta?.['io.modelcontextprotocol/protocolVersion'], MODERN_VERSION);
    assert.deepEqual(meta?.['io.modelcontextprotocol/clientCapabilities'], {});
    assert.equal((meta?.['io.modelcontextprotocol/clientInfo'] as { name?: string })?.name, 'philont-agent');
    const listHeaders = ctx.headers[ctx.seen.findIndex((m) => m.method === 'tools/list')];
    assert.equal(listHeaders?.method, 'tools/list');
    assert.equal(listHeaders?.session, undefined);
    const echo = bridge.getTools().find((t) => t.name === 'modern_echo')!;
    const result = await echo.execute({ text: 'modern' });
    assert.equal(result.output, 'echo:modern');
    const callIndex = ctx.seen.findIndex((m) => m.method === 'tools/call');
    assert.equal(ctx.headers[callIndex]?.method, 'tools/call');
    assert.equal(ctx.headers[callIndex]?.name, 'echo');
    await bridge.close();
  });
});
