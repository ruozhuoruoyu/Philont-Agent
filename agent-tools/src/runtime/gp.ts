/**
 * pariGp tool — use PARI/GP for number-theory/algebra computation and counterexample search
 * (the "computational verification teeth" of deep_explore).
 *
 * Role: fills the blind spot of z3Verify in number theory. Z3 is SMT (decidable/bounded arithmetic);
 * pari/gp is a number-theory CAS —— large-integer factoring, primality proof (isprime via APR-CL/ECPP,
 * with certificate), elliptic curves, modular forms, L-functions, p-adic, finite fields...
 * Used to **compute concrete values / enumerate to find counterexamples / rigorously decide a single instance**.
 * It is **not** a formal prover of general propositions: a big conjecture cannot be proved this way,
 * but it can compute instances, find counterexamples, and give strong evidence.
 *
 * Security contract (needs more care than z3 — GP has built-in system()/extern()/install() that can run a shell):
 *   - **-D secure=1**: enable secure mode, disabling system/extern/install/file-write. In non-interactive
 *     (stdin) mode it cannot be turned off by a script (turning off secure requires interactive confirmation,
 *     unavailable in batch mode) → sub-LLM cannot escape into the shell via gp.
 *   - **-f**: skip the user ~/.gprc, making behaviour predictable and not weakened by local config.
 *   - **-q**: silent (no banner/prompt), clean output.
 *   - **parisizemax** caps memory to prevent OOM; **process-level SIGKILL timeout** prevents infinite loops
 *     (GP has no simple internal timeout flag).
 *   - Script is passed via **stdin** (not argv: avoids length/escaping/injection); gp exits automatically on EOF.
 *   - gp missing → success=false + clear error (how to install), no throw, no pretending success.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Tool } from '@agent/policy';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
/** Process safety timeout = computation timeout + this slack (allows time to start). */
const PROCESS_TIMEOUT_SLACK_MS = 2000;

/** gp executable candidates; env PHILONT_GP overrides (points to a specific path or directory). */
function gpCandidates(): string[] {
  const env = process.env.PHILONT_GP?.trim();
  if (!env) return ['gp'];
  // If the user set PHILONT_GP to the directory containing gp, auto-append the executable name.
  if (!/[/\\]gp(\.exe)?$/i.test(env)) {
    const exe = process.platform === 'win32' ? 'gp.exe' : 'gp';
    return [env, join(env, exe)];
  }
  return [env];
}

/** PARI stack limit (prevents OOM); env PHILONT_GP_PARISIZEMAX overrides, default 1G. */
const PARISIZEMAX = process.env.PHILONT_GP_PARISIZEMAX?.trim() || '1G';

/** Cache the gp path that is confirmed to work, prefer it on subsequent calls (avoid hitting ENOENT every time). */
let cachedWorkingGp: string | null = null;

interface GpRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string; // ENOENT etc. (executable not found)
  timedOut?: boolean;
}

type GpPrecheckClass = 'gp-precheck-paren' | 'gp-precheck-nested-braces' | 'gp-precheck-spanning';

function renderGpPrecheck(kind: GpPrecheckClass, message: string): string {
  // The runtime produced this diagnostic, so preserve its already-known class in-band. Downstream
  // learning code must not reverse-engineer our own prose (or let "still unclosed" steal spanning).
  return `PARI/GP pre-check [class=${kind}]: ${message}. Not executed — fix and resend.`;
}

/** Run a script with one gp candidate; ENOENT is flagged separately so the caller can try the next candidate. */
/**
 * GP { } blocks cannot nest (parser limitation: "embedded braces"). Detect depth > 1 and explain
 * the fix: define brace-bodied helpers at TOP LEVEL and never wrap the whole script in an outer
 * brace block — statements at top level are separated by newlines/semicolons already.
 */
