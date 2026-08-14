/**
 * git / raw-URL skill source.
 *
 * Replaces the non-operational `github-skills` placeholder with a real, typed adapter. Supported
 * identifier forms:
 *   1. Raw SKILL.md URL:        https://host/.../SKILL.md   (or any *.md)        → url:<url>
 *   2. raw.githubusercontent:   https://raw.githubusercontent.com/o/r/ref/path  → github:o/r@<sha7>
 *   3. GitHub blob URL:         https://github.com/o/r/blob/ref/path/SKILL.md   → github:o/r@<sha7>
 *   4. Shorthand:               o/r[:path][@ref]   (path default SKILL.md, ref default HEAD) → github:o/r@<sha7>
 *
 * MVP scope: raw-URL GET + GitHub-API SHA resolution only. Arbitrary `git clone` of non-GitHub hosts
 * is intentionally NOT done here (heavier/riskier); add behind an explicit flag later if needed.
 *
 * Trust: always 'community'. Content is scanned + gated by the install pipeline, not here.
 */

import type { SkillSource, SkillMeta, SkillBundle, TrustLevel, CompanionFile } from '../types.js';
import { sha256, fetchText, metaFromContent, normalizeName, UA, bundleHash } from '../shared.js';
import { applyBundleBudget } from '../bundle.js';

