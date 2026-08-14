/**
 * McpToolWrapper — wrap an MCP tool as a philont Tool interface
 *
 * MCP tool definition → philont Tool mapping:
 *   name        → toolPrefix + '.' + mcp_tool_name
 *   description → mcp_tool_description
 *   schema      → mcp_tool_inputSchema
 *   execute     → send tools/call via transport
 */

import type { Tool, ToolResult } from '@agent/policy';
import type { Capability, Domain } from '@agent/policy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** MCP tool definition (from the tools/list response) */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The only thing a wrapped tool needs from a transport. Structural, not a union of the concrete
 * classes: adding a transport (Streamable HTTP) should not mean editing every consumer's type.
 */
export interface Transport {
  request(method: string, params?: unknown): Promise<unknown>;
}

/** One item of an MCP tool result's `content` array (2025-06-18 shape, superset of 2024-11-05). */
interface McpContentItem {
  type: string;
  text?: string;
  /** base64 payload for image / audio */
  data?: string;
  mimeType?: string;
  /** `resource` embeds the contents inline; `resource_link` only points at it */
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
  uri?: string;
  name?: string;
}

/** Bound on how much of an unrecognised result shape we are willing to inline. */
const MAX_FALLBACK_CHARS = 4000;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
};

/** Where MCP binary payloads land: same convention as downloadFile, under an mcp/ subdirectory. */
function mcpArtifactDir(): string {
  const env = process.env.PHILONT_DOWNLOAD_DIR;
  const base = env && isAbsolute(env) ? env : join(homedir(), '.philont', 'downloads');
  return join(base, 'mcp');
}

function humanBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

let artifactSeq = 0;

/** Write a base64 payload to disk; returns the path, or null if it could not be written. */
function saveBase64(data: string, mimeType: string | undefined, toolName: string): { path: string; bytes: number } | null {
  try {
    const buf = Buffer.from(data, 'base64');
    const dir = mcpArtifactDir();
    mkdirSync(dir, { recursive: true });
    const ext = (mimeType && MIME_EXT[mimeType]) || '.bin';
    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const file = join(dir, `${safeTool}-${Date.now()}-${++artifactSeq}${ext}`);
    writeFileSync(file, buf);
    return { path: file, bytes: buf.byteLength };
  } catch {
    return null;
  }
}

/**
 * Render an MCP tool result's content array into text safe to put in front of an LLM.
 *
 * The previous implementation kept only `type === 'text'` items and, when that left nothing, fell
 * back to `JSON.stringify(result)` — which for an image result means the ENTIRE base64 blob goes into
 * the conversation. philont's one bundled MCP server is Playwright, whose screenshot tool returns
 * exactly that: a single screenshot could blow up the context window and cost a fortune, per call.
 *
 * Binary payloads are therefore written to disk and represented by a one-line reference. Anything not
 * recognised is described, never dumped. Exported for tests.
 */
export function renderMcpContent(
  content: McpContentItem[] | undefined,
  toolName: string,
): { text: string; artifacts: string[] } {
  const parts: string[] = [];
  const artifacts: string[] = [];

  for (const c of content ?? []) {
    switch (c?.type) {
      case 'text':
        parts.push(c.text ?? '');
        break;

      case 'image':
      case 'audio': {
        const saved = c.data ? saveBase64(c.data, c.mimeType, toolName) : null;
        if (saved) {
          artifacts.push(saved.path);
          parts.push(`[${c.type} saved to ${saved.path} (${c.mimeType ?? 'unknown type'}, ${humanBytes(saved.bytes)})]`);
        } else {
          // Could not persist it — still never inline the payload.
          const approx = c.data ? humanBytes(Math.floor((c.data.length * 3) / 4)) : 'unknown size';
          parts.push(`[${c.type} omitted: ${c.mimeType ?? 'unknown type'}, ${approx}, could not be saved to disk]`);
        }
        break;
      }

      case 'resource': {
        const r = c.resource ?? {};
        if (typeof r.text === 'string') {
          parts.push(r.uri ? `[resource ${r.uri}]\n${r.text}` : r.text);
        } else if (r.blob) {
          const saved = saveBase64(r.blob, r.mimeType, toolName);
          if (saved) {
            artifacts.push(saved.path);
            parts.push(`[resource ${r.uri ?? ''} saved to ${saved.path} (${r.mimeType ?? 'binary'}, ${humanBytes(saved.bytes)})]`);
          } else {
            parts.push(`[resource ${r.uri ?? ''} omitted: binary payload could not be saved]`);
          }
        } else {
          parts.push(`[resource ${r.uri ?? '(no uri)'}: empty]`);
        }
        break;
      }

      case 'resource_link':
        parts.push(`[resource_link ${c.uri ?? '(no uri)'}${c.name ? ` — ${c.name}` : ''}]`);
        break;

      default:
        parts.push(`[unsupported MCP content type '${c?.type ?? 'undefined'}' — not inlined]`);
    }
  }

  return { text: parts.join('\n'), artifacts };
}

