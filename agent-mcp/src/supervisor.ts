/**
 * McpSupervisor — keeps mounted MCP servers honest about whether they are actually alive.
 *
 * The old wiring was a single fire-and-forget `connectMcpServers()` at module load: tools were pushed
 * into the registry once and never revisited. The stdio transport even emitted an `exit` event when the
 * child process died — nothing in the codebase subscribed to it. So when a server crashed (or was
 * never reachable to begin with) philont went on advertising its tools to the model forever, and every
 * call failed against a process that no longer existed. No reconnect, no removal, no visibility.
 *
 * What this adds:
 *   - mount/unmount callbacks, so the owner (the server's tool registry + toolDefs array) can add and
 *     REMOVE tools as connections come and go;
 *   - death detection for both kinds of transport: the stdio `exit` event, plus a periodic `tools/list`
 *     ping that also covers HTTP/SSE, where there is no process to watch;
 *   - reconnect with exponential backoff, so a server that comes back is picked up automatically;
 *   - a status snapshot for /api/mcp/status and the health report — "0 of 2 MCP servers connected" is
 *     the kind of thing that must be visible without reading logs.
 */

import { McpBridge } from './bridge.js';
import type { McpServerConfig } from './config.js';
import type { Tool } from '@agent/policy';

export type McpConnectionState = 'connecting' | 'connected' | 'retrying';

export interface McpServerStatus {
  name: string;
  state: McpConnectionState;
  /** Tool names currently mounted from this server. */
  tools: string[];
  /** Negotiated protocol revision, once connected. */
  protocolVersion?: string;
  /** How the version was established ('discover' | 'initialize' | 'assumed'). */
  protocolVia?: string;
  lastError?: string;
  /** Failed connection attempts since the last success. */
  failures: number;
  /** ms until the next reconnect attempt, when retrying. */
  retryInMs?: number;
}

export interface SupervisorOptions {
  /** Called when a server's tools become available. */
  onMount?: (server: string, tools: Tool[]) => void;
  /** Called when a server's tools must stop being offered (crash, health-check failure, shutdown). */
  onUnmount?: (server: string, toolNames: string[]) => void;
  /** How often to ping each connected server with tools/list. 0 disables. Default 60s. */
  healthIntervalMs?: number;
  /** First reconnect delay; doubles per failure up to maxBackoffMs. Default 2s. */
  baseBackoffMs?: number;
  /** Backoff ceiling. Default 5 minutes. */
  maxBackoffMs?: number;
  /** Log sink (defaults to console). */
  log?: (msg: string) => void;
}

interface Entry {
  config: McpServerConfig;
  bridge: McpBridge | null;
  state: McpConnectionState;
  tools: string[];
  failures: number;
  lastError?: string;
  timer?: ReturnType<typeof setTimeout>;
  nextAttemptAt?: number;
}

export class McpSupervisor {
  private entries: Entry[];
  private health?: ReturnType<typeof setInterval>;
  private stopped = false;
  private opts: Required<Pick<SupervisorOptions, 'healthIntervalMs' | 'baseBackoffMs' | 'maxBackoffMs'>> & SupervisorOptions;

