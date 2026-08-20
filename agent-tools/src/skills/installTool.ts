/**
 * installSkill / uninstallSkill tools
 *
 * Kernel mechanism layer (mechanism, not policy): provides general primitives for "install/uninstall SKILL.md".
 * How to discover new skills / which registry to pull from is the SKILL.md (policy layer)'s own concern —
 * the factory-bundled `clawhub` / `github-skills` SKILL.md teaches the agent to use each CLI/API,
 * then uses these two tools to write the result into .philont/skills/.
 *
 * Design notes:
 *   - These two tools do **not call SkillStore directly**; they only touch the filesystem.
 *     DB consistency is guaranteed by server/chat-handler's reload-prune path (fs watcher
 *     + reloadSkillsFromDisk reads new files and calls importSkills; orphan rows are cleared on prune).
 *     This keeps agent-tools free of a dependency on agent-memory, maintaining an acyclic package graph.
 *
 *   - Security falls back on the 3×4 matrix: capability='write', domain='self', same level as memoryTool.
 *     SKILL.md content is not pre-audited — the same threat surface as webFetch pulling page content into a prompt.
 *     The size cap in loader.parseSkillFile (8KB) blocks the extreme case of "stuffing a long doc into a prompt".
 */

import { mkdir, mkdtemp, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import type { Tool } from '@agent/policy';

/**
 * Validate a skill name.
 *   - Must be 1-64 characters
 *   - Only [a-z0-9_-] allowed (lowercase letters / digits / underscores / hyphens)
 *   - '.' and '..' (pure punctuation) are not allowed
 *
 * This is defense in depth: normal SKILL.md names all pass; any path-traversal
 * attempt is blocked here before it even reaches join().
 */
function validateSkillName(name: string): string | null {
  if (typeof name !== 'string') return 'name must be a string';
  if (name.length === 0) return 'name must not be empty';
  if (name.length > 64) return 'name exceeds 64 characters';
  if (name === '.' || name === '..') return `name cannot be "${name}"`;
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return 'name must match [a-z0-9_-] (lowercase letters, digits, underscores, hyphens only)';
  }
  return null;
}

/**
 * Install root: <cwd>/.philont/skills/. Always writes here — the loader also scans here first
 * on read, closing the semantic loop. <cwd>/skills/ is an openclaw upstream convention,
 * read-only here, to avoid double-write conflicts between user-manual installs and agent installs.
 */
function installRoot(): string {
  return join(process.cwd(), '.philont', 'skills');
}

/**
 * Candidate uninstall root list: .philont/skills/ first (our write path),
 * skills/ as fallback (the default directory for `clawhub install`, also read by the philont loader).
 */
function uninstallCandidates(): string[] {
  return [
    join(process.cwd(), '.philont', 'skills'),
    join(process.cwd(), 'skills'),
  ];
}

/**
 * Inject or replace a key in the frontmatter block.
 *
 * Behaviour:
 *   - If `^<key>:.*$` already exists → replace the entire line
 *   - If absent → insert on the line before the closing `---`
 *   - No frontmatter → create a new block at the top of the file containing only this key
 *
 * Does not attempt to preserve YAML comments / quoting style — SKILL.md frontmatter uses a
 * minimal key:value form (see loader.ts:parseFrontmatter); round-trip does not need full YAML.
 */
function injectFrontmatterField(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const line = `${key}: ${value}`;
  const keyRe = new RegExp(`^${key}:.*$`, 'm');

  if (!fmMatch) {
    // No frontmatter: create a new block
    return `---\n${line}\n---\n\n${content}`;
  }

  const [, yamlBlock, body] = fmMatch;
  let newYaml: string;
  if (keyRe.test(yamlBlock)) {
    newYaml = yamlBlock.replace(keyRe, line);
  } else {
    newYaml = yamlBlock.trimEnd() + '\n' + line;
  }
  return `---\n${newYaml}\n---\n${body}`;
}

/**
 * Remove a reserved key from frontmatter without touching occurrences in the skill body.
 *
 * Marketplace provenance is an overwrite credential, so the general-purpose agent-facing installer
 * must never preserve a caller-supplied copy of it. This applies to both write mode and source-only
 * patch/migration mode: once that broader tool rewrites the artifact, only the lock may vouch for it.
 */
function stripFrontmatterField(content: string, key: string): string {
  const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))([\s\S]*)$/);
  if (!fmMatch) return content;
  const keyRe = new RegExp(`^${key}:.*(?:\\r?\\n|$)`, 'gm');
  const yaml = fmMatch[2].replace(keyRe, '').replace(/\r?\n$/, '');
  return `${fmMatch[1]}${yaml}${fmMatch[3]}${fmMatch[4]}`;
}

