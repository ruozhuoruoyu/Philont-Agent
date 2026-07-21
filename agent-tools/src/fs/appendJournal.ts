/**
 * appendJournal — append-only dated journal in the agent's own state directory.
 *
 * Why this exists (2026-07-21). Scheduled turns may not call writeFile: an unattended turn must not
 * make arbitrary, unreviewable changes to the shared filesystem. But a recurring task whose whole
 * point is "check in, then record what happened" needs SOME way to write down what it did, and prod
 * showed what happens when it has none: a 6-minute heartbeat whose goal said "log to
 * memory/YYYY-MM-DD.md" hit the blacklist on every single run, forever, and every run was correctly
 * judged a failure for not achieving its stated goal. The task was unsatisfiable by construction.
 *
 * The distinction that makes this safe is the DOMAIN, not an exception carved out of writeFile:
 *   - writeFile is capability=write domain=local — the shared filesystem, arbitrary destination.
 *   - appendJournal is capability=write domain=self — agent self-state, exactly like memory/skills.
 *     domain='self' is defined as "no side effects on the shared filesystem or external services",
 *     and the permission matrix already grants self-writes even under the readonly profile.
 *
 * Three properties keep it inside that definition:
 *   1. NO path parameter. The only caller-supplied component of the filename is a date, validated
 *      against a strict YYYY-MM-DD pattern, so there is no traversal surface to reason about — not a
 *      containment check that every future caller has to get right.
 *   2. Append-only. A recurring task cannot destroy its own history by re-running.
 *   3. Fixed root: PHILONT_JOURNAL_DIR (absolute) else <cwd>/.philont/journal, matching the
 *      .philont convention already used for skills and lock state.
 */

import type { Tool } from '@agent/policy';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Strict calendar-day filename stem. Anything else — separators, '..', empty — is rejected. */
const JOURNAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Journal root: env override (absolute only) else <cwd>/.philont/journal. */
export function journalRoot(): string {
  const env = process.env.PHILONT_JOURNAL_DIR?.trim();
  if (env && isAbsolute(env)) return env;
  return join(process.cwd(), '.philont', 'journal');
}

/** Local calendar day as YYYY-MM-DD (local, not UTC — the journal is read by a human in their timezone). */
export function journalDateOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Resolve a journal file path. Returns null when the date is not a plain calendar day — the single
 * validation that stands in for path containment, since nothing else about the path is caller-supplied.
 */
export function journalPathFor(date: string, root = journalRoot()): string | null {
  if (!JOURNAL_DATE_RE.test(date)) return null;
  return join(root, `${date}.md`);
}

export const appendJournalTool: Tool = {
  name: 'appendJournal',
  description:
    'Append an entry to the agent\'s own dated journal (one markdown file per day, append-only). ' +
    'Use this to record what a run did — it is available in scheduled/unattended turns, where writeFile is not. ' +
    'You cannot choose the location: entries always land in the agent journal directory, one file per date.',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The entry to append (markdown). Existing content is never overwritten.' },
      date: {
        type: 'string',
        description: 'Calendar day YYYY-MM-DD. Omit for today. This is the ONLY control over the filename.',
      },
    },
    required: ['text'],
  },
  capability: 'write',
  domain: 'self',
  async execute(params) {
    const text = typeof params.text === 'string' ? params.text : '';
    if (text.trim().length === 0) {
      return { success: false, output: '', error: 'text is required and must not be empty' };
    }
    const now = new Date();
    const rawDate = typeof params.date === 'string' && params.date.trim().length > 0
      ? params.date.trim()
      : journalDateOf(now);
    const root = journalRoot();
    const file = journalPathFor(rawDate, root);
    if (!file) {
      return {
        success: false,
        output: '',
        error:
          `date must be a plain calendar day in YYYY-MM-DD form (got '${rawDate}'). ` +
          `appendJournal takes no path — omit date to write today's entry.`,
      };
    }
    try {
      await mkdir(root, { recursive: true });
      // Header only when the file is new, so a day's file reads as one document.
      const isNew = await stat(file).then(() => false, () => true);
      const p = (n: number) => String(n).padStart(2, '0');
      const stamp = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
      const entry =
        (isNew ? `# ${rawDate}\n\n` : '') + `## ${stamp}\n\n${text.trimEnd()}\n\n`;
      await appendFile(file, entry, 'utf-8');
      return { success: true, output: `Appended ${entry.length} bytes to ${file}` };
    } catch (error) {
      return { success: false, output: '', error: `Failed to append to journal: ${error}` };
    }
  },
};
