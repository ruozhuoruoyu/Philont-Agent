/**
 * MCP server configuration types
 */

/** stdio transport configuration */
export interface McpStdioConfig {
  transport: 'stdio';
  /** Start command */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables handed to the server process (added on top of the safe base set). */
  env?: Record<string, string>;
  /**
   * Extra variable names to pass through from philont's own environment.
   *
   * The child process used to inherit the WHOLE of `process.env` — every LLM API key, every channel
   * credential — and an MCP server is typically a third-party package fetched by `npx` at startup.
   * Now only a small base set (PATH/HOME/TMP/proxy/locale) is inherited; anything else a server
   * genuinely needs is named here or set explicitly in `env`.
   */
  inheritEnv?: string[];
}

/**
 * SSE transport configuration.
 *
 * This is the ORIGINAL HTTP+SSE transport (2024-11-05), deprecated by Streamable HTTP in 2025-03-26.
 * Kept for servers that still only speak it; use `transport: 'http'` for anything current.
 */
export interface McpSseConfig {
  transport: 'sse';
  /** SSE endpoint URL */
  url: string;
  /** Request headers */
  headers?: Record<string, string>;
}

/** Streamable HTTP transport configuration (MCP 2025-03-26+) — the current remote transport. */
export interface McpHttpConfig {
  transport: 'http';
  /** The single MCP endpoint URL (all messages are POSTed here). */
  url: string;
  /** Request headers, e.g. Authorization for a hosted server. */
  headers?: Record<string, string>;
}

/** Individual MCP server configuration */
export interface McpServerConfig {
  /** Server name (used for logging and tool name prefix) */
  name: string;
  /** Transport configuration */
  transport: McpStdioConfig | McpSseConfig | McpHttpConfig;
  /**
   * Pin the MCP protocol version instead of negotiating it (see protocol.ts). Rarely needed — set it
   * only when a server misreports what it speaks.
   */
  protocolVersion?: string;
  /** Tool call timeout (ms), default 30000 */
  timeout?: number;
  /** Tool name prefix (to avoid collisions), defaults to name */
  toolPrefix?: string;
  /** Permission domain classification override, default 'network' */
  domain?: 'local' | 'network' | 'system';
  /**
   * Capability classification override, default 'read'.
   *
   * Important (security): philont's read-only matrix **auto-allows** read+network.
   * Browser automation servers (navigate/click/type/submit have side effects on
   * live sites) should be explicitly marked 'execute', so the first call triggers
   * onAuthRequest for user approval instead of silently passing through.
   */
  capability?: 'read' | 'write' | 'execute';
  /**
   * Per-tool capability overrides, keyed by the server's own tool name (pre-prefix).
   *
   * One classification for a whole server is a blunt instrument: a filesystem server has both
   * `read_file` and `write_file`, and marking the server 'execute' to cover the second means the first
   * needs approval too (so the user learns to approve everything), while marking it 'read' waves the
   * second straight through. Example: { "read_file": "read", "write_file": "write" }.
   */
  toolCapabilities?: Record<string, 'read' | 'write' | 'execute'>;
  /**
   * Mount only these tools from the server (by the server's own tool name). Absent = mount all.
   * Useful for a large server where the agent only needs a couple of its tools.
   */
  toolAllowlist?: string[];
}

/** MCP bridge global configuration */
export interface McpBridgeConfig {
  servers: McpServerConfig[];
}
