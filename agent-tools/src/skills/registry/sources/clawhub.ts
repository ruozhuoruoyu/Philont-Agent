/**
 * clawhub (openclaw) skill source — typed wrapper over the external `clawhub` CLI.
 *
 * philont already supports clawhub via a bundled policy doc that teaches the agent to shell out to
 * the CLI. This adapter makes it a programmatic, typed path instead. The CLI remains a SOFT, OPTIONAL
 * dependency: if `clawhub` is not on PATH, search returns [] (with a structured warning) and fetch
 * throws a clear error — nothing breaks.
 *
 * Trust: always 'community' (lowest). clawhub had a mass-malicious-skill incident; community + scan
 * verdict gating is mandatory.
 *
 * Availability probe — do NOT build it on another tool's flag contract.
 *   The original probe ran `clawhub --version` and required exit 0. clawhub 0.23.3 spells that flag
 *   `-V`; `--version` is an unknown option and exits 1. So the probe answered "not installed" for a
 *   CLI that WAS installed: the whole source went dark, search silently returned [], and fetch told
 *   the user to `npm i -g clawhub` — which they had already done. A liveness check must assert the
 *   thing that actually has to be true (a runnable binary on PATH), not a flag spelling that the
 *   other project is free to change. We therefore resolve the executable ourselves.
 *
 * Package shape — a clawhub skill is a BUNDLE, not a file. A real install (`@kcns008/kubernetes`)
 *   produces ~25 files (README / QUICKREF / troubleshooting/ / nested skills/*). philont installs a
 *   single SKILL.md, so `fetch` reports everything it left behind via SkillBundle.notInstalled and
 *   the caller MUST surface it. Installing 2% of a package while reporting success is exactly the
 *   silent failure this layer exists to prevent.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, stat, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, relative, sep } from 'node:path';
import type { SkillSource, SkillMeta, SkillBundle, TrustLevel, CompanionFile } from '../types.js';
import { sha256, metaFromContent, normalizeName, bundleHash } from '../shared.js';
import { applyBundleBudget } from '../bundle.js';

const TRUST: TrustLevel = 'community';
const TIMEOUT = 30_000;

/** Resolved absolute path of the clawhub executable; null = not installed. Cached after first probe. */
let cliPath: string | null | undefined;

/**
 * Characters we are willing to hand to the CLI. On Windows a `.cmd` shim can only be spawned through
 * a shell (Node refuses to spawn .cmd/.bat directly since the CVE-2024-27980 fix), and a shell means
 * arguments are re-parsed — so every argument is allowlist-checked before it can get there.
 */
const SAFE_ARG = /^[\w@.:+\-/\\ ]*$/;

/** Resolve an executable on PATH by hand (no `which` dependency, no flag contract involved). */
async function resolveOnPath(name: string): Promise<string | null> {
  const override = process.env.PHILONT_CLAWHUB_BIN?.trim();
  if (override) {
    return (await access(override, fsConstants.F_OK).then(() => true, () => false)) ? override : null;
  }

  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  // Windows: the shim is clawhub.cmd / clawhub.exe — PATHEXT lists which suffixes are executable.
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
      : [''];
  // On POSIX the file must be executable; on Windows the extension carries that meaning.
  const mode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await access(candidate, mode).then(() => true, () => false)) return candidate;
    }
  }
  return null;
}

/** Is the clawhub CLI installed? Cached after the first probe. */
export async function clawhubAvailable(): Promise<boolean> {
  if (cliPath === undefined) {
    cliPath = await resolveOnPath('clawhub').catch(() => null);
  }
  return cliPath !== null;
}

/** Test hook: forget the cached probe result (the cache is process-wide by design). */
export function resetClawhubProbe(): void {
  cliPath = undefined;
}

export class ClawhubUnavailableError extends Error {
  constructor() {
    super(
      'clawhub CLI not found on PATH (install with `npm i -g clawhub`, or set PHILONT_CLAWHUB_BIN ' +
        'to its absolute path) — cannot use the clawhub skill source',
    );
    this.name = 'ClawhubUnavailableError';
  }
}

