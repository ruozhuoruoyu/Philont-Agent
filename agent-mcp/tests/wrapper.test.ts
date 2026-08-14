import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrapMcpTool, renderMcpContent, type McpToolDefinition } from '../src/wrapper.js';

// Mock transport
const mockTransport = {
  connected: true,
  async connect() {},
  async close() {},
  notify() {},
  on() { return this; },
  async request(method: string, params: unknown) {
    if (method === 'tools/call') {
      const p = params as { name: string; arguments: Record<string, unknown> };
      return {
        content: [{ type: 'text', text: `Mock result for ${p.name}: ${JSON.stringify(p.arguments)}` }],
      };
    }
    return {};
  },
} as any;

const mockErrorTransport = {
  connected: true,
  async connect() {},
  async close() {},
  notify() {},
  on() { return this; },
  async request() {
    return {
      content: [{ type: 'text', text: 'Something went wrong' }],
      isError: true,
    };
  },
} as any;

describe('wrapMcpTool', () => {
  const mcpTool: McpToolDefinition = {
    name: 'get_weather',
    description: 'Get weather for a city',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
      },
      required: ['city'],
    },
  };

  it('wraps MCP tool with correct name and prefix (下划线分隔,非点)', () => {
    const tool = wrapMcpTool(mcpTool, mockTransport, { prefix: 'weather' });
    // 必须用 '_' 分隔:LLM tool name 校验 ^[a-zA-Z0-9_-]+$,'.' 会被 API 400 拒。
    assert.equal(tool.name, 'weather_get_weather');
    assert.equal(tool.description, 'Get weather for a city');
    assert.equal(tool.capability, 'read');
    assert.equal(tool.domain, 'network');
  });

  it('合法化工具名:非法字符(含 .)→ _,结果匹配 LLM tool-name 约定', () => {
    const weird: McpToolDefinition = {
      name: 'browser.do-thing now!',
      description: 'x',
      inputSchema: { type: 'object', properties: {} },
    };
    const tool = wrapMcpTool(weird, mockTransport, { prefix: 'mcp.srv' });
    assert.match(tool.name, /^[a-zA-Z0-9_-]+$/);
    assert.equal(tool.name, 'mcp_srv_browser_do-thing_now_');
  });

  it('wraps without prefix when not specified', () => {
    const tool = wrapMcpTool(mcpTool, mockTransport);
    assert.equal(tool.name, 'get_weather');
  });

  it('executes tool via transport', async () => {
    const tool = wrapMcpTool(mcpTool, mockTransport, { prefix: 'w' });
    const result = await tool.execute({ city: 'Tokyo' });
    assert.equal(result.success, true);
    assert.ok(result.output.includes('Mock result for get_weather'));
    assert.ok(result.output.includes('Tokyo'));
  });

  it('handles MCP error response', async () => {
    const tool = wrapMcpTool(mcpTool, mockErrorTransport, { prefix: 'w' });
    const result = await tool.execute({ city: 'Mars' });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Something went wrong'));
  });

  it('handles transport exception', async () => {
    const failTransport = {
      async request() { throw new Error('Connection lost'); },
    } as any;
    const tool = wrapMcpTool(mcpTool, failTransport);
    const result = await tool.execute({ city: 'Tokyo' });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Connection lost'));
  });

  it('规范化 inputSchema:补 type:object、剥 $schema', () => {
    const weird: McpToolDefinition = {
      name: 'odd',
      description: 'x',
      // 缺 type、带 $schema(严格校验器爱拒)
      inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', properties: { a: { type: 'string' } } } as any,
    };
    const tool = wrapMcpTool(weird, mockTransport);
    const s = tool.schema as Record<string, unknown>;
    assert.equal(s.type, 'object');
    assert.equal(s.$schema, undefined);
    assert.deepEqual(s.properties, { a: { type: 'string' } });
  });

  it('inputSchema 缺失/非对象 → 安全默认 object', () => {
    const t1 = wrapMcpTool({ name: 'n', inputSchema: undefined as any }, mockTransport);
    assert.deepEqual(t1.schema, { type: 'object', properties: {} });
  });

  it('respects custom domain override', () => {
    const tool = wrapMcpTool(mcpTool, mockTransport, { domain: 'local' });
    assert.equal(tool.domain, 'local');
  });
});