const TIMEOUT = (() => {
  const n = parseInt(process.env.PHILONT_SKILL_SEARCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

interface Resolved {
  rawUrl: string;
  /** owner/repo when this is a GitHub identifier, else null. */
  repo: string | null;
  /** ref (branch/tag/sha) when known, else null. */
  ref: string | null;
  /** path within the repo when known. */
  path: string | null;
  /** name hint derived from the path/repo. */
  nameHint: string;
}

/** Does this string look like something this source can install? */
function isGitIdentifier(s: string): boolean {
  const t = s.trim();
  if (/^https?:\/\//i.test(t)) return true;
  // shorthand owner/repo[...]
  return /^[\w.-]+\/[\w.-]+(?:[:@].*)?$/.test(t);
}

function lastPathSegment(p: string): string {
  const parts = p.split('/').filter(Boolean);
  // prefer the directory name when the file is SKILL.md
  const file = parts[parts.length - 1] || '';
  if (/^SKILL\.md$/i.test(file) && parts.length >= 2) return parts[parts.length - 2];
  return file.replace(/\.(md|markdown)$/i, '') || file;
}

/** Resolve an identifier to a concrete raw URL (+ repo/ref/path metadata). Does not download the body. */
async function resolveIdentifier(identifier: string): Promise<Resolved> {
  const id = identifier.trim();

  // (3) GitHub blob URL
  const blob = id.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i);
  if (blob) {
    const [, owner, repo, ref, path] = blob;
    return {
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      repo: `${owner}/${repo}`,
      ref,
      path,
      nameHint: lastPathSegment(path),
    };
  }

  // (2) raw.githubusercontent URL
  const raw = id.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (raw) {
    const [, owner, repo, ref, path] = raw;
    return { rawUrl: id, repo: `${owner}/${repo}`, ref, path, nameHint: lastPathSegment(path) };
  }

  // (1) any other URL → treat as a direct raw fetch
  if (/^https?:\/\//i.test(id)) {
    return { rawUrl: id, repo: null, ref: null, path: null, nameHint: lastPathSegment(new URL(id).pathname) };
  }

  // (4) shorthand owner/repo[:path][@ref]
  const m = id.match(/^([\w.-]+)\/([\w.-]+?)(?::([^@]+))?(?:@(.+))?$/);
  if (!m) throw new Error(`unrecognized git identifier: ${identifier}`);
  const owner = m[1];
  const repo = m[2];
  const path = (m[3] || 'SKILL.md').replace(/^\/+/, '');
  const ref = m[4] || 'HEAD';
  return {
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
    repo: `${owner}/${repo}`,
    ref,
    path,
    nameHint: lastPathSegment(path),
  };
}

/**
 * Auth for GitHub requests, when a token is available.
 *
 * Unauthenticated api.github.com allows 60 requests/hour per IP. Past that, sha resolution fails —
 * and it failed SILENTLY, degrading `github:owner/repo@<sha7>` to `github:owner/repo@HEAD`, i.e. a
 * provenance record that pins nothing while looking like it does. A token raises the limit and also
 * makes private repositories reachable.
 */
function githubHeaders(): Record<string, string> {
  const token = (process.env.PHILONT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Resolve a branch/HEAD ref to a concrete commit SHA via the GitHub API. Returns null on failure —
 * and says so out loud, because an unpinned provenance record is worth knowing about.
 */
async function resolveSha(repo: string, ref: string): Promise<string | null> {
  // Already a full/short SHA → use as-is.
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return ref;
  try {
    const json = await fetchText(
      `https://api.github.com/repos/${repo}/commits/${ref}`,
      TIMEOUT,
      { Accept: 'application/vnd.github+json', ...githubHeaders() },
    );
    const sha = JSON.parse(json)?.sha;
    if (typeof sha === 'string') return sha;
    return null;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.warn(
      `[skill-registry] could not pin ${repo}@${ref} to a commit sha (${msg}); ` +
        (/HTTP 403|rate limit/i.test(msg)
          ? 'GitHub rate limit — set PHILONT_GITHUB_TOKEN to raise it. '
          : '') +
        'provenance will record the mutable ref instead of an immutable commit.',
    );
    return null;
  }
}

/**
 * List the other files sitting next to a SKILL.md in its repo directory.
 *
 * philont writes the SKILL.md only, but real skills are bundles: in anthropics/skills, `skills/pdf`
 * ships forms.md + reference.md + 8 python scripts that the SKILL.md text tells the agent to read and
 * run. Fetching just the markdown yields an install that reports success and cannot work. We cannot
 * fix that by silence, so the gap is measured here and reported through SkillBundle.notInstalled.
 *
 * Uses the subtree form of the GitHub trees API (`trees/<ref>:<dir>`), which returns only this skill's
 * directory instead of the whole repo. Best-effort: any failure (rate limit, private repo, non-GitHub
 * host) returns null and the caller simply has nothing extra to report.
 */
async function listSiblings(
  repo: string,
  ref: string,
  dir: string,
  selfFile: string,
): Promise<Array<{ path: string; size: number }> | null> {
  if (!dir) return null; // SKILL.md at the repo root: the "directory" is the whole repo, not a bundle
  try {
    const json = await fetchText(
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}:${dir}?recursive=1`,
      TIMEOUT,
      { Accept: 'application/vnd.github+json', ...githubHeaders() },
    );
    const tree = JSON.parse(json)?.tree;
    if (!Array.isArray(tree)) return null;
    return tree
      .filter((e: { type?: string; path?: string }) => e?.type === 'blob' && typeof e.path === 'string')
      .map((e: { path: string; size?: number }) => ({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 }))
      .filter((e: { path: string }) => e.path !== selfFile)
      .sort((a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path));
  } catch {
    return null;
  }
}

/** Download the companion files the budget kept. A file that fails to download is reported, not fatal. */
async function fetchCompanions(
  repo: string,
  ref: string,
  dir: string,
  kept: Array<{ path: string }>,
): Promise<{ files: CompanionFile[]; failed: string[] }> {
  const files: CompanionFile[] = [];
  const failed: string[] = [];
  for (const c of kept) {
    try {
      const text = await fetchText(
        `https://raw.githubusercontent.com/${repo}/${ref}/${dir}/${c.path}`,
        TIMEOUT,
        { 'User-Agent': UA, ...githubHeaders() },
      );
      files.push({ path: c.path, content: text });
    } catch (e) {
      failed.push(`${c.path} (download failed: ${(e as Error).message.slice(0, 60)})`);
    }
  }
  return { files, failed };
}

function buildSourceTag(r: Resolved, sha: string | null): string {
  if (r.repo) {
    const short = sha ? sha.slice(0, 7) : r.ref ?? 'HEAD';
    return `github:${r.repo}@${short}`;
  }
  return `url:${r.rawUrl}`;
}

const TRUST: TrustLevel = 'community';

export const gitSource: SkillSource = {
  sourceId: 'git',
  trustLevel: () => TRUST,

  async search(query: string): Promise<SkillMeta[]> {
    // No registry to search; if the query is itself an installable identifier, surface it as one result.
    if (!isGitIdentifier(query)) return [];
    try {
      const meta = await this.inspect(query);
      return meta ? [meta] : [];
    } catch {
      return [];
    }
  },

  async inspect(identifier: string): Promise<SkillMeta | null> {
    const r = await resolveIdentifier(identifier);
    let content: string;
    try {
      content = await fetchText(r.rawUrl, TIMEOUT, { 'User-Agent': UA, ...githubHeaders() });
    } catch {
      return null;
    }
    const sha = r.repo && r.ref ? await resolveSha(r.repo, r.ref) : null;
    return metaFromContent(content, {
      slug: identifier,
      sourceId: 'git',
      sourceTag: buildSourceTag(r, sha),
      trust: TRUST,
      nameHint: normalizeName(r.nameHint),
    });
  },

  async fetch(identifier: string): Promise<SkillBundle> {
    const r = await resolveIdentifier(identifier);
    const content = await fetchText(r.rawUrl, TIMEOUT, { 'User-Agent': UA, ...githubHeaders() });
    // basic shape validation (mirrors the github-skills policy doc)
    if (!content.startsWith('---')) throw new Error('not a SKILL.md (missing frontmatter)');
    const sha = r.repo && r.ref ? await resolveSha(r.repo, r.ref) : null;
    const meta = metaFromContent(content, {
      slug: identifier,
      sourceId: 'git',
      sourceTag: buildSourceTag(r, sha),
      trust: TRUST,
      nameHint: normalizeName(r.nameHint),
    });

    // Bring the rest of the bundle along, under the budget, and report whatever the budget dropped.
    let files: CompanionFile[] = [];
    let dropped: string[] = [];
    if (r.repo && r.path) {
      const lastSlash = r.path.lastIndexOf('/');
      const dir = lastSlash >= 0 ? r.path.slice(0, lastSlash) : '';
      const file = lastSlash >= 0 ? r.path.slice(lastSlash + 1) : r.path;
      const ref = sha ?? r.ref ?? 'HEAD';
      const siblings = await listSiblings(r.repo, ref, dir, file);
      if (siblings?.length) {
        const budget = applyBundleBudget(siblings);
        const fetched = await fetchCompanions(r.repo, ref, dir, budget.kept);
        files = fetched.files;
        dropped = [...budget.dropped, ...fetched.failed];
      }
    }

    return {
      meta,
      content,
      contentHash: sha256(content),
      installedEntry: r.path ?? undefined,
      files: files.length ? files : undefined,
      bundleHash: bundleHash(content, files),
      notInstalled: dropped.length ? { total: dropped.length, sample: dropped.slice(0, 8) } : undefined,
    };
  },
};
