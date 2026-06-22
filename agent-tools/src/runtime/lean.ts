/**
 * leanCheck tool — use the Lean 4 theorem prover to FORMALLY VERIFY a proof, the formal-methods
 * counterpart of z3Verify (decidable SMT) and pariGp (numeric CAS). Lean machine-checks a proof term
 * against the kernel: if it elaborates with no errors and no `sorry`/`admit`, the theorem is proven.
 *
 * Why this is a native tool and not `shell lean foo.lean` (2026-06-22 fabrication post-mortem):
 *   - Lean has a FALSE-SUCCESS trap exactly like gp's "exited 0 but stderr has ***": a proof that
 *     contains `sorry` or `admit` ELABORATES SUCCESSFULLY and `lean` EXITS 0 — but proves NOTHING
 *     (`sorry` is an axiom-level hole). A naive shell wrapper would see exit 0 and let the model claim
 *     "Lean proved it". This tool detects sorry/admit/unsolved-goals and reports them as NOT verified,
 *     so "proved" can only be claimed when the kernel genuinely accepted a hole-free proof.
 *   - Routing it through a native tool also gives it the same failure-signature / escalation handling
 *     as pariGp/z3 (see agent-memory/src/failure_signatures.ts leanCheck:lean-*).
 *
 * Security contract:
 *   - The provided source is written to a temp .lean file and checked with `lean <file>`. Lean's kernel
 *     elaborates terms; it has no shell/network capability in plain checking mode. (Avoid enabling
 *     unsafe metaprogramming that runs IO; this tool does not pass any flag that does.)
 *   - Process-level SIGKILL timeout prevents a non-terminating elaboration from hanging.
 *   - lean missing → success=false + a clear install hint (elan), no throw, no pretending success.
 *
 * Mathlib note: imports that need Mathlib require a project LEAN_PATH; set PHILONT_LEAN to a `lean`
 * launched inside such a project (or a wrapper that sets LEAN_PATH). Import-less proofs check directly.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';
import type { Tool } from '@agent/policy';

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 120000;
/** Process safety timeout = check timeout + this slack (Lean startup + import loading can be slow). */
const PROCESS_TIMEOUT_SLACK_MS = 5000;

/** lean executable candidates; env PHILONT_LEAN overrides (a path, or a dir containing lean). */
function leanCandidates(): string[] {
  const env = process.env.PHILONT_LEAN?.trim();
  if (!env) return ['lean'];
  if (!/[/\\]lean(\.exe)?$/i.test(env)) {
    const exe = process.platform === 'win32' ? 'lean.exe' : 'lean';
    return [env, join(env, exe)];
  }
  return [env];
}

/** Cache the lean path confirmed to work, prefer it next call (avoid hitting ENOENT every time). */
let cachedWorkingLean: string | null = null;

interface LeanRun {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
}

