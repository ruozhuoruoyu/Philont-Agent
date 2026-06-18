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

import type { SkillSource, SkillMeta, SkillBundle, TrustLevel } from '../types.js';
import { sha256, fetchText, metaFromContent, normalizeName, UA } from '../shared.js';

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

/** Resolve a branch/HEAD ref to a concrete commit SHA via the GitHub API. Returns null on failure. */
async function resolveSha(repo: string, ref: string): Promise<string | null> {
  // Already a full/short SHA → use as-is.
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return ref;
  try {
    const json = await fetchText(
      `https://api.github.com/repos/${repo}/commits/${ref}`,
      TIMEOUT,
      { Accept: 'application/vnd.github+json' },
    );
    const sha = JSON.parse(json)?.sha;
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
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
      content = await fetchText(r.rawUrl, TIMEOUT, { 'User-Agent': UA });
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
    const content = await fetchText(r.rawUrl, TIMEOUT, { 'User-Agent': UA });
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
    return { meta, content, contentHash: sha256(content) };
  },
};
