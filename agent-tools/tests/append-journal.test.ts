/**
 * appendJournal — the write capability an unattended (scheduled) turn is allowed to have.
 *
 * The safety argument is entirely structural, so that is what these pin: domain='self', no path
 * parameter (the only caller-supplied filename component is a strict calendar day), and append-only.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournalTool,
  journalPathFor,
  journalDateOf,
  journalRoot,
  builtinTools,
  resolveProfile,
} from '../src/index.js';

const ROOT = join(tmpdir(), `philont-journal-test-${process.pid}`);

describe('appendJournal', () => {
  let saved: string | undefined;
  before(() => {
    saved = process.env.PHILONT_JOURNAL_DIR;
    process.env.PHILONT_JOURNAL_DIR = ROOT;
  });
  after(async () => {
    if (saved === undefined) delete process.env.PHILONT_JOURNAL_DIR;
    else process.env.PHILONT_JOURNAL_DIR = saved;
    await rm(ROOT, { recursive: true, force: true });
  });

  it('is registered under its exact name in builtins AND the coding profile', () => {
    // Registration is by exact string match with no normalisation layer anywhere, so a name that is
    // right in one list and wrong in another is silently dropped and the tool simply never appears.
    // The server profile extends 'coding'; if it is missing there, the model never sees this tool and
    // the whole fix is invisible in production while every test still passes.
    assert.ok(builtinTools.some((t) => t.name === 'appendJournal'), 'missing from builtinTools');
    assert.ok(
      (resolveProfile('coding') ?? []).includes('appendJournal'),
      'missing from the coding profile the server extends',
    );
  });

  it('is a self-domain write — the reason a scheduled turn may call it at all', () => {
    // writeFile is write/local (the shared filesystem). The permission matrix grants self-writes even
    // under the readonly profile precisely because they do not leave the agent boundary. If this ever
    // becomes 'local', the tool has quietly turned into the thing the blacklist exists to stop.
    assert.equal(appendJournalTool.capability, 'write');
    assert.equal(appendJournalTool.domain, 'self');
  });

  it('exposes no path — only a calendar day, so there is no traversal surface', () => {
    const props = (appendJournalTool.schema as { properties: Record<string, unknown> }).properties;
    assert.deepEqual(Object.keys(props).sort(), ['date', 'text']);
    for (const bad of [
      '../../etc/passwd',
      '2026-07-21/../../x',
      '2026-07-21.md',
      'a/b',
      'a\\b',
      '',
      '2026-7-21',
      '20260721',
    ]) {
      assert.equal(journalPathFor(bad, ROOT), null, `must reject: ${JSON.stringify(bad)}`);
    }
    assert.equal(journalPathFor('2026-07-21', ROOT), join(ROOT, '2026-07-21.md'));
  });

  it('rejects a non-date rather than writing somewhere unexpected', async () => {
    const r = await appendJournalTool.execute({ text: 'x', date: '../escape' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /YYYY-MM-DD/);
  });

  it('appends: the header is written once, later entries never overwrite earlier ones', async () => {
    const day = '2026-07-21';
    const a = await appendJournalTool.execute({ text: 'first run: feed unchanged', date: day });
    assert.equal(a.success, true, a.error);
    const b = await appendJournalTool.execute({ text: 'second run: voted on 2 posts', date: day });
    assert.equal(b.success, true, b.error);

    const body = await readFile(join(ROOT, `${day}.md`), 'utf-8');
    assert.equal(body.match(/^# 2026-07-21$/gm)?.length, 1, 'day header exactly once');
    assert.ok(body.includes('first run: feed unchanged'), 'earlier entry survives');
    assert.ok(body.includes('second run: voted on 2 posts'));
    assert.ok(
      body.indexOf('first run') < body.indexOf('second run'),
      'chronological — a re-run cannot destroy its own history',
    );
    assert.equal(body.match(/^## \d{2}:\d{2}:\d{2}$/gm)?.length, 2, 'one timestamp per entry');
  });

  it('empty text is refused (an empty entry is not a record of anything)', async () => {
    const r = await appendJournalTool.execute({ text: '   ', date: '2026-07-21' });
    assert.equal(r.success, false);
  });

  it('defaults to today, and the date is local — the journal is read in the reader’s timezone', async () => {
    const r = await appendJournalTool.execute({ text: 'no date given' });
    assert.equal(r.success, true, r.error);
    const today = journalDateOf(new Date());
    assert.ok(r.output.includes(`${today}.md`), `expected today's file in: ${r.output}`);
    assert.equal(journalDateOf(new Date(2026, 6, 5, 23, 59)), '2026-07-05');
  });

  it('root: absolute env override wins, otherwise it stays under the .philont convention', () => {
    assert.equal(journalRoot(), ROOT);
    process.env.PHILONT_JOURNAL_DIR = 'relative/not/allowed';
    assert.ok(journalRoot().endsWith(join('.philont', 'journal')), 'relative override ignored');
    process.env.PHILONT_JOURNAL_DIR = ROOT;
  });
});