/**
 * Normalise an MCP tool's inputSchema to meet LLM tool-calling parameter requirements.
 *
 * Motivation: the inputSchema from the MCP server is passed verbatim as
 * input_schema / function.parameters to the LLM. Strict compat endpoints (e.g. DeepSeek
 * validating against OpenAI rules) require parameters to be a top-level
 * `type: "object"` JSON Schema; missing type, or meta-fields like `$schema`, may trigger
 * a 400 rejection. This performs the minimal, safe normalisation: guarantee object shape,
 * strip commonly-rejected meta-fields. Never mutates properties content.
 */
function normalizeInputSchema(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'object', properties: {} };
  }
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // Top level must be an object schema
  if (out.type !== 'object') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) {
    out.properties = {};
  }
  // Strip meta-fields that strict validators frequently reject (do not affect parameter semantics)
  delete out.$schema;
  delete out.$id;
  return out;
}

/**
 * Wrap an MCP tool definition as a philont Tool
 */
export function wrapMcpTool(
  mcpTool: McpToolDefinition,
  transport: Transport,
  options: {
    prefix?: string;
    capability?: Capability;
    domain?: Domain;
    timeout?: number;
  } = {},
): Tool {
  const {
    prefix,
    capability = 'read',
    domain = 'network',
  } = options;

  // Tool name must match the LLM tool-calling convention ^[a-zA-Z0-9_-]+$ (validated by OpenAI/Anthropic etc.).
  // Use '_' as the prefix separator (not '.': dot is outside the allowed charset and causes API 400).
  // Also sanitise the final name: replace any illegal character with '_' to handle unusual naming
  // from MCP servers.
  // Note: execute() still calls the MCP server using the original mcpTool.name;
  // sanitisation only affects the philont-side tool name.
  const rawName = prefix ? `${prefix}_${mcpTool.name}` : mcpTool.name;
  const toolName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');

  return {
    name: toolName,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    schema: normalizeInputSchema(mcpTool.inputSchema),
    capability,
    domain,

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await transport.request('tools/call', {
          name: mcpTool.name, // call MCP server using the original name
          arguments: params,
        }) as {
          content?: McpContentItem[];
          structuredContent?: unknown;
          isError?: boolean;
        };

        // MCP tool result format: { content: [...], structuredContent?, isError?: boolean }
        const { text } = renderMcpContent(result?.content, toolName);

        let output = text;
        if (!output) {
          // No content array (or an empty one). Prefer structuredContent (2025-06-18); otherwise show
          // a BOUNDED dump of whatever shape came back — an unrecognised result must never be able to
          // paste an unbounded payload into the conversation.
          const raw = JSON.stringify(result?.structuredContent ?? result ?? null);
          output =
            raw && raw.length > MAX_FALLBACK_CHARS
              ? `${raw.slice(0, MAX_FALLBACK_CHARS)}… [truncated ${raw.length - MAX_FALLBACK_CHARS} chars]`
              : raw ?? '';
        }

        return {
          success: !result?.isError,
          output,
          error: result?.isError ? output : undefined,
        };
      } catch (error) {
        return {
          success: false,
          output: '',
          error: `MCP tool call failed: ${error}`,
        };
      }
    },
  };
}