describe('renderMcpContent — binary payloads never reach the context', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'philont-mcp-artifacts-'));
  const prevDownloadDir = process.env.PHILONT_DOWNLOAD_DIR;
  before(() => { process.env.PHILONT_DOWNLOAD_DIR = tmpRoot; });
  after(() => {
    if (prevDownloadDir === undefined) delete process.env.PHILONT_DOWNLOAD_DIR;
    else process.env.PHILONT_DOWNLOAD_DIR = prevDownloadDir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** A base64 payload big enough that inlining it would be obvious. */
  const bigB64 = Buffer.alloc(64 * 1024, 7).toString('base64');

  it('writes image content to disk and reports a path instead of base64', () => {
    const { text, artifacts } = renderMcpContent(
      [{ type: 'image', data: bigB64, mimeType: 'image/png' }],
      'browser_take_screenshot',
    );
    assert.equal(artifacts.length, 1);
    assert.ok(existsSync(artifacts[0]), 'artifact was written to disk');
    assert.match(artifacts[0], /\.png$/);
    assert.ok(text.includes(artifacts[0]));
    assert.ok(!text.includes(bigB64.slice(0, 64)), 'base64 payload must not appear in the text');
    assert.ok(text.length < 400, `reference should be short, got ${text.length} chars`);
  });

  it('keeps text content verbatim and joins mixed content', () => {
    const { text } = renderMcpContent(
      [
        { type: 'text', text: 'page loaded' },
        { type: 'image', data: bigB64, mimeType: 'image/png' },
        { type: 'resource_link', uri: 'file:///tmp/x.pdf', name: 'report' },
      ],
      'mixed',
    );
    assert.ok(text.startsWith('page loaded\n'));
    assert.ok(text.includes('[image saved to '));
    assert.ok(text.includes('resource_link file:///tmp/x.pdf'));
  });

  it('inlines an embedded text resource but saves an embedded blob', () => {
    const inline = renderMcpContent(
      [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } }],
      'res',
    );
    assert.ok(inline.text.includes('hello'));
    assert.equal(inline.artifacts.length, 0);

    const blob = renderMcpContent(
      [{ type: 'resource', resource: { uri: 'file:///a.bin', blob: bigB64, mimeType: 'application/pdf' } }],
      'res',
    );
    assert.equal(blob.artifacts.length, 1);
    assert.ok(!blob.text.includes(bigB64.slice(0, 64)));
  });

  it('describes unknown content types rather than dumping them', () => {
    const { text } = renderMcpContent([{ type: 'hologram', data: bigB64 } as never], 'weird');
    assert.ok(text.includes("unsupported MCP content type 'hologram'"));
    assert.ok(!text.includes(bigB64.slice(0, 64)));
  });

  it('execute(): an image-only result yields a path reference, not a base64 dump', async () => {
    const imageTransport = {
      async request() {
        return { content: [{ type: 'image', data: bigB64, mimeType: 'image/png' }] };
      },
    } as any;
    const tool = wrapMcpTool({ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }, imageTransport);
    const result = await tool.execute({});
    assert.equal(result.success, true);
    assert.ok(!result.output.includes(bigB64.slice(0, 64)), 'regression: base64 was dumped into the output');
    assert.match(result.output, /image saved to .*\.png/);
  });

  it('execute(): an unrecognised result shape is truncated, not pasted whole', async () => {
    const oddTransport = {
      async request() {
        return { weird: bigB64 }; // no content array at all
      },
    } as any;
    const tool = wrapMcpTool({ name: 'odd', inputSchema: { type: 'object', properties: {} } }, oddTransport);
    const result = await tool.execute({});
    assert.ok(result.output.length < 5000, `fallback must stay bounded, got ${result.output.length}`);
    assert.ok(result.output.includes('[truncated'));
  });
});
