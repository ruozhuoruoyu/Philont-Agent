/**
 * Per-server capability classification, environment isolation, and the MCP features beyond tools.
 *
 * Three separate holes are covered here:
 *   - one capability label for a whole server (a filesystem server's read_file and write_file cannot
 *     both be classified correctly by a single setting);
 *   - the child process inheriting philont's entire environment, API keys included, when an MCP server
 *     is typically a third-party package `npx` downloads at startup;
 *   - resources and prompts — two of MCP's three offerings — being unreachable, because only tools/*
 *     was ever mounted.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { buildChildEnv } from '../src/transport/stdio.js';
import { McpBridge } from '../src/bridge.js';

const VERSION = '2025-06-18';

function fakeServer(capabilities: Record<string, unknown>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string; params?: Record<string, unknown> };
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (payload: Record<string, unknown>) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      switch (msg.method) {
        case 'server/discover':
          return reply({ error: { code: -32601, message: 'Method not found' } });
        case 'initialize':
          return reply({ result: { protocolVersion: VERSION, capabilities, serverInfo: { name: 'fs-fake' } } });
        case 'tools/list':
          return reply({
            result: {
              tools: [
                { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } },
                { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} } },
                { name: 'delete_file', description: 'delete', inputSchema: { type: 'object', properties: {} } },
              ],
            },
          });
        case 'resources/list':
          return reply({ result: { resources: [{ uri: 'file:///notes.md', name: 'notes', description: 'my notes' }] } });
        case 'resources/read':
          return reply({ result: { contents: [{ uri: String(msg.params?.uri), mimeType: 'text/plain', text: 'resource body' }] } });
        case 'prompts/list':
          return reply({ result: { prompts: [{ name: 'summarize', description: 'summarize a doc' }] } });
        case 'prompts/get':
          return reply({ result: { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize this.' } }] } });
        default:
          return reply({ error: { code: -32601, message: 'Method not found' } });
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

describe('child process environment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    HTTPS_PROXY: 'http://proxy:8080',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    DEEPSEEK_API_KEY: 'sk-ds-secret',
    WECHAT_TOKEN: 'wx-secret',
  } as NodeJS.ProcessEnv;

  it('passes through the operational basics and nothing else', () => {
    const env = buildChildEnv({}, source);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API keys must not reach a third-party MCP server');
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.WECHAT_TOKEN, undefined);
  });

  it('honours explicit values and named passthroughs', () => {
    const env = buildChildEnv({ env: { SERVER_MODE: 'strict' }, inheritEnv: ['WECHAT_TOKEN'] }, source);
    assert.equal(env.SERVER_MODE, 'strict');
    assert.equal(env.WECHAT_TOKEN, 'wx-secret', 'an explicitly named variable is the operator\'s choice');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });
});

describe('per-tool classification and allowlist', () => {
  let ctx: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => { ctx = await fakeServer({ tools: {} }); });
  after(() => ctx.server.close());

  it('applies per-tool capability overrides on top of the server default', async () => {
    const bridge = new McpBridge({
      name: 'fs',
      transport: { transport: 'http', url: ctx.url },
      capability: 'read',
      toolCapabilities: { write_file: 'write', delete_file: 'execute' },
      timeout: 3000,
    });
    const tools = await bridge.connectAndDiscover();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.capability]));
    assert.equal(byName.fs_read_file, 'read');
    assert.equal(byName.fs_write_file, 'write');
    assert.equal(byName.fs_delete_file, 'execute');
    await bridge.close();
  });

  it('mounts only the allowlisted tools', async () => {
    const bridge = new McpBridge({
      name: 'fs',
      transport: { transport: 'http', url: ctx.url },
      toolAllowlist: ['read_file'],
      timeout: 3000,
    });
    const tools = await bridge.connectAndDiscover();
    assert.deepEqual(tools.map((t) => t.name), ['fs_read_file']);
    await bridge.close();
  });
});

describe('resources and prompts become callable tools', () => {
  let withCaps: Awaited<ReturnType<typeof fakeServer>>;
  let toolsOnly: Awaited<ReturnType<typeof fakeServer>>;
  before(async () => {
    withCaps = await fakeServer({ tools: {}, resources: {}, prompts: {} });
    toolsOnly = await fakeServer({ tools: {} });
  });
  after(() => { withCaps.server.close(); toolsOnly.server.close(); });

  it('mounts resource and prompt tools when the server declares those capabilities', async () => {
    const bridge = new McpBridge({ name: 'srv', transport: { transport: 'http', url: withCaps.url }, timeout: 3000 });
    const tools = await bridge.connectAndDiscover();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('srv_list_resources'));
    assert.ok(names.includes('srv_read_resource'));
    assert.ok(names.includes('srv_get_prompt'));

    const list = await tools.find((t) => t.name === 'srv_list_resources')!.execute({});
    assert.ok(list.output.includes('file:///notes.md'));

    const read = await tools.find((t) => t.name === 'srv_read_resource')!.execute({ uri: 'file:///notes.md' });
    assert.ok(read.output.includes('resource body'));

    const prompt = await tools.find((t) => t.name === 'srv_get_prompt')!.execute({ name: 'summarize' });
    assert.ok(prompt.output.includes('Summarize this.'));
    await bridge.close();
  });

  it('does not invent resource tools for a server that only offers tools', async () => {
    const bridge = new McpBridge({ name: 'srv', transport: { transport: 'http', url: toolsOnly.url }, timeout: 3000 });
    const names = (await bridge.connectAndDiscover()).map((t) => t.name);
    assert.ok(!names.some((n) => n.endsWith('_list_resources')));
    assert.ok(!names.some((n) => n.endsWith('_get_prompt')));
    await bridge.close();
  });
});
