/**
 * Multi-source router: fans search across all registered sources and resolves a source by id.
 *
 * v1 sources (priority = trust order): git, clawhub. v2 inserts `official` at the front.
 * Adding a source = implement SkillSource + push it here.
 */

import type { SkillSource, SkillMeta, SkillBundle } from './types.js';
import { gitSource } from './sources/git.js';
import { clawhubSource } from './sources/clawhub.js';

export const SOURCES: SkillSource[] = [gitSource, clawhubSource];

const SEARCH_TIMEOUT = (() => {
  const n = parseInt(process.env.PHILONT_SKILL_SEARCH_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

const TRUST_RANK: Record<string, number> = { official: 0, community: 1 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('source search timed out')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface SearchResult {
  results: SkillMeta[];
  warnings: string[];
}

/** Search all sources concurrently with per-source timeouts; merge, dedupe by name, sort by trust. */
export async function searchAll(query: string, perSourceLimit = 10): Promise<SearchResult> {
  const warnings: string[] = [];
  const settled = await Promise.allSettled(
    SOURCES.map((s) => withTimeout(s.search(query, perSourceLimit), SEARCH_TIMEOUT)),
  );

  const merged: SkillMeta[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      merged.push(...r.value);
    } else {
      warnings.push(`source '${SOURCES[i].sourceId}' failed: ${r.reason?.message ?? r.reason}`);
    }
  });

  // dedupe by name, keep the higher-trust occurrence
  const byName = new Map<string, SkillMeta>();
  for (const m of merged) {
    const existing = byName.get(m.name);
    if (!existing || (TRUST_RANK[m.trust] ?? 9) < (TRUST_RANK[existing.trust] ?? 9)) {
      byName.set(m.name, m);
    }
  }

  const results = Array.from(byName.values()).sort(
    (a, b) => (TRUST_RANK[a.trust] ?? 9) - (TRUST_RANK[b.trust] ?? 9),
  );
  return { results, warnings };
}

export function resolveSource(sourceId: string): SkillSource | null {
  return SOURCES.find((s) => s.sourceId === sourceId) ?? null;
}

export async function fetchFrom(sourceId: string, identifier: string): Promise<SkillBundle> {
  const src = resolveSource(sourceId);
  if (!src) throw new Error(`unknown skill source '${sourceId}'`);
  return src.fetch(identifier);
}

export async function inspectFrom(sourceId: string, identifier: string): Promise<SkillMeta | null> {
  const src = resolveSource(sourceId);
  if (!src) throw new Error(`unknown skill source '${sourceId}'`);
  return src.inspect(identifier);
}
