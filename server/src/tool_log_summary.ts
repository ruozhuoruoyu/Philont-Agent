/**
 * Safe one-line summary of a tool call for the process log.
 *
 * Two failure modes, one line apart. Dumping `JSON.stringify(call.input)` put the owner's real Windows
 * account name, document bodies, private search queries and shell commands with inline tokens into a
 * file that gets pasted into chats — the reason it was cut. But cutting it to `[tool] writeFile invoked`
 * removed the only evidence that made the 2026-08-09 `writeFile({})` diagnosable at all: with a bare
 * name, "the model emitted a call with no arguments" and "the model emitted a correct call that failed"
 * look identical in the log.
 *
 * So: structure, never content. Field names, byte counts, URL hosts, the leading binary of a command,
 * paths with the home directory folded to `~`. `fields=[]` is what makes an empty call obvious.
 */

import { createHash } from 'node:crypto';

/**
 * Keys whose VALUE is safe to print verbatim. Deliberately only closed enums and structural numbers:
 * a key called `id` is NOT on this list, because "it's just an id" is how a customer name or a
 * document title ends up in a log — identifiers are hashed instead, which keeps them correlatable
 * without being readable.
 */
const SAFE_SCALAR_KEYS = new Set([
  'action', 'method', 'mode', 'kind', 'algorithm', 'channel', 'status', 'op',
  'limit', 'maxFiles', 'maxMatches', 'maxResults', 'timeout', 'depth', 'iteration',
  'recursive', 'force', 'dryRun',
]);

/** Identifier-shaped keys: hashed, so two log lines about the same object still line up. */
const ID_KEYS = new Set([
  'id', 'nodeId', 'parentNodeId', 'step_id', 'plan_id', 'pursuitId', 'sessionId', 'namespace', 'key', 'name',
]);

/** Keys that carry a body: report size, never content. */
const BULK_KEYS = new Set([
  'content', 'text', 'body', 'script', 'source', 'smtlib', 'command', 'prompt', 'query',
  'value', 'message', 'entry', 'oldText', 'newText', 'summary', 'reason', 'description',
]);

/** Keys that are secrets outright — the name is logged, nothing else, never a length. */
const SECRET_KEYS = /(^|_)(token|secret|password|passwd|apikey|api_key|authorization|cookie|credential)($|_)/i;

/**
 * A path's SHAPE, never its directories.
 *
 * Folding `C:\Users\<name>` to `~` only covers the one leak that happened to be in the log that
 * prompted this. `/root/acme-migration/...`, a UNC share, a non-standard home, a directory named
 * after a client — all still readable. What debugging actually needs from a path is which file, and
 * roughly where: `k13_minlaw_arith.lean (abs, d6)` answers a wrong-file or wrong-directory bug just
 * as well as the full string, and answers nothing else.
 */
export function safePathForLog(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const isAbsolute = /^([A-Za-z]:)?\//.test(normalized) || normalized.startsWith('//');
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  const basename = segments.length > 0 ? segments[segments.length - 1]! : '(root)';
  const depth = Math.max(0, segments.length - 1);
  return `${basename} (${isAbsolute ? 'abs' : 'rel'}, d${depth})`;
}

function digestForLog(value: string): string {
  return `#${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/** First token of a shell command — the binary, which is the diagnostic part. */
function commandBin(value: string): string {
  const trimmed = value.trim().replace(/^(cmd(\.exe)?\s+\/[a-z]\s+|sh\s+-c\s+)/i, '');
  const first = trimmed.split(/[\s&|;]+/).find((t) => t.length > 0) ?? '';
  return first.slice(0, 24) || '(empty)';
}

function summarizeValue(key: string, value: unknown): string | null {
  if (SECRET_KEYS.test(key)) return `${key}=[redacted]`;
  if (value === null) return `${key}=null`;
  if (value === undefined) return `${key}=undefined`;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return SAFE_SCALAR_KEYS.has(key) ? `${key}=${value}` : `${key}=<${typeof value}>`;
  }
  if (typeof value === 'string') {
    if (key === 'url' || key === 'endpoint') {
      const host = safeHost(value);
      return host ? `${key}Host=${host}` : `${key}=<${value.length}c>`;
    }
    if (key === 'command') return `commandBin=${commandBin(value)} commandBytes=${value.length}`;
    if (key === 'path' || key === 'cwd' || key === 'from' || key === 'to' || key === 'file') {
      return `${key}=${safePathForLog(value)}`;
    }
    if (BULK_KEYS.has(key)) return `${key}Bytes=${value.length}`;
    if (SAFE_SCALAR_KEYS.has(key) && value.length <= 32) return `${key}=${value}`;
    if (ID_KEYS.has(key)) return `${key}=${digestForLog(value)}`;
    return `${key}=<${value.length}c>`;
  }
  if (Array.isArray(value)) return `${key}=<${value.length} items>`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 6);
    return `${key}Keys=[${keys.join(',')}]`;
  }
  return `${key}=<${typeof value}>`;
}

/**
 * Build the log line body. Never throws — a logging helper that can fail is worse than no log line.
 */
export function summarizeToolInputForLog(input: unknown): string {
  try {
    if (input === null || input === undefined) return 'input=none';
    if (typeof input !== 'object' || Array.isArray(input)) {
      return `input=<${Array.isArray(input) ? 'array' : typeof input}>`;
    }
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record);
    const parts = [`fields=[${keys.join(',')}]`];
    for (const key of keys) {
      const summary = summarizeValue(key, record[key]);
      if (summary) parts.push(summary);
    }
    return parts.join(' ');
  } catch {
    return 'input=<unsummarizable>';
  }
}