export function checkGpNestedBraces(script: string): string | null {
  // Same stripping as checkGpParenBalance: braces inside comments / string literals don't count.
  const stripped = script
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\\\\[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') {
      depth++;
      if (depth > 1) {
        return (
          'nested { } blocks — GP braces cannot nest. Define each brace-bodied helper at TOP level ' +
          '(f(x) = { ... } on its own), and do NOT wrap the whole script in an outer { } block'
        );
      }
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return null;
}

function runOnce(gp: string, script: string, timeoutMs: number): Promise<GpRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(
      gp,
      ['-q', '-f', '-D', 'secure=1', '-D', `parisizemax=${PARISIZEMAX}`],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const killTimer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* noop */ }
      }
    }, timeoutMs + PROCESS_TIMEOUT_SLACK_MS);

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: false, stdout, stderr, spawnError: e.code ?? String(e) });
    });
    // If the child exits early (e.g. gp missing), write triggers an async EPIPE 'error' — swallow it; the verdict is determined by close.
    child.stdin.on('error', () => { /* EPIPE: ignore */ });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, timedOut });
    });

    // Script is passed via stdin; gp quits automatically on EOF.
    try {
      child.stdin.write(script.endsWith('\n') ? script : script + '\n');
      child.stdin.end();
    } catch {
      /* stdin write failure is caught by close/error */
    }
  });
}

/**
 * Cheap pre-flight syntax check: reject an obviously-malformed script (unbalanced parens/brackets)
 * BEFORE spawning gp, so a missing `)` doesn't burn an execution iteration (the dominant deep_explore
 * pariGp failure was `for(i=1,nA,` → "unexpected end of file, expecting )"). String literals, C-style
 * block comments and GP backslash line comments are stripped first so their brackets don't miscount.
 * Returns a short error message, or null when balanced. Safe to hard-reject on: a syntactically valid
 * GP script always has balanced ()/[] outside strings/comments.
 */
export function checkGpParenBalance(script: string): string | null {
  const stripped = script
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\\\\[^\n]*/g, ' ') // \\ line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""'); // string literals
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '(') round++;
    else if (c === ')') {
      round--;
      if (round < 0) return 'a `)` has no matching `(` — check parenthesis balance';
    } else if (c === '[') square++;
    else if (c === ']') {
      square--;
      if (square < 0) return 'a `]` has no matching `[`';
    } else if (c === '{') curly++;
    else if (c === '}') {
      curly--;
      // A `}` with no matching `{` is the classic multi-line-body mistake: a `{ ... }` block was
      // closed but never opened (or the body was wrapped wrong). 2026-06-22: this recurred for hours.
      if (curly < 0) return 'a "}" has no matching "{" — wrap a multi-statement body as { stmt1; stmt2; ... } and balance the braces';
    }
  }
  if (round > 0) return `${round} unclosed "(" — every for / forstep / if / sum must be closed; count your parentheses`;
  if (square > 0) return `${square} unclosed "["`;
  if (curly > 0) return `${curly} unclosed "{" - a multi-line brace body must be closed with a matching "}"`;
  return null;
}

/**
 * The whole-script balance check above is not enough, and seven weeks of logs say so:
 * `pariGp:gp-syntax` has led the failure chart every single week, ×71 then ×26.
 *
 * Production 2026-08-04 09:44:35, three consecutive failures in one deep_explore round:
 *
 *   ***   syntax error, unexpected end of file, expecting )-> or ',' or ')':
 *   ***   for(i=1,8,
 *   ***            ^-
 *
 * Those scripts are PERFECTLY BALANCED overall — checkGpParenBalance passes them. The mistake is that
 * the `for(` opens on one line and closes several lines later, and **gp reading a script line-by-line
 * treats each LINE as a complete statement unless it is inside a `{ }` block**. So it reaches the end
 * of `for(i=1,8,` and reports end-of-file, with the caret pointing at a comma that looks fine.
 *
 * This is the whole ×26. It is also invisible to the two mechanisms aimed at it: the hand-written
 * cheatsheet says "multi-statement body → wrap in braces", which the model reads as being about `;`
 * rather than about spanning LINES, and the repair learner keeps proposing "PARI/GP forbids bare
 * top-level loops" — false, and correctly rejected by its verifier, twice.
 *
 * The rule is mechanical, so it belongs here rather than in a prompt: outside `{ }`, a line must end
 * with its parens closed.
 */
