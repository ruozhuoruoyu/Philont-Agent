/**
 * MCP protocol versions and negotiation.
 *
 * philont pinned `2024-11-05` in the initialize handshake and never looked at what the server answered.
 * That revision is from the protocol's first month; the spec has since shipped 2025-03-26 (Streamable
 * HTTP), 2025-06-18, 2025-11-25 and 2026-07-28. The newest revision changes the shape of the handshake
 * itself: `initialize` is gone, every request instead carries
 * `_meta["io.modelcontextprotocol/protocolVersion"]` (required), and a server MAY expose a
 * `server/discover` method for capability discovery. Over HTTP the same version must also appear in the
 * `MCP-Protocol-Version` header, and a mismatch is a 400.
 *
 * So a client that speaks exactly one dialect is either stuck on old servers or broken on new ones.
 * The negotiation here is deliberately small:
 *
 *   1. try `server/discover` — modern servers answer with their protocol version;
 *   2. otherwise fall back to `initialize`, offering our preferred version, and ADOPT whatever the
 *      server answers with (that is what the handshake is for — the old code ignored the reply);
 *   3. if the server rejects the offer outright, walk down the known revisions and retry.
 *
 * Whatever version we settle on is then attached to every subsequent request, which is a no-op for old
 * servers (`_meta` has been reserved-and-ignored since the first revision) and mandatory for new ones.
 */

/** Known protocol revisions, newest first. The order is the negotiation walk order. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export type ProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] | string;

/**
 * Version we offer first.
 *
 * Not the newest: `initialize` was removed in 2026-07-28, so offering it in an initialize handshake is
 * contradictory. 2025-06-18 is the newest revision that is still initialize-shaped and widely
 * implemented; genuinely modern servers are picked up by `server/discover` before we ever get here, and
 * a server that prefers something else says so in its reply and we adopt it.
 */
export const PREFERRED_INITIALIZE_VERSION: ProtocolVersion = '2025-06-18';

/** The `_meta` key carrying the protocol version on every request (2026-07-28+). */
export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

/** JSON-RPC "method not found" — how a pre-2026-07-28 server answers `server/discover`. */
export const METHOD_NOT_FOUND = -32601;

export interface NegotiationResult {
  version: ProtocolVersion;
  /** How the version was established, for logging and for the status endpoint. */
  via: 'discover' | 'initialize' | 'assumed';
  /** Server-declared capabilities, when it told us any. */
  capabilities?: Record<string, unknown>;
  serverInfo?: { name?: string; version?: string };
}

/** Attach the negotiated protocol version to a request's params without disturbing the caller's object. */
export function withProtocolMeta(params: unknown, version: ProtocolVersion | null): unknown {
  if (!version) return params;
  const base = params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : params === undefined
      ? {}
      : null;
  if (base === null) return params; // array/primitive params: leave untouched
  const meta = { ...((base._meta as Record<string, unknown> | undefined) ?? {}) };
  meta[PROTOCOL_VERSION_META_KEY] = version;
  return { ...base, _meta: meta };
}

/** Does an error look like the server refusing our protocol version? */
export function isUnsupportedVersionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unsupported.*(protocol|version)|protocol.*version.*not supported|UnsupportedProtocolVersion/i.test(msg);
}

/** Does an error look like "this server has never heard of that method"? */
export function isMethodNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return new RegExp(`code ${METHOD_NOT_FOUND}\\b`).test(msg) || /method not found/i.test(msg);
}
