/**
 * file_logger: tee process stdout/stderr into a daily-rotating log file.
 *
 * Why: tool-call evidence (e.g. `[webSearch] backend=… hits=…`, `[webFetch] …`, deep_explore round
 * logs, gate decisions) is emitted to the console only. When a later command floods the terminal or
 * the scrollback rolls over, that evidence is gone — and a fabricated claim ("the sub-loop has no web
 * access") can no longer be checked against what actually happened. Persisting the console stream to a
 * file makes the record survive the terminal, and gives honesty checks a durable, human-readable
 * after-the-fact source of truth (complementing the structured memory_actions audit).
 *
 * Mechanism: wrap process.stdout.write / process.stderr.write so every byte still goes to the console
 * (original write called first, return value preserved) AND is mirrored, timestamped per line, to
 * ~/.philont/logs/philont-YYYYMMDD.log (UTC day). Zero per-call-site instrumentation — anything already
 * logged is captured. Best-effort: a file-write failure never breaks or blocks the console.
 *
 * Env: PHILONT_FILE_LOG=0/off/false/no disables (default ON). PHILONT_LOG_DIR overrides the directory.
 * PHILONT_LOG_KEEP_DAYS (default 14) prunes older daily files on rotation.
 */
import { openSync, writeSync, closeSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default ON; disabled only by an explicit off-ish value (matches the codebase's flag-parse style). */
export function fileLoggingEnabled(): boolean {
  const v = (process.env.PHILONT_FILE_LOG ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function logDir(): string {
  const env = process.env.PHILONT_LOG_DIR?.trim();
  return env && env.length > 0 ? env : join(homedir(), '.philont', 'logs');
}

/** UTC day stamp YYYYMMDD used for the rotating file name. */
export function dayStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export function logFileName(d: Date): string {
  return `philont-${dayStamp(d)}.log`;
}

/**
 * Pure line-stamper: prefix `prefix` at every line start within `text`, carrying the line-start state
 * across calls (a write may end mid-line). Returns the stamped text and the new line-start state.
 */
export function stampChunk(
  prefix: string,
  text: string,
  atLineStart: boolean,
): { out: string; atLineStart: boolean } {
  if (text.length === 0) return { out: '', atLineStart };
  let out = atLineStart ? prefix : '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    // A newline that is not the final character opens a new line → stamp the next one.
    if (ch === '\n' && i < text.length - 1) out += prefix;
  }
  return { out, atLineStart: text.endsWith('\n') };
}

let installed = false;
let fd: number | null = null;
let fdDay = '';
let atLineStart = true;

function pruneOldLogs(dir: string): void {
  const keepDays = (() => {
    const n = Number(process.env.PHILONT_LOG_KEEP_DAYS);
    return Number.isInteger(n) && n >= 1 ? n : 14;
  })();
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(dir)) {
      if (!/^philont-\d{8}\.log$/.test(f)) continue;
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Open (or roll over to) today's log file, returning an append fd. Synchronous so a write is durable
 * the instant it returns — buffered streams lose their tail exactly in the scenario this guards (the
 * process is killed / the terminal is cleared). Returns null if the file cannot be opened.
 */
function ensureFd(now: Date): number | null {
  const day = dayStamp(now);
  if (fd !== null && fdDay === day) return fd;
  try {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    fd = openSync(join(dir, logFileName(now)), 'a');
    fdDay = day;
    atLineStart = true;
    pruneOldLogs(dir);
    return fd;
  } catch {
    fd = null;
    fdDay = '';
    return null;
  }
}

/**
 * Install the stdout/stderr tee. Idempotent and best-effort: the original write is always called first
 * (console output is never blocked or lost), and any failure mirroring to the file is swallowed.
 */
export function initFileLogging(): void {
  if (installed || !fileLoggingEnabled()) return;
  installed = true;

  for (const tag of ['out', 'err'] as const) {
    const target = tag === 'out' ? process.stdout : process.stderr;
    const orig = target.write.bind(target);
    (target as unknown as { write: (...a: unknown[]) => boolean }).write = (
      chunk: unknown,
      enc?: unknown,
      cb?: unknown,
    ): boolean => {
      // Console first — never let file logging block or drop real output.
      const ret = orig(chunk as never, enc as never, cb as never);
      try {
        const now = new Date();
        const f = ensureFd(now);
        if (f !== null) {
          const text =
            typeof chunk === 'string'
              ? chunk
              : Buffer.isBuffer(chunk)
                ? chunk.toString(typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8')
                : String(chunk);
          const stamped = stampChunk(`${now.toISOString()} [${tag}] `, text, atLineStart);
          atLineStart = stamped.atLineStart;
          writeSync(f, stamped.out);
        }
      } catch {
        // Disk full / permission revoked / fd closed → drop file logging, keep console alive.
        fd = null;
        fdDay = '';
      }
      return ret;
    };
  }

  // Announce via the now-patched writer so this line is itself captured.
  console.log(
    `[file-logger] tee console → ${join(logDir(), logFileName(new Date()))} (set PHILONT_FILE_LOG=0 to disable)`,
  );
}
