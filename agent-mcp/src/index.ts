/**
 * @agent/mcp — MCP (Model Context Protocol) bridge layer
 *
 * Mounts tools from external MCP servers into philont's ToolRegistry.
 * Analogous to Linux FUSE: external filesystem → VFS layer.
 *
 * Provides:
 *   - McpBridge          Single MCP server connection management
 *   - connectMcpServers  Bulk-connect multiple MCP servers
 *   - closeMcpBridges    Bulk-close connections
 *   - wrapMcpTool        Wrap an MCP tool as a philont Tool
 *
 * Transport layer:
 *   - StdioTransport     Child-process stdin/stdout communication
 *   - SseTransport       HTTP SSE communication
 */

export { McpBridge, connectMcpServers, closeMcpBridges } from './bridge.js';
export { wrapMcpTool, renderMcpContent, type McpToolDefinition } from './wrapper.js';
export { McpSupervisor } from './supervisor.js';
export type { McpServerStatus, McpConnectionState, SupervisorOptions } from './supervisor.js';
export { StdioTransport } from './transport/stdio.js';
export { SseTransport } from './transport/sse.js';
export { HttpTransport } from './transport/http.js';
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_INITIALIZE_VERSION,
  withProtocolMeta,
  type ProtocolVersion,
  type NegotiationResult,
} from './protocol.js';
export {
  loadMcpConfig,
  defaultMcpConfigPath,
  defaultPlaywrightServer,
  type LoadMcpConfigOptions,
} from './loader.js';
export type {
  McpServerConfig,
  McpStdioConfig,
  McpSseConfig,
  McpHttpConfig,
  McpBridgeConfig,
} from './config.js';
