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
 * ~/.philont/logs/philont-YYYYMMDD.log. Timestamps and the daily rollover use the OWNER's timezone
 * (AGENT_TIMEZONE, set in the web-ui settings) — a log is read by a human against a wall clock. Zero per-call-site instrumentation — anything already
 * logged is captured. Best-effort: a file-write failure never breaks or blocks the console.
 *
 * Env: PHILONT_FILE_LOG=0/off/false/no disables (default ON). PHILONT_LOG_DIR overrides the directory.
 * AGENT_TIMEZONE selects the timezone for stamps + rollover (unset / unknown → UTC).
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

/**
 * The owner's timezone — AGENT_TIMEZONE, configured in the web-ui settings (which prefills it from the
 * browser's IANA zone). Falls back to UTC when unset or unrecognized by the ICU build.
 *
 * Logs are read by a human, and that human reads a wall clock. Stamping them in UTC forced the owner to
 * mentally re-add their offset to every line just to answer "when did this happen?" — and a UTC day
 * boundary rotated the file in the middle of their afternoon, so "today's log" was two files.
 */
export function logTimeZone(): string {
  const tz = (process.env.AGENT_TIMEZONE ?? '').trim();
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC'; // unknown zone → never crash the logger over a config typo
  }
}

/** Calendar/clock parts of `d` as seen in `tz`. */
function partsIn(d: Date, tz: string): { y: number; mo: number; da: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23', // never yields "24" for midnight
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return { y: +p.year, mo: +p.month, da: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** UTC offset of `tz` at instant `d`, as "+08:00" / "-05:00" / "Z". */
export function tzOffsetLabel(d: Date, tz: string): string {
  const p = partsIn(d, tz);
  // Interpret the local wall-clock parts as if they were UTC; the gap to the real instant IS the offset.
  const asIfUtc = Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi, p.s);
  const offMin = Math.round((asIfUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  if (offMin === 0) return 'Z';
  const sign = offMin > 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * ISO-8601 timestamp in `tz`, e.g. "2026-07-14T09:31:02.417+08:00". Keeps the offset so a line is still
 * unambiguous (and machine-parseable) — the point is to spare the reader the arithmetic, not to discard
 * which instant it was.
 */
export function stampTime(d: Date, tz: string = logTimeZone()): string {
  const p = partsIn(d, tz);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p.y}-${pad(p.mo)}-${pad(p.da)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.` +
    `${pad(d.getMilliseconds(), 3)}${tzOffsetLabel(d, tz)}`
  );
}

/** Day stamp YYYYMMDD in the owner's timezone — the file rolls over at THEIR midnight, not UTC's. */
export function dayStamp(d: Date, tz: string = logTimeZone()): string {
  const p = partsIn(d, tz);
  return `${p.y}${String(p.mo).padStart(2, '0')}${String(p.da).padStart(2, '0')}`;
}

export function logFileName(d: Date, tz: string = logTimeZone()): string {
  return `philont-${dayStamp(d, tz)}.log`;
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
      // File FIRST: writeSync to a local fd is fast and won't pause; the original console/pipe write can
      // BLOCK when the terminal is paused (Windows QuickEdit click-to-pause backs up the launcher pipe).
      // Writing the file first means the line is durably on disk even if the subsequent console write then
      // stalls — the file stays the ahead-of-console source of truth. Best-effort; failure never blocks output.
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
          const stamped = stampChunk(`${stampTime(now)} [${tag}] `, text, atLineStart);
          atLineStart = stamped.atLineStart;
          writeSync(f, stamped.out);
        }
      } catch {
        // Disk full / permission revoked / fd closed → drop file logging, keep console alive.
        fd = null;
        fdDay = '';
      }
      return orig(chunk as never, enc as never, cb as never);
    };
  }

  // Announce via the now-patched writer so this line is itself captured.
  console.log(
    `[file-logger] tee console → ${join(logDir(), logFileName(new Date()))} (set PHILONT_FILE_LOG=0 to disable)`,
  );
}