function run(args: string[], timeoutMs = TIMEOUT): Promise<{ code: number; stdout: string; stderr: string }> {
  const bin = cliPath;
  if (!bin) return Promise.reject(new ClawhubUnavailableError());

  const unsafe = args.find((a) => !SAFE_ARG.test(a));
  if (unsafe !== undefined) {
    return Promise.reject(new Error(`refusing to pass unsafe argument to clawhub: ${JSON.stringify(unsafe)}`));
  }

  // Windows: .cmd/.bat shims require a shell. Quote every argument (all of them are allowlist-checked
  // above, so none contains a quote) so paths with spaces survive the shell's re-parse.
  const useShell = process.platform === 'win32';
  const quote = (s: string) => `"${s}"`;
  const cmd = useShell ? quote(bin) : bin;
  const finalArgs = useShell ? args.map(quote) : args;

  return new Promise((resolve) => {
    execFile(
      cmd,
      finalArgs,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: useShell, windowsHide: true },
      (err, stdout, stderr) => {
        const errno = (err as NodeJS.ErrnoException | null)?.code;
        const code = typeof errno === 'number' ? errno : err ? 1 : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/**
 * Split a clawhub identifier into slug + optional version.
 *
 * The previous implementation was `identifier.replace(/^clawhub:/, '').split('@')[0]`, which ate the
 * WHOLE slug for a publisher-scoped name: `'@kcns008/kubernetes'.split('@')[0] === ''` → the CLI was
 * called with an empty slug and answered "Slug required". Scoped names are clawhub's own primary
 * form (`clawhub install @openclaw/demo`), so this affected most real installs.
 *
 * Accepted forms: `slug`, `@publisher/slug`, `skills-sh:owner/repo/slug`, any of the above with a
 * trailing `@version`, and any of the above prefixed with `clawhub:`.
 */
export function parseClawhubIdentifier(identifier: string): { slug: string; version?: string } {
  const raw = identifier.trim().replace(/^clawhub:/, '').trim();
  // A version suffix is a trailing `@x` that is neither the leading scope marker (index 0) nor part
  // of a path segment (`skills-sh:owner/repo@ref/slug` is not a thing, but be conservative anyway).
  const at = raw.lastIndexOf('@');
  if (at > 0 && !raw.slice(at + 1).includes('/')) {
    return { slug: raw.slice(0, at), version: raw.slice(at + 1) || undefined };
  }
  return { slug: raw };
}

/** Strip anything the CLI argument allowlist would reject out of a free-text search query. */
export function sanitizeQuery(query: string): string {
  return query.replace(/[^\w@.:+\-/\\ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Find the SKILL.md to install inside an installed package.
 *
 * Deterministic on purpose: a bundle can carry several (the k8s package has 8 — one at the root plus
 * seven under skills/*). Picking "whatever readdir yielded first" made the installed skill depend on
 * filesystem ordering. Prefer the shallowest, then the lexicographically smallest path.
 */
export async function findSkillMd(dir: string): Promise<string | null> {
  const candidates: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(current, e);
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.isFile() && /^SKILL\.md$/i.test(e)) candidates.push(full);
      else if (s.isDirectory()) await walk(full);
    }
  }

  await walk(dir);
  if (!candidates.length) return null;

  const depth = (p: string) => relative(dir, p).split(sep).length;
  candidates.sort((a, b) => depth(a) - depth(b) || relative(dir, a).localeCompare(relative(dir, b)));
  return candidates[0];
}

/** Every file under `dir`, as paths relative to it (posix separators). Exported for tests. */
export async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/**
 * Parse `clawhub search`'s human-readable table.
 *
 * The adapter used to ask for `--json`, which clawhub 0.23.3's search subcommand does not have (only
 * --limit/--prefix/--exact/--cursor); the CLI exited 1 on the unknown option and this source returned
 * an empty list — so the marketplace's ONLY keyword path silently found nothing, even with the CLI
 * correctly installed. Until an upstream machine-readable format exists, the table is what there is.
 *
 * Observed shape (columns separated by 2+ spaces, no header, no ANSI):
 *   kubernetes         @kcns008      Kubernetes Agent Swarm  6 installs / 60d
 *
 * Parsing is defensive on purpose: a line that does not match this shape is skipped rather than
 * guessed at, so a future format change degrades to "fewer results", not to wrong slugs.
 */
export function parseSearchTable(stdout: string): Array<{ slug: string; publisher?: string; description: string }> {
  const out: Array<{ slug: string; publisher?: string; description: string }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    // strip ANSI, in case a future version colourises the output
    const line = raw.replace(/\[[0-9;]*m/g, '').trimEnd();
    if (!line.trim()) continue;
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const slug = cols[0];
    if (!/^[\w.-]+$/.test(slug)) continue; // not a slug column → not a result row
    const publisher = cols[1]?.startsWith('@') ? cols[1] : undefined;
    if (!publisher) continue; // every result row carries a publisher; anything else is banner text
    const rest = cols.slice(2).filter((c) => !/^\d+\s+installs?\b/.test(c));
    out.push({ slug, publisher, description: rest.join(' — ') });
  }
  return out;
}

export const clawhubSource: SkillSource = {
  sourceId: 'clawhub',
  trustLevel: () => TRUST,

  async search(query: string, limit: number): Promise<SkillMeta[]> {
    if (!(await clawhubAvailable())) return [];
    const q = sanitizeQuery(query);
    if (!q) return [];
    const { code, stdout } = await run(['search', q, '--limit', String(limit)]).catch(() => ({
      code: 1,
      stdout: '',
      stderr: '',
    }));
    if (code !== 0) return [];

    // Accept a machine-readable answer if a future CLI starts emitting one; otherwise parse the table.
    // Sniffing the payload beats probing for a flag — that coupling is what broke this source twice.
    const trimmed = stdout.trim();
    const rows = trimmed.startsWith('[')
      ? (() => {
          try {
            const arr = JSON.parse(trimmed);
            return Array.isArray(arr)
              ? arr.map((r: Record<string, unknown>) => ({
                  slug: String(r.slug ?? r.name ?? ''),
                  publisher: r.publisher != null ? String(r.publisher) : undefined,
                  description: String(r.description ?? ''),
                }))
              : [];
          } catch {
            return [];
          }
        })()
      : parseSearchTable(stdout);

    return rows
      .filter((r) => r.slug)
      .slice(0, limit)
      .map((r): SkillMeta => {
        // Install by the fully-qualified name when we know the publisher: a bare slug can be ambiguous,
        // and '@publisher/slug' is clawhub's own canonical identifier.
        const identifier = r.publisher ? `${r.publisher}/${r.slug}` : r.slug;
        return {
          slug: identifier,
          name: normalizeName(r.slug),
          description: r.description,
          sourceId: 'clawhub',
          sourceTag: `clawhub:${identifier}`,
          trust: TRUST,
        };
      });
  },

  async inspect(identifier: string): Promise<SkillMeta | null> {
    try {
      const bundle = await this.fetch(identifier);
      return bundle.meta;
    } catch {
      return null;
    }
  },

  async fetch(identifier: string): Promise<SkillBundle> {
    if (!(await clawhubAvailable())) throw new ClawhubUnavailableError();

    const { slug, version } = parseClawhubIdentifier(identifier);
    if (!slug) throw new Error(`clawhub: empty slug in identifier ${JSON.stringify(identifier)}`);

    const tmp = await mkdtemp(join(tmpdir(), 'philont-clawhub-'));
    try {
      const args = ['install', slug, '--dir', tmp];
      if (version) args.push('--version', version);
      const { code, stderr } = await run(args);
      if (code !== 0) throw new Error(`clawhub install ${slug} failed: ${stderr.slice(0, 300)}`);

      const skillMd = await findSkillMd(tmp);
      if (!skillMd) throw new Error(`clawhub install ${slug}: no SKILL.md produced`);
      const content = await readFile(skillMd, 'utf-8');

      // A clawhub package is a bundle. Take the companions the budget allows, report the rest.
      // clawhub installs into <dir>/<slug>/, so paths are relative to that package root.
      const installedRel = relative(tmp, skillMd).split(sep).join('/');
      const pkgPrefix = installedRel.includes('/') ? installedRel.slice(0, installedRel.lastIndexOf('/') + 1) : '';
      const strip = (p: string) => (pkgPrefix && p.startsWith(pkgPrefix) ? p.slice(pkgPrefix.length) : p);
      const others = (await listFiles(tmp)).filter((f) => f !== installedRel);

      const candidates = await Promise.all(
        others.map(async (f) => ({
          path: strip(f),
          abs: join(tmp, ...f.split('/')),
          size: (await stat(join(tmp, ...f.split('/'))).catch(() => null))?.size ?? 0,
        })),
      );
      const budget = applyBundleBudget(candidates);

      const files: CompanionFile[] = [];
      const dropped = [...budget.dropped];
      for (const c of budget.kept) {
        try {
          files.push({ path: c.path, content: await readFile(c.abs, 'utf-8') });
        } catch (e) {
          dropped.push(`${c.path} (read failed: ${(e as Error).message.slice(0, 60)})`);
        }
      }

      const sourceTag = `clawhub:${slug}${version ? '@' + version : ''}`;
      const meta = metaFromContent(content, {
        slug,
        sourceId: 'clawhub',
        sourceTag,
        trust: TRUST,
        nameHint: normalizeName(slug),
      });
      return {
        meta,
        content,
        contentHash: sha256(content),
        installedEntry: strip(installedRel),
        files: files.length ? files : undefined,
        bundleHash: bundleHash(content, files),
        notInstalled: dropped.length ? { total: dropped.length, sample: dropped.slice(0, 8) } : undefined,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};
