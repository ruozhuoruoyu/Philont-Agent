/**
 * Shared helpers for skill sources.
 */

import { createHash } from 'node:crypto';
import { parseSkillFile } from '../loader.js';
import type { SkillMeta, TrustLevel } from './types.js';

/** sha256 hex of a string. */
export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/**
 * Hash a whole bundle (entry + companions) so update checks see a changed script even when the
 * SKILL.md text is byte-identical. Order-independent: paths are sorted before hashing.
 */
export function bundleHash(entryContent: string, files: Array<{ path: string; content: string }> = []): string {
  const parts = [`SKILL.md:${sha256(entryContent)}`, ...files.map((f) => `${f.path}:${sha256(f.content)}`)].sort();
  return sha256(parts.join('\n'));
}

/** Normalize an arbitrary string into a valid skill name: [a-z0-9_-], 1-64 chars. */
export function normalizeName(raw: string): string {
  let n = raw
    .toLowerCase()
    .replace(/\.(md|markdown)$/i, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (n.length > 64) n = n.slice(0, 64).replace(/[-_]+$/g, '');
  return n || 'skill';
}

/**
 * Source tags this marketplace writes into a skill's frontmatter (`source: github:owner/repo@sha`).
 *
 * This is the ONLY durable record that philont installed a skill, and it lives in the file itself.
 * The lock file is advisory: `readLock()` returns {} for a missing OR malformed file by design, so
 * anything that treats "no lock row" as "not ours" declares every installed skill foreign the moment
 * that file is lost — which is how a corrupt lock turned every subsequent update into
 * "already exists but is not marketplace-managed", with no way back short of deleting the directory
 * by hand. Ask the artifact, not the index.
 *
 * The web-ui keeps its own copy of this rule (marketplace_model.ts) because it cannot import this
 * package; server/tests/marketplace_source_fallback.test.ts pins the two together.
 */
export const MARKETPLACE_SOURCE_PREFIX_RE = /^(github:|clawhub:|url:)/;

/**
 * Does this source tag have marketplace SHAPE?
 *
 * Shape only — never authority. Anything can write `source: github:…` (the agent-facing installSkill
 * tool takes the string verbatim), so this answers "how should the UI file this skill", not "may we
 * overwrite this directory". The overwrite decision additionally requires the installer's own marker
 * plus a matching origin; see installTool.INSTALLED_BY_KEY and sameSourceOrigin.
 */
export function isMarketplaceSourceTag(source: string | null | undefined): boolean {
  return typeof source === 'string' && MARKETPLACE_SOURCE_PREFIX_RE.test(source.trim());
}

/**
 * The origin part of a source tag, with any pinned version/sha removed:
 *   github:owner/repo@abc1234    → github:owner/repo
 *   clawhub:@publisher/skill@2.1 → clawhub:@publisher/skill
 *   url:https://host/SKILL.md    → url:https://host/SKILL.md
 *
 * A leading '@' is a publisher scope, not a version separator (the bug that once turned
 * '@openclaw/demo' into an empty slug), so only a trailing '@' outside the path counts.
 */
export function sourceOrigin(source: string | null | undefined): string | null {
  const raw = (source ?? '').trim();
  if (!raw) return null;
  const at = raw.lastIndexOf('@');
  if (at > 0 && !raw.slice(at + 1).includes('/')) return raw.slice(0, at);
  return raw;
}

/**
 * Do two source tags name the same origin? Used to decide whether an existing directory is an earlier
 * version of the thing being installed, rather than a different skill that happens to share a name.
 */
export function sameSourceOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  const oa = sourceOrigin(a);
  const ob = sourceOrigin(b);
  return oa !== null && ob !== null && oa === ob;
}

/** A lightweight User-Agent so GitHub/raw hosts don't reject the request. */
export const UA = 'philont-skill-marketplace';

/** fetch() with timeout (ms). Throws on non-2xx. Returns the response text. */
export async function fetchText(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a SKILL.md string into SkillMeta fields (name/description/version/whenToUse + zh + tags/category).
 * Reuses the loader's parseSkillFile so the size cap and frontmatter rules stay identical to load-time.
 * Throws if the body exceeds the action-template size cap.
 */
export function metaFromContent(
  content: string,
  opts: { slug: string; sourceId: string; sourceTag: string; trust: TrustLevel; nameHint?: string },
): SkillMeta {
  const parsed = parseSkillFile(content, opts.slug);
  const meta = parsed.metadata ?? {};
  const name = normalizeName(parsed.name || opts.nameHint || opts.slug);
  return {
    slug: opts.slug,
    name,
    description: parsed.description,
    version: parsed.version,
    sourceId: opts.sourceId,
    sourceTag: opts.sourceTag,
    trust: opts.trust,
    whenToUse: parsed.whenToUse || undefined,
    nameZh: (meta.name_zh as string | undefined) ?? undefined,
    descriptionZh: (meta.description_zh as string | undefined) ?? undefined,
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
    category: (meta.category as string | undefined) ?? undefined,
  };
}