  constructor(configs: McpServerConfig[], options: SupervisorOptions = {}) {
    this.opts = {
      healthIntervalMs: options.healthIntervalMs ?? 60_000,
      baseBackoffMs: options.baseBackoffMs ?? 2_000,
      maxBackoffMs: options.maxBackoffMs ?? 300_000,
      ...options,
    };
    this.entries = configs.map((config) => ({ config, bridge: null, state: 'connecting', tools: [], failures: 0 }));
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.log(m)))(`[mcp] ${msg}`);
  }

  /** Connect every configured server. Never rejects: a server that fails goes into the retry loop. */
  async start(): Promise<void> {
    await Promise.allSettled(this.entries.map((e) => this.connectEntry(e)));
    if (this.opts.healthIntervalMs > 0 && !this.health) {
      this.health = setInterval(() => void this.checkHealth(), this.opts.healthIntervalMs);
      this.health.unref?.();
    }
  }

  private async connectEntry(entry: Entry): Promise<void> {
    if (this.stopped) return;
    entry.state = 'connecting';
    const bridge = new McpBridge(entry.config);

    try {
      const tools = await bridge.connectAndDiscover();
      if (this.stopped) { await bridge.close().catch(() => {}); return; }

      entry.bridge = bridge;
      entry.tools = tools.map((t) => t.name);
      entry.state = 'connected';
      entry.failures = 0;
      entry.lastError = undefined;
      entry.nextAttemptAt = undefined;

      // A stdio server is a child process: its death is observable directly, no need to wait for a ping.
      bridge.onExit((reason) => this.handleLoss(entry, reason));
      // Servers may gain or lose tools while running and say so; take them up on it.
      bridge.onToolsChanged(() => void this.remount(entry));

      this.opts.onMount?.(entry.config.name, tools);
      this.log(`connected "${entry.config.name}" — ${tools.length} tools (protocol ${bridge.protocol?.version ?? 'unknown'} via ${bridge.protocol?.via ?? '?'})`);
    } catch (e) {
      entry.lastError = (e as Error)?.message ?? String(e);
      await bridge.close().catch(() => {});
      this.scheduleRetry(entry);
    }
  }

  /** The server announced a new tool list: swap the mounted set for the current one. */
  private async remount(entry: Entry): Promise<void> {
    if (entry.state !== 'connected' || !entry.bridge) return;
    try {
      const tools = await entry.bridge.rediscover();
      const previous = entry.tools;
      entry.tools = tools.map((t) => t.name);
      if (previous.length) this.opts.onUnmount?.(entry.config.name, previous);
      this.opts.onMount?.(entry.config.name, tools);
      this.log(`"${entry.config.name}" announced a tool list change — now ${tools.length} tool(s)`);
    } catch (e) {
      this.handleLoss(entry, `re-discovery failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** A connected server went away: drop its tools, then start the reconnect clock. */
  private handleLoss(entry: Entry, reason: string): void {
    if (entry.state !== 'connected') return;
    const names = entry.tools;
    entry.tools = [];
    entry.lastError = reason;
    const bridge = entry.bridge;
    entry.bridge = null;
    void bridge?.close().catch(() => {});
    if (names.length) this.opts.onUnmount?.(entry.config.name, names);
    this.log(`lost "${entry.config.name}" (${reason}); unmounted ${names.length} tool(s)`);
    this.scheduleRetry(entry);
  }

  private scheduleRetry(entry: Entry): void {
    if (this.stopped) return;
    entry.failures += 1;
    entry.state = 'retrying';
    const delay = Math.min(this.opts.baseBackoffMs * 2 ** (entry.failures - 1), this.opts.maxBackoffMs);
    entry.nextAttemptAt = Date.now() + delay;
    this.log(`"${entry.config.name}" unavailable (${entry.lastError ?? 'unknown'}); retrying in ${Math.round(delay / 1000)}s (attempt ${entry.failures})`);
    entry.timer = setTimeout(() => void this.connectEntry(entry), delay);
    entry.timer.unref?.();
  }

  /**
   * Ping every connected server. This is what covers HTTP/SSE, where there is no child process whose
   * exit we could watch — a remote server can disappear without any local signal at all.
   */
  async checkHealth(): Promise<void> {
    await Promise.allSettled(
      this.entries
        .filter((e) => e.state === 'connected' && e.bridge)
        .map(async (e) => {
          try {
            await e.bridge!.discover();
          } catch (err) {
            this.handleLoss(e, `health check failed: ${(err as Error)?.message ?? err}`);
          }
        }),
    );
  }

  status(): McpServerStatus[] {
    const now = Date.now();
    return this.entries.map((e) => ({
      name: e.config.name,
      state: e.state,
      tools: [...e.tools],
      protocolVersion: e.bridge?.protocol?.version,
      protocolVia: e.bridge?.protocol?.via,
      lastError: e.lastError,
      failures: e.failures,
      retryInMs: e.nextAttemptAt && e.nextAttemptAt > now ? e.nextAttemptAt - now : undefined,
    }));
  }

  /** One-line summary for the health report / boot log. */
  summary(): string {
    const total = this.entries.length;
    const up = this.entries.filter((e) => e.state === 'connected').length;
    const tools = this.entries.reduce((n, e) => n + e.tools.length, 0);
    const down = this.entries.filter((e) => e.state !== 'connected').map((e) => `${e.config.name}(${e.lastError ?? e.state})`);
    return `MCP: ${up}/${total} servers connected, ${tools} tools mounted${down.length ? `; down: ${down.join(', ')}` : ''}`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.health) { clearInterval(this.health); this.health = undefined; }
    for (const e of this.entries) {
      if (e.timer) clearTimeout(e.timer);
      if (e.tools.length) this.opts.onUnmount?.(e.config.name, e.tools);
      e.tools = [];
      await e.bridge?.close().catch(() => {});
      e.bridge = null;
    }
  }
}