export function checkGpLineSpanningParens(script: string): string | null {
  const stripped = script
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\\\\[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

  let round = 0;
  let curly = 0;
  let line = 1;
  let openedAtLine = 0;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '(') {
      if (round === 0) openedAtLine = line;
      round++;
    } else if (c === ')') round = Math.max(0, round - 1);
    else if (c === '{') curly++;
    else if (c === '}') curly = Math.max(0, curly - 1);
    else if (c === '\n') {
      // A trailing backslash is GP's explicit line continuation — that one is legal unbraced.
      const isContinued = /\\\s*$/.test(stripped.slice(0, i));
      if (curly === 0 && round > 0 && !isContinued) {
        return (
          `line ${openedAtLine} opens a "(" that is still unclosed at the end of line ${line} — ` +
          'gp reads one LINE at a time, so a multi-line for( / sum( / if( dies with ' +
          '"unexpected end of file, expecting )". Either put the whole construct on ONE line, or wrap ' +
          'it in a brace block: { for(i=1,n,\\n  ...\\n) }'
        );
      }
      line++;
    }
  }
  return null;
}

/**
 * PARI/GP prints BOTH fatal errors and benign warnings with the same `***` marker, e.g.
 *   "***   Warning: increasing stack size to 1000000."   (benign — stack auto-grew, script ran fine)
 *   "***   syntax error, unexpected ..."                 (fatal)
 * The old check (any triple-star marker in stderr) treated the benign stack-size warning as a failure,
 * so a CORRECT script "failed", the agent got no result, and fell back to fabricating numbers — the single
 * biggest "command execution keeps failing" cause in the 2026-06-22 post-mortem.
 *
 * Returns the FULL fatal error block — every non-warning `***` line joined — or null when the text
 * has no fatal marker (a warnings-only stderr counts as clean). PARI prints the error across multiple
 * `***` lines: "at top-level: <expr>" (where), a "^---" caret line, then "<func>: <message>" (why).
 * Returning only the first line showed WHERE but not WHY, forcing the agent to add `2>&1` and dig
 * (2026-06-22 transcript: a `random: domain error` cause was hidden behind an `at top-level` line).
 * Pure + exported for reuse by shell.ts and unit tests.
 */
export function gpFatalError(text: string): string | null {
  const fatal: string[] = [];
  for (const line of (text || '').split('\n')) {
    if (!/\*\*\*/.test(line)) continue;
    if (/\*\*\*\s*warning/i.test(line)) continue; // benign warning, not an error
    if (/increasing stack size|new stack size/i.test(line)) continue; // benign stack auto-grow
    if (line.replace(/[*\s]/g, '') !== '') fatal.push(line.trim()); // a *** line with real content
  }
  if (fatal.length === 0) return null;
  return fatal.join('\n').slice(0, 600);
}

/** True if stderr has non-empty content that is NOT a benign PARI/GP warning (used for non-zero exits). */
function stderrHasNonWarningContent(err: string): boolean {
  return err.split('\n').some((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/\*\*\*\s*warning/i.test(t)) return false;
    if (/increasing stack size|new stack size/i.test(t)) return false;
    return true;
  });
}