/**
 * Write companion files (scripts/, reference/, …) into an installed skill's directory.
 *
 * Not part of the agent-facing tool schema on purpose: this is the marketplace install pipeline's
 * write step, not a capability the model gets to aim anywhere it likes. Every path is validated to be
 * relative and inside the skill directory before it is written — a source-controlled path like
 * `../../.ssh/authorized_keys` is exactly the kind of thing an untrusted registry would try.
 *
 * @returns the absolute paths written, plus per-file rejections (never throws for a single bad file).
 */
export async function writeSkillCompanions(
  name: string,
  files: Array<{ path: string; content: string }>,
): Promise<{ written: string[]; rejected: string[] }> {
  const written: string[] = [];
  const rejected: string[] = [];

  const nameErr = validateSkillName(name);
  if (nameErr) return { written, rejected: [`(all): ${nameErr}`] };

  const root = join(installRoot(), name);
  for (const f of files) {
    const rel = f.path.replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
      rejected.push(`${f.path}: unsafe path`);
      continue;
    }
    const target = join(root, ...rel.split('/'));
    // Belt and braces: even after the checks above, the resolved path must stay under the skill dir.
    if (target !== root && !target.startsWith(root + sep)) {
      rejected.push(`${f.path}: escapes the skill directory`);
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf-8');
      written.push(target);
    } catch (e) {
      rejected.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return { written, rejected };
}

/**
 * Frontmatter key stamped ONLY by the marketplace installer below.
 *
 * `source:` cannot carry this weight: it is descriptive metadata, and the agent-facing `installSkill`
 * tool takes an arbitrary `source` string ("github:owner/repo@<sha>" is literally the example in its
 * schema). A hand-written or self-learned skill can therefore look marketplace-installed, and treating
 * that as permission to overwrite would let ordinary metadata authorise destroying local work. This key
 * is written by exactly one code path — the one that also writes the lock row — so its presence is a
 * fact about who created the directory rather than a claim the file makes about itself.
 */
export const INSTALLED_BY_KEY = 'installed_by';
export const INSTALLED_BY_MARKETPLACE = 'philont-marketplace';

export interface InstalledSkillProvenance {
  /** The `source:` tag on disk, or null. */
  source: string | null;
  /** True when this directory was written by the marketplace installer. */
  installedByMarketplace: boolean;
}

/**
 * Read what the installed skill's own SKILL.md says about where it came from.
 *
 * Deliberately a minimal frontmatter read rather than `parseSkillFile`: that parser throws on a body
 * over the size cap, and "this skill is too big to load" must not be reported as "this directory is
 * not ours" — the two have opposite remedies.
 */
export async function readInstalledProvenance(name: string): Promise<InstalledSkillProvenance> {
  const none: InstalledSkillProvenance = { source: null, installedByMarketplace: false };
  if (validateSkillName(name)) return none;
  for (const root of uninstallCandidates()) {
    let text: string;
    try {
      text = await readFile(join(root, name, 'SKILL.md'), 'utf-8');
    } catch {
      continue;
    }
    const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const source = block.match(/^source:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const installedBy = block.match(new RegExp(`^${INSTALLED_BY_KEY}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    return { source, installedByMarketplace: installedBy === INSTALLED_BY_MARKETPLACE };
  }
  return none;
}

/**
 * Replace a marketplace-managed skill as one directory transaction.
 *
 * Updates used to overwrite the files present in the new bundle and leave everything else behind.
 * A script removed upstream therefore stayed executable forever. Build the complete replacement away
 * from the watched skills directory, then swap directories; a failed swap restores the old bundle.
 */
export async function writeSkillBundleAtomically(
  name: string,
  content: string,
  source: string,
  files: Array<{ path: string; content: string }>,
  replaceExisting: boolean,
): Promise<{ written: string[]; rejected: string[]; error?: string }> {
  const nameErr = validateSkillName(name);
  if (nameErr) return { written: [], rejected: [], error: nameErr };

  const root = installRoot();
  const philont = dirname(root);
  await mkdir(philont, { recursive: true });
  const stage = await mkdtemp(join(philont, `.skill-stage-${name}-`));
  const destination = join(root, name);
  const backup = join(philont, `.skill-backup-${name}-${randomUUID()}`);
  let movedOld = false;

  try {
    let finalContent = injectFrontmatterField(content, 'name', name);
    finalContent = injectFrontmatterField(finalContent, 'source', source);
    // Stamped here and nowhere else — see INSTALLED_BY_KEY for why `source:` cannot serve this role.
    finalContent = injectFrontmatterField(finalContent, INSTALLED_BY_KEY, INSTALLED_BY_MARKETPLACE);
    await writeFile(join(stage, 'SKILL.md'), finalContent, 'utf-8');

    const companionWrite = await writeSkillCompanionsAtRoot(stage, files);
    if (companionWrite.rejected.length) {
      return { written: [], rejected: companionWrite.rejected, error: 'one or more companion files could not be staged' };
    }

    await mkdir(root, { recursive: true });
    const exists = await stat(destination).then(() => true, (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    });
    if (exists && !replaceExisting) {
      // Reaching here means neither the lock nor the installer's own marker vouches for this
      // directory (or it came from a different origin). Name the situation: the previous wording,
      // "not marketplace-managed", was also emitted when the lock was merely missing, sending the
      // reader after a provenance problem that did not exist.
      return {
        written: [],
        rejected: [],
        error:
          `"${name}" already exists at ${destination} and was not written by the marketplace installer ` +
          `(no ${INSTALLED_BY_KEY}: ${INSTALLED_BY_MARKETPLACE} marker, or a different origin) — refusing ` +
          `to overwrite it. It may be a self-learned or hand-written skill that shares this name, or an ` +
          `install predating this marker whose lock entry is also gone; uninstall it first if you meant ` +
          `to replace it.`,
      };
    }
    if (exists) {
      await rename(destination, backup);
      movedOld = true;
    }
    try {
      await rename(stage, destination);
    } catch (e) {
      if (movedOld) await rename(backup, destination).catch(() => {});
      throw e;
    }
    if (movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});

    return {
      written: [join(destination, 'SKILL.md'), ...files.map((f) => join(destination, ...f.path.replace(/\\/g, '/').split('/')))],
      rejected: [],
    };
  } catch (e) {
    return { written: [], rejected: [], error: (e as Error).message };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (!movedOld) await rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeSkillCompanionsAtRoot(
  root: string,
  files: Array<{ path: string; content: string }>,
): Promise<{ written: string[]; rejected: string[] }> {
  const written: string[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const rel = f.path.replace(/\\/g, '/');
    // SKILL.md is the privileged entry written (and provenance-stamped) by
    // writeSkillBundleAtomically. A companion must never be able to replace it,
    // including through a harmless-looking equivalent such as ./SKILL.md.
    const normalizedRel = rel.split('/').filter((part) => part !== '.').join('/');
    if (normalizedRel.toLowerCase() === 'skill.md') {
      rejected.push(`${f.path}: SKILL.md is reserved for the skill entry`);
      continue;
    }
    if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.split('/').includes('..') || rel.includes('\0')) {
      rejected.push(`${f.path}: unsafe path`);
      continue;
    }
    const target = join(root, ...rel.split('/'));
    if (target !== root && !target.startsWith(root + sep)) {
      rejected.push(`${f.path}: escapes the skill directory`);
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf-8');
      written.push(target);
    } catch (e) {
      rejected.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return { written, rejected };
}

/**
 * Install a SKILL.md into the local skill library.
 *
 * Dual mode:
 *   - write mode (content provided): write a new file / overwrite. Optionally inject a source tag.
 *   - patch mode (only source provided): the file must already exist; only updates the frontmatter source field.
 *     Used to add a source tag after a multi-file `clawhub install` bundle has been written to disk.
 *
 * The file lands at <cwd>/.philont/skills/<name>/SKILL.md. After the fs watcher triggers a reload,
 * the SKILL.md enters SkillStore and is visible in the system prompt index next turn.
 */
export const installSkillTool: Tool = {
  name: 'installSkill',
  description:
    'Install a SKILL.md into the local skill library (.philont/skills/<name>/). ' +
    'Provide content to write a new file; provide only source to tag the frontmatter source field of an existing file (for use with clawhub install). ' +
    'After writing, the fs watcher triggers a reload and the new skill becomes visible in the system prompt index next turn.',
  schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name / directory name. Only [a-z0-9_-], max 64 chars.',
      },
      content: {
        type: 'string',
        description: 'Full SKILL.md text (including frontmatter). Optional — if omitted, only the source field is patched.',
      },
      source: {
        type: 'string',
        description:
          'Source tag, e.g. "clawhub:k8s-yaml-lint@2.1.0" / "github:owner/repo@<sha>" / "url:https://...". ' +
          'Optional — will be injected/replaced in the frontmatter source: field.',
      },
    },
    required: ['name'],
  },
  capability: 'write',
  domain: 'self',

  async execute(params) {
    try {
      const name = params.name as string;
      const content = params.content as string | undefined;
      const source = params.source as string | undefined;

      const nameErr = validateSkillName(name);
      if (nameErr) {
        return { success: false, output: '', error: `installSkill: ${nameErr}` };
      }

      if (!content && !source) {
        return {
          success: false,
          output: '',
          error: 'installSkill: must provide at least content (write a new file) or source (patch frontmatter)',
        };
      }

      const dir = join(installRoot(), name);
      const file = join(dir, 'SKILL.md');

      let finalContent: string;

      if (content) {
        // write mode: write new file / overwrite
        // `installed_by` is an overwrite credential reserved to writeSkillBundleAtomically. The
        // caller controls all of `content`, so strip any attempted copy before writing.
        const unprivilegedContent = stripFrontmatterField(content, INSTALLED_BY_KEY);
        // Ensure frontmatter contains name (inject if the SKILL.md does not declare it)
        finalContent = injectFrontmatterField(unprivilegedContent, 'name', name);
        if (source) {
          finalContent = injectFrontmatterField(finalContent, 'source', source);
        }
      } else {
        // patch mode: file must exist; only change the source field
        let existing: string;
        try {
          existing = await readFile(file, 'utf-8');
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            // patch fallback: the user used the default clawhub install directory (skills/)
            const altFile = join(process.cwd(), 'skills', name, 'SKILL.md');
            try {
              existing = await readFile(altFile, 'utf-8');
              // Migrate it to our standard directory (.philont/skills/) while tagging source
              finalContent = injectFrontmatterField(
                stripFrontmatterField(existing, INSTALLED_BY_KEY),
                'source',
                source!,
              );
              await mkdir(dir, { recursive: true });
              await writeFile(file, finalContent, 'utf-8');
              return {
                success: true,
                output:
                  `📥 Installed skill ${name} (migrated from skills/ to .philont/skills/, source: ${source})`,
              };
            } catch {
              return {
                success: false,
                output: '',
                error: `installSkill: patch mode requires the file to exist, but ${file} does not`,
              };
            }
          }
          throw e;
        }
        finalContent = injectFrontmatterField(
          stripFrontmatterField(existing, INSTALLED_BY_KEY),
          'source',
          source!,
        );
      }

      await mkdir(dir, { recursive: true });
      await writeFile(file, finalContent, 'utf-8');

      const sourceLabel = source ? `source: ${source}` : 'local';
      return {
        success: true,
        output: `📥 Installed skill ${name} (${sourceLabel})`,
      };
    } catch (e) {
      return { success: false, output: '', error: `installSkill failed: ${(e as Error).message}` };
    }
  },
};

/**
 * Uninstall a locally installed skill: delete the .philont/skills/<name>/ directory.
 *
 * Implementation only touches the filesystem — does not call SkillStore directly.
 * After the fs watcher triggers a reload, the server-side prune path finds orphan rows
 * in SkillStore where source!=null but the file no longer exists on disk, and
 * calls deleteSkill automatically. This keeps agent-tools free of a dependency on agent-memory.
 *
 * Idempotent: returns success even if the directory does not exist (the user may have deleted it manually).
 */
export const uninstallSkillTool: Tool = {
  name: 'uninstallSkill',
  description:
    'Uninstall a locally installed skill: removes the .philont/skills/<name>/ directory (also checks skills/<name>/ as fallback). ' +
    'Idempotent — returns success even if the directory is already gone. The fs watcher triggers a reload and SkillStore cleans up the DB row automatically.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name / directory name, same rules as installSkill' },
    },
    required: ['name'],
  },
  capability: 'write',
  domain: 'self',

  async execute(params) {
    try {
      const name = params.name as string;

      const nameErr = validateSkillName(name);
      if (nameErr) {
        return { success: false, output: '', error: `uninstallSkill: ${nameErr}` };
      }

      let removed = 0;
      for (const root of uninstallCandidates()) {
        const dir = join(root, name);
        try {
          const s = await stat(dir);
          if (s.isDirectory()) {
            await rm(dir, { recursive: true, force: true });
            removed++;
          }
        } catch (e) {
          // ENOENT = directory not found, skip; other errors re-throw
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }

      // Idempotent: count as success even if the directory was not found (user may have
      // deleted it manually; any stale DB rows are cleaned up by reload-prune).
      const note = removed === 0 ? '(directory was already absent; any stale DB row will be cleaned up by reload-prune)' : '';
      return {
        success: true,
        output: `📤 Uninstalled skill ${name} ${note}`.trim(),
      };
    } catch (e) {
      return { success: false, output: '', error: `uninstallSkill failed: ${(e as Error).message}` };
    }
  },
};
