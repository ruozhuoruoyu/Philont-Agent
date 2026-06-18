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
 * NOTE: clawhub CLI output format varies by version. search tries `--json` and parses an array; if the
 * installed CLI doesn't support it, search degrades to []. fetch installs by exact slug into a temp dir
 * and reads the resulting SKILL.md, which is version-robust.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillSource, SkillMeta, SkillBundle, TrustLevel } from '../types.js';
import { sha256, metaFromContent, normalizeName } from '../shared.js';

const TRUST: TrustLevel = 'community';
const TIMEOUT = 30_000;

let cliAvailable: boolean | null = null;

function run(args: string[], timeoutMs = TIMEOUT): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('clawhub', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err ? 1 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** Is the clawhub CLI installed? Cached after first check. */
export async function clawhubAvailable(): Promise<boolean> {
  if (cliAvailable !== null) return cliAvailable;
  try {
    const { code } = await run(['--version'], 5000);
    cliAvailable = code === 0;
  } catch {
    cliAvailable = false;
  }
  return cliAvailable;
}

/** Recursively find the first SKILL.md under a directory. */
async function findSkillMd(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isFile() && /^SKILL\.md$/i.test(e)) return full;
    if (s.isDirectory()) {
      const found = await findSkillMd(full);
      if (found) return found;
    }
  }
  return null;
}

export const clawhubSource: SkillSource = {
  sourceId: 'clawhub',
  trustLevel: () => TRUST,

  async search(query: string, limit: number): Promise<SkillMeta[]> {
    if (!(await clawhubAvailable())) return [];
    const { code, stdout } = await run(['search', query, '--limit', String(limit), '--json']);
    if (code !== 0) return [];
    try {
      const arr = JSON.parse(stdout);
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, limit).map((r: Record<string, unknown>): SkillMeta => {
        const slug = String(r.slug ?? r.name ?? '');
        const version = r.version != null ? String(r.version) : undefined;
        return {
          slug,
          name: normalizeName(slug),
          description: String(r.description ?? ''),
          version,
          sourceId: 'clawhub',
          sourceTag: `clawhub:${slug}${version ? '@' + version : ''}`,
          trust: TRUST,
          tags: Array.isArray(r.tags) ? (r.tags as string[]) : undefined,
        };
      }).filter((m) => m.slug);
    } catch {
      return [];
    }
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
    if (!(await clawhubAvailable())) {
      throw new Error('clawhub CLI not installed (npm i -g clawhub) — cannot fetch clawhub skill');
    }
    const slug = identifier.replace(/^clawhub:/, '').split('@')[0];
    const tmp = await mkdtemp(join(tmpdir(), 'philont-clawhub-'));
    try {
      const { code, stderr } = await run(['install', slug, '--dir', tmp]);
      if (code !== 0) throw new Error(`clawhub install ${slug} failed: ${stderr.slice(0, 300)}`);
      const skillMd = await findSkillMd(tmp);
      if (!skillMd) throw new Error(`clawhub install ${slug}: no SKILL.md produced`);
      const content = await readFile(skillMd, 'utf-8');
      const meta = metaFromContent(content, {
        slug,
        sourceId: 'clawhub',
        sourceTag: `clawhub:${slug}`,
        trust: TRUST,
        nameHint: normalizeName(slug),
      });
      return { meta, content, contentHash: sha256(content) };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};