export const pariGpTool: Tool = {
  name: 'pariGp',
  description:
    'Use PARI/GP for number-theory/algebra computation and counterexample search: large-integer factoring (factor), primality proof (isprime, with a certificate), ' +
    'elliptic curves (ellinit/ellrank, etc.), modular forms, L-functions, p-adic, continued fractions, finite fields, …\n' +
    'Typical use: compute concrete values to verify/refute a proposition, enumerate a range to find counterexamples, rigorously decide a single instance.\n' +
    'The script is the GP language; **use print(...) to explicitly output your conclusion** (otherwise there may be no output).\n' +
    'Security sandbox: secure mode disables system/extern (cannot run a shell, cannot read/write files).\n' +
    'Note: it is a **compute/refute** tool, not a formal prover of general statements — a big conjecture itself cannot be proved, but it can compute instances, find counterexamples, and give strong evidence.',
  schema: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description:
          'GP script (PARI/GP language). E.g.: print(factor(2^67-1)) — outputs the factorization of that Mersenne number (proving it composite); ' +
          'print(isprime(2^61-1)) — a primality test. Use print() to explicitly output your conclusion.\n' +
          'Authoring rules (these recur - get them right the first time):\n' +
          '  - **gp reads ONE LINE at a time.** A for( / sum( / if( whose ")" is on a LATER line dies with ' +
          '"unexpected end of file, expecting )" even though the script is balanced overall. Put the construct on one line, ' +
          'or wrap it in a brace block: { for(i=1,n,\n      ...\n  ) }\n' +
          '  - Count your parentheses: every for( / forstep( / forprime( / sum( / if( must be closed.\n' +
          '  - Multi-statement body: wrap it in braces { a = ...; b = ...; print(b) } and balance them. Statements are separated by ";".\n' +
          '  - Define a helper as f(x) = { ...; value } on its own line, then call it on the next line.\n' +
          '  - A "*** Warning: increasing stack size" line is NOT an error - your script ran; read the printed result.',
      },
      timeoutMs: {
        type: 'number',
        description: `Computation timeout (milliseconds), default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['script'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const script = typeof params.script === 'string' ? params.script : '';
    if (!script.trim()) {
      return { success: false, output: '', error: 'Need a non-empty script (GP script)' };
    }
    // Pre-flight: reject unbalanced parens/brackets before spawning gp (saves a failed iteration).
    const syntaxIssue = checkGpParenBalance(script);
    if (syntaxIssue) {
      return { success: false, output: '', error: renderGpPrecheck('gp-precheck-paren', syntaxIssue) };
    }
    // Pre-flight: NESTED brace blocks. GP's { } multiline blocks cannot nest — wrapping a whole
    // script (with brace-bodied helper functions inside) in one outer { } dies with the cryptic
    // "*** sorry, embedded braces (in parser)" (prod 2026-07-09: burned 5 iterations). Catch it
    // here with an instruction instead.
    const nested = checkGpNestedBraces(script);
    if (nested) {
      return { success: false, output: '', error: renderGpPrecheck('gp-precheck-nested-braces', nested) };
    }
    // Pre-flight: a construct whose parens span LINES outside a brace block. Balanced overall, fatal to
    // gp, and the single most repeated failure signature in the logs. See checkGpLineSpanningParens.
    const spanning = checkGpLineSpanningParens(script);
    if (spanning) {
      return { success: false, output: '', error: renderGpPrecheck('gp-precheck-spanning', spanning) };
    }
    const rawTimeout =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)));

    const base = gpCandidates();
    const candidates = cachedWorkingGp
      ? [cachedWorkingGp, ...base.filter((g) => g !== cachedWorkingGp)]
      : base;

    const cantRun: string[] = [];
    for (const gp of candidates) {
      const run = await runOnce(gp, script, timeoutMs);
      if (run.spawnError) {
        cantRun.push(`${gp}(${run.spawnError})`);
        continue; // failed to start → try next candidate
      }
      // At this point gp started at least; remember it.
      cachedWorkingGp = gp;
      if (run.timedOut) {
        return {
          success: false,
          output: run.stdout.trim(),
          error: `PARI/GP computation timed out (>${timeoutMs}ms); process killed. Narrow the range or raise timeoutMs.`,
        };
      }
      const out = run.stdout.trim();
      const err = run.stderr.trim();
      // gp writes errors to stderr as "*** ... error", but ALSO benign warnings as "*** Warning: ...".
      // Only a non-warning *** line is fatal; a non-zero exit with non-warning stderr also fails.
      const fatal = gpFatalError(err);
      if (fatal) {
        return { success: false, output: out, error: `PARI/GP error:\n${fatal}` };
      }
      if (!run.ok && stderrHasNonWarningContent(err)) {
        return { success: false, output: out, error: `PARI/GP error: ${err.slice(0, 600)}` };
      }
      return { success: true, output: out || '(no output — remember to print(...) your conclusion)' };
    }

    return {
      success: false,
      output: '',
      error:
        `No usable gp (PARI/GP) executable found (tried: ${cantRun.join('; ') || base.join(', ')}). ` +
        `Install PARI/GP (apt install pari-gp / brew install pari), or set PHILONT_GP to the gp path.`,
    };
  },
};
