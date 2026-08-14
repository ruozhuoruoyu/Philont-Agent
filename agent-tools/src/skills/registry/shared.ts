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
