/**
 * stdio transport layer — communicates with an MCP server via child-process stdin/stdout
 *
 * Uses the JSON-RPC 2.0 protocol (MCP standard)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { McpConfigurationError, type McpStdioConfig } from '../config.js';
import { withProtocolMeta, type ProtocolVersion } from '../protocol.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Variables an MCP server process legitimately needs, and nothing else.
 *
 * Everything under here exists because the previous code did `{ ...process.env, ...config.env }`: a
 * third-party package pulled by `npx` at startup received philont's entire environment — LLM API keys,
 * channel credentials, database paths. An MCP server is exactly the kind of dependency that gets
 * compromised upstream, and there is no reason a weather server should be able to read
 * ANTHROPIC_API_KEY. A server that truly needs a variable gets it via `env` or `inheritEnv`.
 */
const BASE_ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec',
  'LANG', 'LC_ALL', 'TZ',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'npm_config_registry', 'npm_config_cache',
];

/** Build the child process environment: safe base + explicitly allowed passthroughs + explicit values. */
export function buildChildEnv(
  config: Pick<McpStdioConfig, 'env' | 'inheritEnv'>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_ENV_KEYS, ...(config.inheritEnv ?? [])]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, ...(config.env ?? {}) };
}

function quoteWindowsCmdArg(value: string): string {
  // cmd.exe has no trustworthy argv boundary for an embedded quote/newline. Fail closed instead
  // of turning an operator-controlled MCP config into a command-injection boundary.
  if (/["\r\n]/.test(value)) throw new McpConfigurationError('Unsafe quote/newline in Windows MCP command argument');
  // Keep ordinary flags/package names bare. When the whole `/c` payload is itself passed as one argv,
  // Node's Windows quoting can otherwise turn `"-y"` into a literal quote-bearing npm argument
  // (prod 2026-08-24: npm EINVALIDTAGNAME for tag `"-y"`).
  if (/^[A-Za-z0-9_@.+:\\/-]+$/.test(value) && !value.includes('%')) return value;
  return `"${value.replace(/%/g, '%%')}"`;
}

/** Explicit executable/argv pair; avoids Node's deprecated and unsafe `shell:true` concatenation. */
export function buildStdioSpawnSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command, args };
  // `cmd /s /c ""command" "arg""` has a special first/last-quote grammar. Passing that nested form
  // through Node's CreateProcess quoting caused the command to start and immediately exit on Windows
  // (prod 2026-08-24: Playwright MCP became `MCP server not connected` right after this wrapper landed).
  // A bare PATH command must stay bare: `call "npx"` is parsed by some cmd.exe versions as a literal
  // command named `"npx"` (prod 2026-08-24). cmd resolves npx.cmd itself. Only a command path that needs
  // quoting uses CALL; CALL is required there so a quoted .cmd path is not mistaken for /c's wrapper quote.
  const safeBareCommand = /^[A-Za-z0-9_@.+:\\/-]+$/.test(command) && !command.includes('%');
  const commandHead = safeBareCommand ? command : `call ${quoteWindowsCmdArg(command)}`;
  const commandLine = [commandHead, ...args.map(quoteWindowsCmdArg)].join(' ');
  return { command: comspec, args: ['/d', '/v:off', '/s', '/c', commandLine] };
}

export class StdioTransport extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private protocolVersion: ProtocolVersion | null = null;
  private lastProcessError: string | null = null;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private config: McpStdioConfig,
    private timeout = 30000,
  ) {
    super();
  }

  /** Start the child process */
  async connect(): Promise<void> {
    this.lastProcessError = null;
    const env = buildChildEnv(this.config);
    const spec = buildStdioSpawnSpec(this.config.command, this.config.args || []);
    const proc = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
      // The final /c payload is already cmd-escaped above. Do not let Node quote it a second time.
      windowsVerbatimArguments: process.platform === 'win32',
    });
    this.proc = proc;
    let stderrTail = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // MCP server's stderr is used for logging
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      this.emit('log', text);
    });

    proc.on('exit', (code, signal) => {
      const detail = stderrTail.trim().replace(/\s+/g, ' ').slice(0, 800);
      this.lastProcessError =
        `MCP stdio child exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})` +
        (detail ? `: ${detail}` : '');
      this.emit('exit', code);
      // Reject all pending requests
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Critical robustness: child process spawn failures (command not found = ENOENT,
    // common with npx on Windows) and runtime errors both emit an 'error' event on the
    // ChildProcess. **Must be listened to**, otherwise Node treats it as an unhandled
    // 'error' event and throws, crashing the host process — a failing external MCP server
    // must never bring down the whole server.
    //
    // Use a promise to distinguish: 'spawn' = started successfully; 'error' = startup
    // failed → reject, caught by connectMcpServers' allSettled (gracefully degraded to
    // "this server failed to connect").
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (readyTimer) clearTimeout(readyTimer);
        reject(err);
      };
      const onSpawnError = (err: Error) => finishReject(err);
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = stderrTail.trim().replace(/\s+/g, ' ').slice(0, 800);
        finishReject(new Error(
          `MCP stdio child exited before initialization (code=${code ?? 'null'}, signal=${signal ?? 'none'})` +
            (detail ? `: ${detail}` : ''),
        ));
      };
      proc.once('error', onSpawnError);
      proc.once('exit', onEarlyExit);
      proc.once('spawn', () => {
        proc.removeListener('error', onSpawnError);
        // After startup, attach a persistent error handler: late runtime errors only reject pending requests, no longer crash.
        proc.on('error', (err: Error) => {
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.pending.clear();
        });
        // Give the server a moment to be ready, but never report connected if it exits during that window.
        readyTimer = setTimeout(() => {
          if (settled) return;
          if (proc.exitCode !== null || !proc.stdin?.writable) {
            onEarlyExit(proc.exitCode, proc.signalCode);
            return;
          }
          settled = true;
          proc.removeListener('exit', onEarlyExit);
          resolve();
        }, 100);
      });
    });
  }

  /** Adopt the negotiated protocol version (see protocol.ts); attached to every later request. */
  setProtocolVersion(version: ProtocolVersion | null): void {
    this.protocolVersion = version;
  }

  /** Send a JSON-RPC request and wait for its response */
  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) {
      throw new Error(this.lastProcessError ?? 'MCP server not connected');
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: withProtocolMeta(params, this.protocolVersion),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method} (${this.timeout}ms)`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });

      const line = JSON.stringify(msg) + '\n';
      this.proc!.stdin!.write(line);
    });
  }

  /** Send a notification (no response needed) */
  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    const msg = { jsonrpc: '2.0', method, params: withProtocolMeta(params, this.protocolVersion) };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Close the connection */
  async close(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      // Allow 1 second for graceful exit
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.proc?.kill('SIGKILL');
          resolve();
        }, 1000);
        this.proc!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.proc = null;
    }
  }

  get connected(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  private processBuffer(): void {
    // MCP uses newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Retain the potentially incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);

          if (msg.error) {
            p.reject(new Error(`MCP error: ${msg.error.message} (code ${msg.error.code})`));
          } else {
            p.resolve(msg.result);
          }
        } else if (!('id' in msg)) {
          // Notification (server → client)
          this.emit('notification', msg);
        }
      } catch {
        // Non-JSON line, ignore (may be a log line)
      }
    }
  }
}
