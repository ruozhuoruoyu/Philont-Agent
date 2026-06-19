/**
 * Environment variable loading (must be imported first) — 2026-05-30
 *
 * Uses `dotenv.config({ override: true })` so that `.env` **authoritatively overrides**
 * same-named environment variables that already exist in the shell/system environment.
 *
 * Why a separate module: ES module `import` statements are all hoisted and evaluated before
 * the module body, so writing `import dotenv from 'dotenv'; dotenv.config(...)` directly in
 * index.ts would cause config() to run **after** other imports (e.g. chat-handler reading
 * LLM_PROVIDER / ANTHROPIC_* / MEMORY_DB_PATH at module init) — too late. Extracting this
 * as a side-effect module that is listed first causes ES modules to evaluate in order: this
 * module (including config()) completes first, then the next import is loaded.
 *
 * Why override: the original `import 'dotenv/config'` **does not override** existing
 * process.env by default, causing stale system-level `ANTHROPIC_BASE_URL` values (e.g. a
 * neolink gateway URL) to shadow the actual value in .env, sending LLM requests to the wrong
 * endpoint (neolink_error 401). override eliminates this footgun entirely.
 */
import dotenv from 'dotenv';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// PHILONT_ENV_FILE: explicitly specifies the .env file path. The launcher (supervisor) uses
// this to point the agent at ~/.philont/.env — after packaging, cwd is not reliable, so the
// "cwd/.env" convention cannot be assumed. When not set, falls back to the default behaviour
// (reads cwd/.env); running `tsx src/index.ts` in dev is completely unaffected.
const explicitPath = process.env.PHILONT_ENV_FILE;

// override:true → .env overrides same-named variables already in the shell/system environment.
// Print the result for diagnosing "why is .env not taking effect" (file not found / wrong
// cwd / zero variables parsed).
const result = dotenv.config(explicitPath ? { override: true, path: explicitPath } : { override: true });
const source = explicitPath ?? `${process.cwd()}/.env`;
if (result.error) {
  console.warn(`[env] .env not loaded (${source}): ${result.error.message}`);
} else {
  const n = result.parsed ? Object.keys(result.parsed).length : 0;
  const hasAnthropic = !!result.parsed?.ANTHROPIC_API_KEY;
  console.log(
    `[env] .env loaded (override): ${n} variable(s), source=${source}, contains ANTHROPIC_API_KEY=${hasAnthropic}`,
  );
}

// ── Activate philont's managed Python venv ───────────────────────────────────
// Tools run bare `python` / `pip` via the shell, which resolves through PATH. The managed venv
// (built by scripts/setup-python-env) holds the document/z3 libraries, but its interpreter is not
// on PATH by default, so `python` would hit a system Python without those libs (observed in prod:
// `import pypdf` fails, the agent then pip-installs at runtime → flood / wrong interpreter).
// Prepend the venv's bin/Scripts dir to PATH here so bare `python`/`pip` transparently resolve to
// the venv for every child process (shell tool, z3, etc.) — i.e. venv "activation".
let managedPython = process.env.PHILONT_PYTHON;
if (!managedPython) {
  // Fallback when launched without start.(ps1|sh): read the manifest the setup script wrote.
  try {
    const manifest = join(homedir(), '.philont', 'python-env.json');
    if (existsSync(manifest)) {
      const pp = (JSON.parse(readFileSync(manifest, 'utf8')) as { pythonPath?: string }).pythonPath;
      if (pp && existsSync(pp)) {
        managedPython = pp;
        process.env.PHILONT_PYTHON = pp;
      }
    }
  } catch {
    /* manifest missing / unreadable → no managed venv; tools fall back to system python */
  }
}
if (managedPython && existsSync(managedPython)) {
  const binDir = dirname(managedPython);
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = (process.env.PATH ?? '').split(sep);
  if (!parts.includes(binDir)) {
    process.env.PATH = binDir + sep + (process.env.PATH ?? '');
    console.log(`[env] managed Python venv on PATH: ${binDir}`);
  }
}
