/**
 * Bundle budget: which companion files a skill install is allowed to bring along.
 *
 * Why this file exists. philont used to install exactly one file, the SKILL.md — but a skill is a
 * bundle: 16 of the 18 skills in anthropics/skills ship scripts/ or reference/ files, and their
 * SKILL.md text says things like "read FORMS.md" and "run scripts/fill_fillable_fields.py". Installing
 * the markdown alone produced a skill that reported success and could not work. Fetching everything is
 * not the answer either: one skill in that same repo carries 83 files and 5.5 MB of fonts.
 *
 * So companions come in under an explicit budget, and **whatever the budget drops is reported**, never
 * silently truncated — a partial install the user knows about is a different thing from one they don't.
 *
 * Budget (deliberately small; raise only with a reason):
 *   - ≤ 30 files
 *   - ≤ 2 MB total, ≤ 512 KB per file
 *   - text-ish extensions only: docs, scripts and data the agent can actually read or run. Fonts,
 *     images, archives and binaries are named in the report but never downloaded.
 */

/** Maximum number of companion files written alongside SKILL.md. */
export const MAX_BUNDLE_FILES = 30;
/** Maximum total bytes of companion files. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
/** Maximum bytes for a single companion file. */
export const MAX_COMPANION_BYTES = 512 * 1024;

/** Extensions we are willing to install next to a SKILL.md. */
const ALLOWED_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.ps1', '.rb', '.pl', '.r', '.lua', '.sql',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.csv', '.tsv', '.xml',
  '.html', '.css', '.tmpl', '.template', '.env-example',
]);

/** Files never installed regardless of extension (bookkeeping of the source registry). */
const EXCLUDED_PATH = /(^|\/)(\.git|\.github|\.clawhub|node_modules|__pycache__)(\/|$)/;

export interface CompanionCandidate {
  /** Path relative to the skill directory, posix separators. */
  path: string;
  /** Byte size, when the source knows it up front (GitHub tree gives it; a local dir gives it too). */
  size?: number;
}

export interface BudgetResult<T extends CompanionCandidate> {
  kept: T[];
  /** Paths not installed, with the reason, e.g. "assets/font.ttf (binary)". */
  dropped: string[];
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

/** Is this path eligible at all (ignoring size/count budget)? */
export function isInstallableCompanion(path: string): boolean {
  if (EXCLUDED_PATH.test(path)) return false;
  if (/^SKILL\.md$/i.test(path)) return false; // the entry file is written separately
  return ALLOWED_EXT.has(extOf(path));
}

/**
 * Apply the budget to a candidate list. Deterministic: shallower paths first, then alphabetical, so
 * the files a SKILL.md is most likely to reference (siblings, then scripts/) win the budget over deep
 * incidental content — and two runs of the same install produce the same result.
 */
export function applyBundleBudget<T extends CompanionCandidate>(candidates: T[]): BudgetResult<T> {
  const kept: T[] = [];
  const dropped: string[] = [];

  const ordered = [...candidates].sort((a, b) => {
    const da = a.path.split('/').length;
    const db = b.path.split('/').length;
    return da - db || a.path.localeCompare(b.path);
  });

  let bytes = 0;
  for (const c of ordered) {
    if (EXCLUDED_PATH.test(c.path)) {
      // Registry bookkeeping, not part of the skill. Reported for completeness, with the right reason:
      // labelling it "not an installable file type" sends the reader looking for a format problem.
      dropped.push(`${c.path} (source-registry bookkeeping)`);
      continue;
    }
    if (!isInstallableCompanion(c.path)) {
      dropped.push(`${c.path} (not an installable file type)`);
      continue;
    }
    if (c.size !== undefined && c.size > MAX_COMPANION_BYTES) {
      dropped.push(`${c.path} (${Math.round(c.size / 1024)} KB > per-file limit)`);
      continue;
    }
    if (kept.length >= MAX_BUNDLE_FILES) {
      dropped.push(`${c.path} (over the ${MAX_BUNDLE_FILES}-file limit)`);
      continue;
    }
    if (c.size !== undefined && bytes + c.size > MAX_BUNDLE_BYTES) {
      dropped.push(`${c.path} (over the ${Math.round(MAX_BUNDLE_BYTES / 1024)} KB total limit)`);
      continue;
    }
    bytes += c.size ?? 0;
    kept.push(c);
  }

  return { kept, dropped };
}
