/**
 * Streamable HTTP transport (MCP 2025-03-26 and later).
 *
 * This is how remote MCP servers are reached today. philont had only stdio and the old HTTP+SSE
 * transport, and HTTP+SSE was deprecated by this one in 2025-03-26 — meaning philont could not connect
 * to essentially any current hosted server. That was the single largest gap in the MCP layer.
 *
 * Shape of the protocol (deliberately much simpler than HTTP+SSE):
 *   - ONE endpoint. Every client→server message is a POST to it.
 *   - The client advertises `Accept: application/json, text/event-stream`; the server picks. A
 *     single-shot answer comes back as JSON; a server that wants to stream progress answers with an
 *     SSE body whose events carry JSON-RPC messages, and we take the first one matching our id.
 *   - A notification gets 202 Accepted with no body.
 *   - The server MAY hand out a session id in `Mcp-Session-Id` on the first response; if it does, every
 *     later request must echo it back.
 *   - From 2025-06-18 the negotiated protocol version must travel in `MCP-Protocol-Version`; a
 *     mismatch is a 400, so the header is set as soon as negotiation settles.
 *
 * Not implemented (deliberate, documented): the optional GET stream for server→client requests. philont
 * consumes tools, which is request/response; sampling and elicitation would need it, and both are
 * separate work items.
 */

import { EventEmitter } from 'node:events';
import type { McpHttpConfig } from '../config.js';
import { parseSseFrames } from './sse.js';
import { isModernProtocolVersion, withProtocolMeta, type ProtocolVersion } from '../protocol.js';

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

const BASE64_SENTINEL_PREFIX = '=?base64?';
const BASE64_SENTINEL_SUFFIX = '?=';

/** Encode a modern MCP metadata header value per the 2026-07-28 transport rules. */
export function encodeMcpHeaderValue(value: string): string {
  const plainAscii = /^[\x20-\x7e]*$/.test(value);
  const hasOuterWhitespace = value !== value.trim();
  const looksEncoded = value.startsWith(BASE64_SENTINEL_PREFIX)
    && value.endsWith(BASE64_SENTINEL_SUFFIX);
  if (plainAscii && !hasOuterWhitespace && !looksEncoded) return value;
  return `${BASE64_SENTINEL_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${BASE64_SENTINEL_SUFFIX}`;
}

function requestPrincipalName(method: string, params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  const value = method === 'resources/read' ? record.uri : record.name;
  return typeof value === 'string' && value ? value : undefined;
}

export class HttpTransport extends EventEmitter {
  private url: string;
  private baseHeaders: Record<string, string>;
  private timeout: number;
  private nextId = 1;
  private sessionId: string | null = null;
  private protocolVersion: ProtocolVersion | null = null;
  private open = false;

  constructor(config: McpHttpConfig, timeout = 30000) {
    super();
    this.url = config.url;
    this.baseHeaders = config.headers ?? {};
    this.timeout = timeout;
  }

  /**
   * No handshake of its own: the endpoint is stateless until the first message, and the MCP handshake
   * belongs to the bridge. We only check that the URL is well-formed so a typo fails here rather than
   * as a confusing error on the first tool call.
   */
  async connect(): Promise<void> {
    try {
      // eslint-disable-next-line no-new
      new URL(this.url);
    } catch {
      throw new Error(`invalid MCP http url: ${this.url}`);
    }
    this.open = true;
  }

  /** Called by the bridge once the protocol version is settled (see protocol.ts). */
  setProtocolVersion(version: ProtocolVersion | null): void {
    this.protocolVersion = version;
    if (isModernProtocolVersion(version)) this.sessionId = null;
  }

  private headers(method?: string, params?: unknown): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.baseHeaders,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) {
      h['MCP-Protocol-Version'] = String(this.protocolVersion);
      if (isModernProtocolVersion(this.protocolVersion) && method) {
        h['Mcp-Method'] = encodeMcpHeaderValue(method);
        const name = requestPrincipalName(method, params);
        if (name) h['Mcp-Name'] = encodeMcpHeaderValue(name);
      }
    }
    return h;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.open) throw new Error('MCP http transport not connected');
    const id = this.nextId++;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: withProtocolMeta(params, this.protocolVersion),
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let resp: Response;
    try {
      resp = await fetch(this.url, { method: 'POST', headers: this.headers(method, params), body, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      const err = e as Error;
      throw new Error(
        err.name === 'AbortError'
          ? `MCP request timeout: ${method} (${this.timeout}ms)`
          : `MCP http POST failed: ${err.message}`,
      );
    }

    try {
      // A session id may be issued on any response; hold on to the first one we see.
      const sid = resp.headers.get('mcp-session-id');
      if (sid && !this.sessionId && !isModernProtocolVersion(this.protocolVersion)) this.sessionId = sid;

      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 300);
        throw new Error(`MCP http error: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`);
      }

      const ct = resp.headers.get('content-type') ?? '';

      if (ct.includes('text/event-stream')) {
        return await this.readSseResponse(resp, id, method);
      }

      const text = await resp.text();
      if (!text.trim()) return null; // 202 Accepted / empty body
      const msg = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
      const list = Array.isArray(msg) ? msg : [msg];
      const mine = list.find((m) => m.id === id) ?? list[0];
      if (mine?.error) throw new Error(`MCP error: ${mine.error.message} (code ${mine.error.code})`);
      return mine?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read an SSE body until the JSON-RPC response with our id arrives (notifications pass through). */
  private async readSseResponse(resp: Response, id: number, method: string): Promise<unknown> {
    if (!resp.body) throw new Error(`MCP http: empty stream for ${method}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + this.timeout;

    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error(`MCP request timeout: ${method} (${this.timeout}ms)`);
        const { done, value } = await reader.read();
        if (done) throw new Error(`MCP http: stream ended before a response to ${method}`);
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const ev of events) {
          let msg: JsonRpcMessage;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            continue;
          }
          if (msg.id === id) {
            if (msg.error) throw new Error(`MCP error: ${msg.error.message} (code ${msg.error.code})`);
            return msg.result ?? null;
          }
          // Server-initiated message (progress, logging, …): surface it, keep waiting for our reply.
          if (msg.id === undefined) this.emit('notification', msg);
        }
      }
    } finally {
      reader.releaseLock();
      await resp.body.cancel().catch(() => {});
    }
  }

  notify(method: string, params?: unknown): void {
    if (!this.open) return;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params: withProtocolMeta(params, this.protocolVersion),
    });
    fetch(this.url, { method: 'POST', headers: this.headers(method, params), body }).catch(() => {
      // notifications are fire-and-forget
    });
  }

  /** Politely end the session if the server issued one (DELETE is optional and may 405 — ignore). */
  async close(): Promise<void> {
    this.open = false;
    if (this.sessionId && !isModernProtocolVersion(this.protocolVersion)) {
      await fetch(this.url, { method: 'DELETE', headers: this.headers() }).catch(() => {});
      this.sessionId = null;
    }
  }

  get connected(): boolean {
    return this.open;
  }
}
