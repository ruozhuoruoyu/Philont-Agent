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

/** Keys whose VALUE is safe to print verbatim: closed enums and small structural scalars. */
const SAFE_SCALAR_KEYS = new Set([
  'action', 'method', 'mode', 'kind', 'algorithm', 'channel', 'namespace', 'status', 'op',
  'limit', 'maxFiles', 'maxMatches', 'maxResults', 'timeout', 'depth', 'iteration', 'nodeId',
  'parentNodeId', 'step_id', 'plan_id', 'id', 'recursive', 'force', 'dryRun',
]);

/** Keys that carry a body: report size, never content. */
const BULK_KEYS = new Set([
  'content', 'text', 'body', 'script', 'source', 'smtlib', 'command', 'prompt', 'query',
  'value', 'message', 'entry', 'oldText', 'newText', 'summary', 'reason', 'description',
]);

/** Keys that are secrets outright — the name is logged, nothing else, never a length. */
const SECRET_KEYS = /(^|_)(token|secret|password|passwd|apikey|api_key|authorization|cookie|credential)($|_)/i;

/** Fold a filesystem path so it keeps its shape without naming the account. */
export function safePathForLog(value: string): string {
  return value
    .replace(/^([A-Za-z]:)?[\\/]?(Users|home)[\\/][^\\/]+/i, '~')
    .replace(/\\/g, '/');
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
