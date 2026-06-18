/**
 * Skill marketplace (aggregator client) — shared types.
 *
 * The marketplace is an AGGREGATOR CLIENT, not a hosted platform: it searches and installs
 * SKILL.md from external sources (git/raw-URL, clawhub) behind a typed `SkillSource` interface,
 * runs a content safety scan + trust×verdict gate, then writes through the existing installSkill
 * primitive. No backend, no accounts, no uploads.
 *
 * v1 sources: git/url + clawhub (both `community`). v2 adds an `official` curated static index
 * (the `official` trust level + index source are reserved here so adding them is push-only).
 */

/** Trust tier of a source. `official` is reserved for the v2 curated index; v1 sources are all `community`. */
export type TrustLevel = 'official' | 'community';

/** Safety scan verdict for a SKILL.md body. */
export type Verdict = 'safe' | 'caution' | 'dangerous';

/** Install-time gate outcome derived from (trust × verdict). */
export type GateDecision = 'allow' | 'ask' | 'block';

/** A skill as surfaced by search/inspect (metadata only, no body). */
export interface SkillMeta {
  /** Source-local identifier (slug / repo path / url). */
  slug: string;
  /** Normalized install name [a-z0-9_-], 1-64 chars. */
  name: string;
  description: string;
  version?: string;
  /** Which source produced this ('git' | 'clawhub' | 'official'). */
  sourceId: string;
  /** Canonical frontmatter source tag, e.g. 'github:owner/repo@<sha7>' / 'clawhub:slug@ver' / 'url:<url>'. */
  sourceTag: string;
  trust: TrustLevel;
  homepage?: string;
  whenToUse?: string;
  nameZh?: string;
  descriptionZh?: string;
  tags?: string[];
  category?: string;
}

/** A fetched skill ready for the install pipeline (metadata + full SKILL.md text). */
export interface SkillBundle {
  meta: SkillMeta;
  /** Full SKILL.md text (frontmatter + body). */
  content: string;
  /** sha256(content), hex. */
  contentHash: string;
}

/**
 * A skill source adapter. Each external registry implements this; the router fans search/fetch
 * across all registered sources. Adding a source = implement this + push into the router array.
 */
export interface SkillSource {
  readonly sourceId: string;
  trustLevel(): TrustLevel;
  /** Best-effort search. Must NOT throw on a transient/unavailable source — return [] instead. */
  search(query: string, limit: number): Promise<SkillMeta[]>;
  /** Resolve metadata for an identifier without downloading the full body (may fetch if cheaper). */
  inspect(identifier: string): Promise<SkillMeta | null>;
  /** Download the full SKILL.md bundle. May throw on a hard failure (404 / integrity mismatch). */
  fetch(identifier: string): Promise<SkillBundle>;
}

/** One scanner hit. */
export interface ScanHit {
  category: 'exfiltration' | 'rce' | 'persistence' | 'obfuscation' | 'secret_access';
  pattern: string;
  line: number;
  excerpt: string;
}

/** Scanner report. */
export interface ScanReport {
  verdict: Verdict;
  hits: ScanHit[];
}

/** A provenance record persisted to .philont/skills.lock.json. */
export interface ProvenanceRecord {
  name: string;
  sourceId: string;
  /** Original source-local identifier (url / owner/repo:path@ref / slug) — needed to re-fetch on update. */
  identifier: string;
  sourceTag: string;
  trust: TrustLevel;
  /** sha256 of the installed SKILL.md content. */
  contentHash: string;
  version?: string;
  verdict: Verdict;
  decision: GateDecision;
  /** Who confirmed an `ask`-gated install ('user' | 'agent'), or null when allowed outright. */
  confirmedBy?: 'user' | 'agent' | null;
  /** ISO timestamp. */
  installedAt: string;
  /** Absolute file paths written. */
  paths: string[];
}

/** Result of an install/update attempt. */
export interface InstallOutcome {
  status: 'installed' | 'ask' | 'blocked' | 'error';
  name?: string;
  sourceTag?: string;
  verdict?: Verdict;
  decision?: GateDecision;
  report?: ScanReport;
  provenance?: ProvenanceRecord;
  error?: string;
}

/** Update-check status for one installed skill. */
export interface UpdateStatus {
  name: string;
  sourceTag: string;
  /** Currently installed content hash (from the lock file). */
  currentHash: string;
  /** Latest content hash from the source, or null if it could not be fetched. */
  latestHash: string | null;
  latestVersion?: string;
  changed: boolean;
}
