/**
 * Supervisor: a dead MCP server must stop being advertised, and a returning one must come back.
 *
 * The regression this pins: philont mounted MCP tools once at startup and never revisited them. The
 * stdio transport emitted 'exit' when its child died and nobody subscribed, so the model kept being
 * offered tools belonging to a process that no longer existed — every call failed, forever, with no
 * log line saying why. Two paths are covered here because they fail differently:
 *   - stdio: the child process exits (observable immediately);
 *   - http: the remote endpoint stops answering (only observable by pinging it).
 */

import { describe, it, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSupervisor } from '../src/supervisor.js';

const VERSION = '2025-06-18';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond` holds or the deadline passes (keeps the tests off fixed sleeps). */
async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

/** A fake Streamable HTTP MCP server whose health can be toggled at will. */
function fakeHttpServer(): Promise<{ server: Server; url: string; setAlive: (v: boolean) => void }> {
  let alive = true;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      if (!alive) { res.writeHead(503).end('server is down'); return; }
      const send = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'server/discover') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
        return;
      }
      if (msg.method === 'initialize') return send({ protocolVersion: VERSION, capabilities: {}, serverInfo: { name: 'fake' } });
      if (msg.method === 'tools/list') return send({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
      return send({ content: [{ type: 'text', text: 'ok' }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, setAlive: (v: boolean) => { alive = v; } });
    });
  });
}

describe('supervisor: http server that stops answering', () => {
  let ctx: Awaited<ReturnType<typeof fakeHttpServer>>;
  before(async () => { ctx = await fakeHttpServer(); });
  after(() => { ctx.server.close(); });

  it('mounts, unmounts on a failed health check, and remounts when the server returns', async () => {
    const mounted: string[] = [];
    const unmounted: string[] = [];
    const sup = new McpSupervisor(
      [{ name: 'remote', transport: { transport: 'http', url: ctx.url }, timeout: 2000 }],
      {
        onMount: (_s, tools) => {
          const names = tools.map((t) => t.name);
          mounted.push(...names);
          return names; // the owner reports what it actually accepted
        },
        onUnmount: (_s, names) => unmounted.push(...names),
        healthIntervalMs: 0, // driven manually below, so the test is deterministic
        baseBackoffMs: 50,
        log: () => {},
      },
    );

    await sup.start();
    assert.deepEqual(mounted, ['remote_ping']);
    assert.equal(sup.status()[0].state, 'connected');
    assert.equal(sup.status()[0].protocolVersion, VERSION);

    // The remote goes away. Nothing local changes — only a ping can notice.
    ctx.setAlive(false);
    await sup.checkHealth();

    assert.deepEqual(unmounted, ['remote_ping'], 'tools of a dead server must be withdrawn');
    assert.equal(sup.status()[0].state, 'retrying');
    assert.deepEqual(sup.status()[0].tools, []);
    assert.match(sup.summary(), /0\/1 servers connected/);

    // …and when it comes back, the backoff retry picks it up without a restart.
    ctx.setAlive(true);
    await until(() => sup.status()[0].state === 'connected');
    assert.equal(mounted.length, 2, 'tools should be mounted again after recovery');
    assert.match(sup.summary(), /1\/1 servers connected/);

    await sup.stop();
  });
});

describe('supervisor: stdio server that dies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'philont-mcp-stdio-'));
  const script = join(dir, 'server.mjs');
  after(() => rmSync(dir, { recursive: true, force: true }));

  before(() => {
    // Minimal MCP-over-stdio server that answers the handshake, then exits on demand.
    writeFileSync(
      script,
      `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'server/discover') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n');
    } else if (msg.method === 'initialize') {
      send({ protocolVersion: '${VERSION}', capabilities: {}, serverInfo: { name: 'stdio-fake' } });
    } else if (msg.method === 'tools/list') {
      send({ tools: [{ name: 'noop', description: 'noop', inputSchema: { type: 'object', properties: {} } }] });
    } else {
      send({ content: [{ type: 'text', text: 'ok' }] });
    }
  }
});

// die shortly after startup, the way a crashing MCP server would
setTimeout(() => process.exit(3), 3000);
`,
      'utf-8',
    );
  });

  it('unmounts the tools when the child process exits', async () => {
    const unmounted: string[] = [];
    const sup = new McpSupervisor(
      [{ name: 'local', transport: { transport: 'stdio', command: process.execPath, args: [script] }, timeout: 3000 }],
      {
        onUnmount: (_s, names) => unmounted.push(...names),
        healthIntervalMs: 0,
        baseBackoffMs: 50,
        maxBackoffMs: 100,
        log: () => {},
      },
    );

    await sup.start();
    assert.equal(sup.status()[0].state, 'connected');
    assert.deepEqual(sup.status()[0].tools, ['local_noop']);

    // No ping involved: the process exit itself must trigger the unmount.
    await until(() => unmounted.length > 0, 5000);
    assert.deepEqual(unmounted, ['local_noop']);
    assert.equal(sup.status()[0].state, 'retrying');
    assert.match(String(sup.status()[0].lastError), /exited/);

    await sup.stop();
  });
});

test('invalid MCP configuration is permanently failed instead of retried forever', async () => {
  const logs: string[] = [];
  const sup = new McpSupervisor(
    [{ name: 'invalid', transport: { transport: 'http', url: 'not a URL' } }],
    { healthIntervalMs: 0, baseBackoffMs: 10, log: (line) => logs.push(line) },
  );
  await sup.start();
  const status = sup.status()[0];
  assert.equal(status.state, 'failed');
  assert.equal(status.retryInMs, undefined);
  assert.equal(status.failures, 1);
  assert.match(status.lastError ?? '', /Invalid MCP http URL/);
  assert.ok(logs.some((line) => /disabled: invalid configuration/.test(line)));
  await sleep(30);
  assert.equal(sup.status()[0].failures, 1, 'a permanent configuration error must not schedule another attempt');
  await sup.stop();
});
