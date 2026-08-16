/**
 * McpBridge — connect to an MCP server, discover tools, register into ToolRegistry
 *
 * Analogous to Linux FUSE: mounts an external filesystem into the VFS layer.
 * McpBridge mounts tools from an external MCP server into philont's ToolRegistry.
 *
 * Lifecycle:
 *   1. connect()     — start the transport layer, send initialize
 *   2. discover()    — call tools/list to fetch the tool list
 *   3. registerAll() — wrap and register all tools into ToolRegistry
 *   4. close()       — disconnect and clean up resources
 */

import type { Tool } from '@agent/policy';
import { ToolRegistry } from '@agent/policy';
import { StdioTransport } from './transport/stdio.js';
import { SseTransport } from './transport/sse.js';
import { HttpTransport } from './transport/http.js';
import { wrapMcpTool, renderMcpContent, type McpToolDefinition } from './wrapper.js';
import type { McpServerConfig } from './config.js';
import {
  PREFERRED_INITIALIZE_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  isMethodNotFound,
  isUnsupportedVersionError,
  isModernProtocolVersion,
  MCP_CLIENT_INFO,
  type NegotiationResult,
  type ProtocolVersion,
} from './protocol.js';

type AnyTransport = StdioTransport | SseTransport | HttpTransport;

export class McpBridge {
  private transport: AnyTransport;
  private tools: Tool[] = [];
  private serverName: string;
  private config: McpServerConfig;
  private negotiation: NegotiationResult | null = null;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.serverName = config.name;

    const timeout = config.timeout || 30000;

