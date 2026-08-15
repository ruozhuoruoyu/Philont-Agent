/**
 * Where a skill's files live, and how that gets told to the model.
 *
 * A SKILL.md is written as if the agent were standing in the skill's directory: "read FORMS.md",
 * "run scripts/fill_fillable_fields.py". Those instructions were unusable, because `use_skill`
 * returned the markdown body and nothing else — no directory, no file list. The loader has always
 * known the path (ParsedSkill.sourcePath) but nothing downstream consumed it, so the model was left to
 * guess a location, and guessing produced either a failed read or an invented result.
 *
 * This resolves the install directory by name at read time (the same two roots the loader scans) and
 * appends a short, factual section listing what is actually on disk. Nothing is appended when the
 * skill has no companion files — a self-learned skill should not grow a pointless "Files" heading.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Install roots, highest priority first: our write path, then the upstream `skills/` convention. */
function skillRoots(): string[] {
  return [join(process.cwd(), '.philont', 'skills'), join(process.cwd(), 'skills')];
}

/** Absolute directory of an installed skill, or null when it is not on disk (DB-only / self-learned). */
export function resolveSkillDir(name: string): string | null {
  if (!/^[a-z0-9_-]+$/i.test(name)) return null; // name comes from the model; never build a path from junk
  for (const root of skillRoots()) {
    const dir = join(root, name);
    if (existsSync(join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/** Companion files inside a skill directory, relative posix paths, SKILL.md excluded. */
export function listSkillFiles(dir: string, limit = 40): string[] {
  const out: string[] = [];

  const walk = (current: string, prefix: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (out.length >= limit) return;
      const full = join(current, e);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      const rel = prefix ? `${prefix}/${e}` : e;
      if (isDir) walk(full, rel);
      else if (!/^SKILL\.md$/i.test(rel)) out.push(rel);
    }
  };

  walk(dir, '');
  return out;
}

/**
 * The block appended to a `use_skill` result. Empty string when there is nothing to say.
 *
 * Deliberately states the absolute directory: the agent's shell and file tools do not necessarily run
 * with the skill directory as cwd, so a relative path from the SKILL.md text is not directly usable.
 */
export function skillFilesSection(name: string): string {
  const dir = resolveSkillDir(name);
  if (!dir) return '';
  const SHOWN = 40;
  // Ask for one more than we display, so "there are more" is a fact we observed rather than a branch
  // that can never be true — listSkillFiles stops at its own limit.
  const files = listSkillFiles(dir, SHOWN + 1);
  if (!files.length) return '';

  const lines = files.slice(0, SHOWN).map((f) => `- ${f}`);
  const more = files.length > SHOWN ? `\n- …(and more; ${SHOWN} shown)` : '';
  return (
    `\n\n## Files\n` +
    `This skill is installed at: ${dir}\n` +
    `Relative paths in the steps above resolve against that directory:\n` +
    `${lines.join('\n')}${more}\n` +
    `Read or run them with the absolute path (e.g. ${join(dir, files[0])}). ` +
    `If a file the steps mention is not in this list, it was not installed — say so rather than improvising.`
  );
}
