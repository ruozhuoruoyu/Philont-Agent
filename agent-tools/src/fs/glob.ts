/**
 * glob tool - find files by glob pattern
 *
 * Supported glob syntax:
 *   *        matches any characters (excluding /)
 *   **       matches any path segments (including /)
 *   ?        matches a single character
 *   [abc]    matches a character set
 *   {a,b,c}  matches any one option
 *
 * Examples:
 *   src/**\/*.ts         all ts files
 *   src/*.{js,ts}        js or ts files under src
 *   **\/test_*.py        test_-prefixed py files at any depth
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep, isAbsolute } from 'node:path';
import type { Tool } from '@agent/policy';

/**
 * Compile a glob pattern into a RegExp
 */
function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path (including /)
        regex += '.*';
        i += 2;
        // consume a trailing /
        if (pattern[i] === '/') i++;
        continue;
      }
      // * matches a single path segment (no /)
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if (c === '[') {
      // Pass character sets through verbatim
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        regex += '\\[';
      } else {
        regex += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (c === '{') {
      // {a,b,c} → (a|b|c)  (unchanged)
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += '\\{';
      } else {
        const options = pattern.slice(i + 1, end).split(',');
        regex += '(' + options.map(o => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else if ('.+^$()|\\'.includes(c)) {
      // Escape regex special characters
      regex += '\\' + c;
    } else {
      regex += c;
    }
    i++;
  }

  return new RegExp('^' + regex + '$');
}

async function walkDir(
  root: string,
  regex: RegExp,
  maxResults: number,
  skipDirs: Set<string> = new Set(['node_modules', '.git', 'dist', 'build', 'target']),
): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;

    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (skipDirs.has(entry)) continue;

      const full = join(current, entry);
      const s = await stat(full).catch(() => null);
      if (!s) continue;

      // The regex speaks forward slashes; on Windows path.relative speaks backslashes. Without this line
      // any pattern containing a separator matched NOTHING on Windows — ever. Production spent a turn
      // re-fetching three articles that were sitting on disk the whole time, because two globs over the
      // fetched-store returned "No files matching", the re-fetches hit 403s, and the failure cascade got
      // webFetch mechanism-disabled for the rest of the turn.
      const rel = relative(root, full).split(sep).join('/');

      if (s.isFile()) {
        if (regex.test(rel)) {
          results.push(full);
        }
      } else if (s.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(root);
  return results;
}

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern (supports **, *, ?, {}, [])',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      cwd: { type: 'string', description: 'Starting directory; defaults to the current directory' },
      maxResults: { type: 'number', description: 'Maximum number of files to return (default 500)' },
    },
    required: ['pattern'],
  },
  capability: 'read',
  domain: 'local',
  async execute(params) {
    // Normalise Windows separators in the PATTERN too: models on Windows hand this tool literal paths
    // like C:\Users\me\.philont\workspace\fetched\* — in glob syntax every one of those backslashes
    // is an escape character, so the pattern could never match anything.
    const rawPattern = (params.pattern as string).split('\\').join('/');
    let cwd = (params.cwd as string) || '.';
    let pattern = rawPattern;
    // An ABSOLUTE pattern was previously walked from the current directory, so it matched nothing by
    // construction. Split it: everything before the first glob character is the root to walk from.
    if (isAbsolute(rawPattern)) {
      const firstGlob = rawPattern.search(/[*?[{]/);
      const cut = firstGlob === -1 ? rawPattern.lastIndexOf('/') : rawPattern.lastIndexOf('/', firstGlob);
      if (cut > 0) {
        cwd = rawPattern.slice(0, cut) || '/';
        pattern = rawPattern.slice(cut + 1);
      }
    }
    const maxResults = (params.maxResults as number) || 500;

    try {
      const regex = globToRegex(pattern);
      const files = await walkDir(cwd, regex, maxResults);

      if (files.length === 0) {
        return { success: true, output: `No files matching "${rawPattern}" (searched under ${cwd})` };
      }

      return {
        success: true,
        output: `Found ${files.length} file(s):\n${files.join('\n')}`,
      };
    } catch (error) {
      return { success: false, output: '', error: `Glob failed: ${error}` };
    }
  },
};