    if (config.transport.transport === 'stdio') {
      this.transport = new StdioTransport(config.transport, timeout);
    } else if (config.transport.transport === 'http') {
      this.transport = new HttpTransport(config.transport, timeout);
    } else {
      this.transport = new SseTransport(config.transport, timeout);
    }
  }

  /** Which protocol revision this connection settled on, and how. Null until connect() succeeds. */
  get protocol(): NegotiationResult | null {
    return this.negotiation;
  }

  private applyVersion(version: ProtocolVersion | null): void {
    // Only the HTTP transport needs the header; _meta injection is handled per transport.
    (this.transport as { setProtocolVersion?: (v: ProtocolVersion | null) => void }).setProtocolVersion?.(version);
  }

  /**
   * Connect and agree on a protocol version.
   *
   * The old code sent `initialize` with a hardcoded `2024-11-05` and threw the server's answer away.
   * Now: try the modern discovery method first, fall back to an initialize handshake, adopt whatever
   * the server reports, and walk down the known revisions if it refuses ours outright.
   */
  async connect(): Promise<void> {
    await this.transport.connect();

    const pinned = this.config.protocolVersion;
    const modernPin = isModernProtocolVersion(pinned);

    // 1) Probe the modern era first. A 2026 server returns supportedVersions[]; a legacy server may
    // reject, time out, or complain that it has not been initialized, all of which mean "try legacy".
    // Set the candidate version before the probe because modern requests are self-describing.
    if (!pinned || modernPin) {
      const probeVersion = pinned ?? '2026-07-28';
      this.applyVersion(probeVersion);
      try {
        const discovered = (await this.transport.request('server/discover', {})) as {
          supportedVersions?: string[];
          capabilities?: Record<string, unknown>;
        } | null;
        const advertised = Array.isArray(discovered?.supportedVersions) ? discovered!.supportedVersions : [];
        const agreed = pinned
          ? (advertised.includes(pinned) ? pinned : null)
          : SUPPORTED_PROTOCOL_VERSIONS.find((v) => advertised.includes(v) && isModernProtocolVersion(v)) ?? null;
        if (!agreed) {
          throw new Error(
            pinned
              ? `server/discover did not advertise pinned protocol version ${pinned}`
              : `server/discover advertised no supported modern version (${advertised.join(', ') || 'none'})`,
          );
        }
        this.negotiation = { version: agreed, via: 'discover', capabilities: discovered?.capabilities };
        this.applyVersion(agreed);
        return;
      } catch (e) {
        if (modernPin) throw new Error(`MCP modern negotiation failed: ${(e as Error).message}`);
        this.applyVersion(null);
      }
    }

    // 2) Legacy initialize handshake, walking down revisions if the server rejects our offer.
    const offers: ProtocolVersion[] = pinned
      ? [pinned]
      : [
          PREFERRED_INITIALIZE_VERSION,
          ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v !== PREFERRED_INITIALIZE_VERSION && v !== '2026-07-28'),
        ];

    let lastErr: unknown = null;
    for (const offer of offers) {
      try {
        const result = (await this.transport.request('initialize', {
          protocolVersion: offer,
          capabilities: {},
          clientInfo: MCP_CLIENT_INFO,
        })) as {
          protocolVersion?: string;
          capabilities?: Record<string, unknown>;
          serverInfo?: { name?: string; version?: string };
        } | null;

        // Adopt the server's answer — that is the whole point of the handshake — unless pinned.
        const agreed = pinned || result?.protocolVersion || offer;
        this.negotiation = {
          version: agreed,
          via: pinned ? 'assumed' : 'initialize',
          capabilities: result?.capabilities,
          serverInfo: result?.serverInfo,
        };
        this.applyVersion(agreed);
        this.transport.notify('notifications/initialized');
        return;
      } catch (e) {
        lastErr = e;
        if (isMethodNotFound(e)) break;
        if (!isUnsupportedVersionError(e)) throw e; // a real failure, not a version disagreement
      }
    }

    throw new Error(
      `MCP handshake failed: server accepted none of ${offers.join(', ')}` +
        (lastErr instanceof Error ? ` (last error: ${lastErr.message})` : ''),
    );
  }

  private emitLog(msg: string): void {
    console.warn(`[mcp] ${this.serverName}: ${msg}`);
  }

  /** Discover all tools on the MCP server */
  async discover(): Promise<McpToolDefinition[]> {
    const result = await this.transport.request('tools/list') as {
      tools: McpToolDefinition[];
    };
    return result?.tools || [];
  }

  /** Wrap the server's tool definitions, applying the allowlist and per-tool capability overrides. */
  private wrapAll(mcpTools: McpToolDefinition[]): Tool[] {
    const prefix = this.config.toolPrefix ?? this.serverName;
    const allow = this.config.toolAllowlist;
    const perTool = this.config.toolCapabilities ?? {};

    return mcpTools
      .filter((t) => !allow || allow.includes(t.name))
      .map((t) =>
        wrapMcpTool(t, this.transport, {
          prefix,
          domain: this.config.domain || 'network',
          // Per-tool classification wins: one label for a whole server is either too strict (every
          // read needs approval, so approval becomes reflex) or too loose (writes wave through).
          capability: perTool[t.name] || this.config.capability || 'read',
        }),
      );
  }

  /**
   * Connect + discover + wrap all tools
   *
   * @returns List of wrapped philont Tools
   */
  async connectAndDiscover(): Promise<Tool[]> {
    await this.connect();
    this.tools = [...this.wrapAll(await this.discover()), ...(await this.buildResourceTools())];
    return this.tools;
  }

  /**
   * Expose the server's resources and prompts as ordinary philont tools.
   *
   * MCP has three things a server can offer; philont only ever mounted one of them. Resources (files,
   * database rows, docs the server can hand over) and prompts (server-authored templates) were simply
   * unreachable. Rather than inventing new plumbing, each becomes a normal tool the model can call.
   *
   * Deliberately NOT implemented here: sampling, roots and logging (all deprecated as of the 2026-07-28
   * revision — implementing them now would be building on a scheduled removal), and elicitation, which
   * needs a server→client request path this client does not have yet.
   */
  private async buildResourceTools(): Promise<Tool[]> {
    const caps = this.negotiation?.capabilities;
    const prefix = this.config.toolPrefix ?? this.serverName;
    const domain = this.config.domain || 'network';
    const out: Tool[] = [];

    // When the server never declared its capabilities, probe once rather than assume either way.
    const supports = async (cap: 'resources' | 'prompts', probe: () => Promise<unknown>): Promise<boolean> => {
      if (caps && typeof caps === 'object') return Boolean((caps as Record<string, unknown>)[cap]);
      try {
        await probe();
        return true;
      } catch {
        return false;
      }
    };

    if (await supports('resources', () => this.listResources())) {
      out.push(
        {
          name: `${prefix}_list_resources`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: `List the resources exposed by the "${this.serverName}" MCP server (uri + description).`,
          schema: { type: 'object', properties: {} },
          capability: 'read',
          domain,
          execute: async () => {
            try {
              const list = await this.listResources();
              if (!list.length) return { success: true, output: `No resources exposed by "${this.serverName}".` };
              return {
                success: true,
                output: list
                  .map((r) => `• ${r.uri}${r.name ? ` (${r.name})` : ''}${r.description ? ` — ${r.description}` : ''}`)
                  .join('\n'),
              };
            } catch (e) {
              return { success: false, output: '', error: `resources/list failed: ${(e as Error).message}` };
            }
          },
        },
        {
          name: `${prefix}_read_resource`.replace(/[^a-zA-Z0-9_-]/g, '_'),
          description: `Read one resource from the "${this.serverName}" MCP server by uri (see ${prefix}_list_resources).`,
          schema: {
            type: 'object',
            properties: { uri: { type: 'string', description: 'Resource URI as returned by list_resources.' } },
            required: ['uri'],
          },
          capability: 'read',
          domain,
          execute: async (params: Record<string, unknown>) => {
            try {
              const contents = await this.readResource(String(params.uri ?? ''));
              // Binary contents are written to disk instead of inlined — same rule as tool results.
              const { text } = renderMcpContent(
                contents.map((c) => ({ type: 'resource', resource: c })),
                `${this.serverName}_resource`,
              );
              return { success: true, output: text || '(empty resource)' };
            } catch (e) {
              return { success: false, output: '', error: `resources/read failed: ${(e as Error).message}` };
            }
          },
        },
      );
    }

    if (await supports('prompts', () => this.listPrompts())) {
      out.push({
        name: `${prefix}_get_prompt`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description:
          `Fetch a prompt template from the "${this.serverName}" MCP server. Omit "name" to list the ` +
          `available templates.`,
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Prompt name; omit to list what is available.' },
            arguments: { type: 'object', description: 'Template arguments.' },
          },
        },
        capability: 'read',
        domain,
        execute: async (params: Record<string, unknown>) => {
          try {
            if (!params.name) {
              const list = await this.listPrompts();
              return {
                success: true,
                output: list.length
                  ? list.map((p) => `• ${p.name}${p.description ? ` — ${p.description}` : ''}`).join('\n')
                  : `No prompts exposed by "${this.serverName}".`,
              };
            }
            const result = (await this.getPrompt(
              String(params.name),
              (params.arguments as Record<string, unknown>) ?? {},
            )) as { messages?: Array<{ role?: string; content?: unknown }> } | null;
            const messages = result?.messages ?? [];
            const rendered = messages
              .map((m) => {
                const c = m.content as { type?: string; text?: string } | undefined;
                return `[${m.role ?? 'user'}] ${c?.text ?? JSON.stringify(c ?? '').slice(0, 500)}`;
              })
              .join('\n');
            return { success: true, output: rendered || JSON.stringify(result ?? null).slice(0, 2000) };
          } catch (e) {
            return { success: false, output: '', error: `prompts failed: ${(e as Error).message}` };
          }
        },
      });
    }

    return out;
  }

  /** Re-run discovery and re-wrap (used after notifications/tools/list_changed). */
  async rediscover(): Promise<Tool[]> {
    // Resource/prompt tools have to be rebuilt too. Returning only the tools/* set here meant a single
    // list_changed notification permanently deleted this server's resource and prompt tools: the
    // supervisor unmounts the previous set and mounts what it is handed.
    this.tools = [...this.wrapAll(await this.discover()), ...(await this.buildResourceTools())];
    return this.tools;
  }

  /**
   * Subscribe to the server announcing that its tool list changed (`notifications/tools/list_changed`).
   *
   * Servers are allowed to gain and lose tools at runtime — philont held whatever list it saw at
   * connect time forever, so a server that added a tool later was simply never offering it.
   */
  onToolsChanged(cb: () => void): void {
    const t = this.transport as unknown as { on?: (ev: string, fn: (arg: unknown) => void) => void };
    if (typeof t.on !== 'function') return;
    t.on('notification', (msg: unknown) => {
      const method = (msg as { method?: string } | null)?.method;
      if (method === 'notifications/tools/list_changed') cb();
    });
  }

  /** List resources the server exposes (MCP `resources/list`). Empty when unsupported. */
  async listResources(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>> {
    const res = (await this.transport.request('resources/list', {})) as {
      resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
    } | null;
    return res?.resources ?? [];
  }

  /** Read one resource (MCP `resources/read`). */
  async readResource(uri: string): Promise<Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>> {
    const res = (await this.transport.request('resources/read', { uri })) as {
      contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
    } | null;
    return res?.contents ?? [];
  }

  /** List prompt templates the server exposes (MCP `prompts/list`). Empty when unsupported. */
  async listPrompts(): Promise<Array<{ name: string; description?: string; arguments?: unknown }>> {
    const res = (await this.transport.request('prompts/list', {})) as {
      prompts?: Array<{ name: string; description?: string; arguments?: unknown }>;
    } | null;
    return res?.prompts ?? [];
  }

  /** Fetch one prompt template, rendered with arguments (MCP `prompts/get`). */
  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.transport.request('prompts/get', { name, arguments: args ?? {} });
  }

  /**
   * Connect + discover + register into ToolRegistry
   */
  async registerAll(registry: ToolRegistry): Promise<Tool[]> {
    const tools = await this.connectAndDiscover();
    for (const tool of tools) {
      registry.register(tool);
    }
    return tools;
  }

  /**
   * Subscribe to the server going away.
   *
   * The stdio transport has always emitted 'exit' when its child process died; nothing listened, so a
   * crashed MCP server kept its tools advertised forever. The supervisor uses this to unmount them.
   * Transports without a process (HTTP) never fire it — they are covered by the health ping instead.
   */
  onExit(cb: (reason: string) => void): void {
    const t = this.transport as unknown as { on?: (ev: string, fn: (arg: unknown) => void) => void };
    if (typeof t.on !== 'function') return;
    t.on('exit', (code: unknown) => cb(`server process exited (code ${code ?? 'null'})`));
  }

  /** Get the discovered tools */
  getTools(): Tool[] {
    return this.tools;
  }

  /** Server name */
  get name(): string {
    return this.serverName;
  }

  /** Whether connected */
  get connected(): boolean {
    return this.transport.connected;
  }

  /** Close the connection */
  async close(): Promise<void> {
    await this.transport.close();
    this.tools = [];
  }
}

/**
 * Bulk-connect multiple MCP servers
 *
 * Connects to all servers in parallel; a failure on one server does not affect others.
 * Returns all successfully connected bridge instances.
 */
export async function connectMcpServers(
  configs: McpServerConfig[],
  registry?: ToolRegistry,
): Promise<McpBridge[]> {
  const bridges: McpBridge[] = [];

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      const bridge = new McpBridge(config);
      if (registry) {
        await bridge.registerAll(registry);
      } else {
        await bridge.connectAndDiscover();
      }
      return bridge;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      bridges.push(result.value);
      const toolCount = result.value.getTools().length;
      console.log(`[mcp] Connected to "${configs[i].name}" — ${toolCount} tools`);
    } else {
      console.error(`[mcp] Failed to connect to "${configs[i].name}":`, result.reason);
    }
  }

  return bridges;
}

/**
 * Close all MCP bridges
 */
export async function closeMcpBridges(bridges: McpBridge[]): Promise<void> {
  await Promise.allSettled(bridges.map((b) => b.close()));
}
