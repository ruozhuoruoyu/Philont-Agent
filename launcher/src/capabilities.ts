/**
 * Optional capability detection — the base package ships with only the Node core;
 * z3 / Python document tools / playwright are all "on-demand capabilities".
 * This module probes whether they are present so the settings panel can show their
 * status and installation hints (rather than bundling hundreds of MB of Python science
 * stack / browser into the installer).  All probes are best-effort; a failed probe is
 * reported as "not detected".
 */
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readConfig } from './env-file.js';

interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a short command and capture its exit code + output. 3 s timeout; never throws. */
function probe(cmd: string, args: string[]): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let out = '', err = '';
    let done = false;
    const finish = (r: ProbeResult) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      // Windows needs cmd.exe to resolve PATH and run .cmd/.bat wrappers (npx.cmd,
      // playwright.cmd, gp.cmd). Invoke it explicitly below; `shell:true` causes DEP0190 and
      // obscures the concatenation boundary. POSIX keeps the direct args-array spawn.
      const useCmd = process.platform === 'win32';
      if (useCmd) {
        // Invoke cmd.exe explicitly instead of `shell:true`. Besides removing DEP0190, this makes the
        // shell boundary visible and keeps Node from silently concatenating an args array itself.
        // Every token is quoted because overrides may contain spaces or cmd metacharacters.
        const q = (s: string) => `"${s.replace(/%/g, '%%').replace(/"/g, '""')}"`;
        const commandLine = [cmd, ...args].map(q).join(' ');
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
        });
      } else {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      }
    } catch (e) {
      return finish({ code: null, stdout: '', stderr: '', error: (e as Error).message });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ code: null, stdout: out, stderr: err, error: 'timeout' }); }, 3000);
    timer.unref();
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: null, stdout: out, stderr: err, error: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); finish({ code, stdout: out, stderr: err }); });
  });
}

/**
 * Resolve a PHILONT_* override. The launcher process does NOT load ~/.philont/.env into its
 * own process.env (it only forwards the path to the agent child), so settings the user saved
 * via the web-ui — PHILONT_GP / PHILONT_PLAYWRIGHT / PHILONT_PYTHON — live only in the file.
 * Prefer an OS-level env var, fall back to the .env file value.
 */
function envOverride(key: string, fileCfg: Record<string, string>): string | undefined {
  return process.env[key]?.trim() || fileCfg[key]?.trim() || undefined;
}

const pythonCandidates = (pythonOverride?: string): string[] => {
  return pythonOverride ? [pythonOverride] : ['python3', 'python'];
};

/** Default Playwright browser cache dir (overridable by PLAYWRIGHT_BROWSERS_PATH). */
function playwrightCacheDir(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

/**
 * The browser-automation MCP (@playwright/mcp) only needs the Chromium binary in the
 * Playwright browser cache — it bundles its own playwright runtime via npx. So a present
 * `chromium*` folder is the true capability signal, more reliable than probing for a global
 * `playwright` CLI the user may never have installed.
 */
function hasPlaywrightChromium(): boolean {
  try {
    const dir = playwrightCacheDir();
    return existsSync(dir) && readdirSync(dir).some((d) => /^chromium/.test(d));
  } catch {
    return false;
  }
}

export interface Capabilities {
  node: { ok: true; version: string };
  python: { found: boolean; path?: string; version?: string };
  z3: { found: boolean; hint: string };
  pari: { found: boolean; hint: string };
  lean: { found: boolean; hint: string };
  playwright: { found: boolean; hint: string };
}

export async function detectCapabilities(): Promise<Capabilities> {
  const caps: Capabilities = {
    node: { ok: true, version: process.version },
    python: { found: false },
    z3: { found: false, hint: 'pip install z3-solver (for deep_explore / z3Verify formal verification)' },
    pari: { found: false, hint: 'apt install pari-gp / brew install pari (for deep_explore / pariGp number-theory computation and counterexamples); or set PHILONT_GP=<path-to-gp>' },
    lean: { found: false, hint: 'install Lean 4 via elan (https://leanprover.github.io) (for deep_explore / leanCheck formal proof verification); or set PHILONT_LEAN=<path-to-lean>' },
    playwright: { found: false, hint: 'npx playwright install chromium (for PHILONT_MCP_BROWSER browser automation); or set PHILONT_PLAYWRIGHT=<path-to-playwright-cli>' },
  };

  // Read ~/.philont/.env once: PHILONT_* overrides set via the web-ui live in this file,
  // which the launcher process never loads into its own process.env.
  const fileCfg = readConfig();
  const pyCandidates = pythonCandidates(envOverride('PHILONT_PYTHON', fileCfg));

  // python: probe candidates in order and use the first one that works
  let pythonBin: string | undefined;
  for (const bin of pyCandidates) {
    const r = await probe(bin, ['--version']);
    if (r.code === 0) {
      pythonBin = bin;
      caps.python = { found: true, path: bin, version: (r.stdout + r.stderr).trim() };
      break;
    }
  }

  // z3: try `import z3` with the discovered python (z3 may be installed under a different python candidate, so try all)
  if (pythonBin) {
    for (const bin of pyCandidates) {
      const r = await probe(bin, ['-c', 'import z3']);
      if (r.code === 0) { caps.z3.found = true; break; }
    }
  }

  // pari/gp: probe `gp --version` (PHILONT_GP overrides the binary path)
  {
    const gpBin = envOverride('PHILONT_GP', fileCfg) || 'gp';
    const r = await probe(gpBin, ['--version']);
    // gp --version may return a non-zero exit code, but the output contains "GP/PARI"; checking output is more reliable
    if (/GP\/PARI|pari/i.test(r.stdout + r.stderr)) caps.pari.found = true;
  }

  // lean: probe `lean --version` (PHILONT_LEAN overrides the binary path). Output looks like
  // "Lean (version 4.x.x, ...)"; check the output text since the exit code is the reliable-enough signal.
  {
    const leanBin = envOverride('PHILONT_LEAN', fileCfg) || 'lean';
    const r = await probe(leanBin, ['--version']);
    if (r.code === 0 || /lean \(version|^lean/i.test(r.stdout + r.stderr)) caps.lean.found = true;
  }

  // playwright: the installed Chromium binary is the real signal (the MCP runs via npx and
  // uses these browsers). Check the cache dir first, then fall back to a CLI probe
  // (explicit override / global playwright / npx).
  {
    if (hasPlaywrightChromium()) {
      caps.playwright.found = true;
    } else {
      const pwBin = envOverride('PHILONT_PLAYWRIGHT', fileCfg);
      const candidates: Array<[string, string[]]> = pwBin
        ? [[pwBin, ['--version']]]
        : [['playwright', ['--version']], ['npx', ['--no-install', 'playwright', '--version']]];
      for (const [cmd, args] of candidates) {
        const r = await probe(cmd, args);
        if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) { caps.playwright.found = true; break; }
      }
    }
  }

  return caps;
}