function runOnce(lean: string, file: string, timeoutMs: number): Promise<LeanRun> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(lean, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      resolve({ code: null, stdout, stderr, spawnError: e.code ?? String(e) });
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export interface LeanVerdict {
  success: boolean;
  /** Failure taxonomy (mirrors failure_signatures.ts leanCheck:* classes); undefined on success. */
  errorClass?: 'lean-sorry' | 'lean-unsolved' | 'lean-unknown' | 'lean-timeout' | 'lean-error';
  message: string;
}

/**
 * Classify a Lean run into a verdict. PURE (no IO) so it is unit-testable without lean installed.
 *
 * Critical ordering: `sorry`/`admit` is checked FIRST and overrides a 0 exit code — a proof with a
 * hole elaborates "successfully" (exit 0) yet proves nothing. This is the whole reason leanCheck
 * exists; do not let a clean exit code mask it.
 */
export function classifyLeanOutput(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
): LeanVerdict {
  if (timedOut) {
    return { success: false, errorClass: 'lean-timeout', message: 'Lean check timed out (computation/elaboration did not finish).' };
  }
  const combined = `${stdout}\n${stderr}`;
  const lower = combined.toLowerCase();

  // FALSE-SUCCESS TRAP: sorry/admit elaborate with exit 0 but prove nothing.
  if (/\bsorry\b/.test(lower) || /declaration uses 'sorry'/.test(lower) || /\badmit\b/.test(lower)) {
    return {
      success: false,
      errorClass: 'lean-sorry',
      message:
        "Proof contains `sorry`/`admit` — Lean elaborated it but it proves NOTHING (an axiom-level hole). " +
        "This is NOT a verified proof. Replace every sorry/admit with a real proof term.",
    };
  }
  if (/unsolved goals/.test(lower)) {
    return { success: false, errorClass: 'lean-unsolved', message: 'Unsolved goals remain — the proof is incomplete.' };
  }
  if (/unknown identifier|unknown constant/.test(lower)) {
    return { success: false, errorClass: 'lean-unknown', message: 'Unknown identifier/constant (missing import or typo). Not verified.' };
  }
  if (/(^|\n)[^\n]*error:/.test(lower) || (code !== 0 && code !== null)) {
    const firstErr = combined.split('\n').find((l) => /error:/i.test(l))?.trim();
    return { success: false, errorClass: 'lean-error', message: `Lean reported an error${firstErr ? `: ${firstErr}` : ` (exit ${code})`}. Not verified.` };
  }
  return { success: true, message: 'Lean kernel accepted the proof with no errors and no sorry/admit — verified.' };
}

let tmpSeq = 0;

export const leanCheckTool: Tool = {
  name: 'leanCheck',
  description:
    'Formally verify a Lean 4 proof. Provide a self-contained Lean source (theorem + proof). The Lean ' +
    'kernel machine-checks it. Returns verified=true ONLY when it elaborates with no errors AND no ' +
    '`sorry`/`admit` (a sorry/admit proves nothing and is reported as NOT verified). Use this to ' +
    'discharge a precise lemma rigorously — not to "prove" a large open conjecture in one shot. ' +
    'Imports needing Mathlib require a project LEAN_PATH (set PHILONT_LEAN to a project-aware lean).',
  schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description:
          'Complete Lean 4 source to check, e.g.:\n' +
          'theorem add_comm_nat (a b : Nat) : a + b = b + a := by omega\n' +
          'Do NOT leave `sorry`/`admit` in it — those are reported as unverified.',
      },
      timeoutMs: {
        type: 'number',
        description: `Check timeout (ms), default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['source'],
  },
  capability: 'execute',
  domain: 'local',
  async execute(params) {
    const source = typeof params.source === 'string' ? params.source : '';
    if (!source.trim()) {
      return { success: false, output: '', error: 'Need a non-empty `source` (Lean 4 proof text).' };
    }
    // Cheap pre-check: a literal sorry/admit in the SOURCE is never a verified proof — fail before spawning.
    if (/\bsorry\b/.test(source) || /\badmit\b/.test(source)) {
      return {
        success: false,
        output: '',
        error:
          "Your Lean source contains `sorry`/`admit` — that is a placeholder hole, not a proof. " +
          "Lean would 'accept' it with exit 0 but it proves nothing. Supply a complete proof.",
      };
    }
    const rawTimeout =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
        ? params.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.floor(rawTimeout)));

    const file = join(tmpdir(), `philont_lean_${process.pid}_${Date.now()}_${tmpSeq++}.lean`);
    try {
      await writeFile(file, source.endsWith('\n') ? source : source + '\n', 'utf8');
    } catch (e) {
      return { success: false, output: '', error: `Could not write temp Lean file: ${(e as Error)?.message}` };
    }

    try {
      const base = leanCandidates();
      const candidates = cachedWorkingLean
        ? [cachedWorkingLean, ...base.filter((p) => p !== cachedWorkingLean)]
        : base;
      const cantRun: string[] = [];

      for (const lean of candidates) {
        const run = await runOnce(lean, file, timeoutMs);
        if (run.spawnError) {
          cantRun.push(`${lean}(${run.spawnError})`);
          continue;
        }
        cachedWorkingLean = lean;
        const verdict = classifyLeanOutput(run.stdout, run.stderr, run.code, run.timedOut ?? false);
        const detail = `${run.stdout}\n${run.stderr}`.trim().slice(0, 1200);
        if (verdict.success) {
          return { success: true, output: `verified: ${verdict.message}${detail ? `\n---\n${detail}` : ''}` };
        }
        return { success: false, output: '', error: `${verdict.message}${detail ? `\n---\n${detail}` : ''}` };
      }

      return {
        success: false,
        output: '',
        error:
          `Lean not runnable (tried: ${cantRun.join('; ') || leanCandidates().join(', ')}). ` +
          `Install Lean 4 via elan (https://leanprover.github.io), or set PHILONT_LEAN to the lean executable.`,
      };
    } finally {
      try { await unlink(file); } catch { /* best-effort cleanup */ }
    }
  },
};
