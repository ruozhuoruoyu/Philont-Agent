/**
 * A privacy fix that only covered the file it was written in.
 *
 * `session=${sessionId}` was swept out of chat-handler and headless, and the commit said "everywhere
 * it is logged". It was not: reflection_runner, deep_explore, index, and both media channels still
 * interpolated the raw id — the media channels inside `throw new Error(...)`, which reaches the log
 * the moment anything upstream catches it. Twenty-two sites, found by review rather than by the
 * suite, in the same shape as every other split this project keeps re-learning: the producer was
 * fixed where someone was already looking.
 *
 * So the rule is enforced by a scan instead of by diligence. Every raw interpolation of a session
 * identifier in server source must either be wrapped in safeSessionId() or be listed below as a
 * deliberate non-log use — identifiers that are storage keys, not messages. Adding a new one is
 * therefore a decision someone has to write down, which is the whole point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

/** Interpolations that build a KEY (note id, dedup key, audit ref), never a message. */
const DATA_KEY_ALLOWLIST = [
  'session-summary-${sid}',
  'session-summary-${sessionId}',
  '${sessionId}::${nodeId}',
  'deep-explore:${sessionId}',
  '${sessionId}:${turnStartTs}',
];

const RAW_SESSION_INTERPOLATION = /\$\{\s*(?:[A-Za-z_$][\w$]*\.)?(?:sessionId|sid|targetSessionId)\s*\}/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no server source interpolates a raw session id outside safeSessionId()', () => {
  const violations: string[] = [];

  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('safe_session_id.ts')) continue; // the implementation itself
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!RAW_SESSION_INTERPOLATION.test(line)) return;
      if (line.includes('safeSessionId(')) return;
      if (DATA_KEY_ALLOWLIST.some((allowed) => line.includes(allowed))) return;
      violations.push(`${relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }

  assert.deepEqual(
    violations,
    [],
    `Raw session identifiers reach a message here. A WeChat session id is built from the peer's ` +
      `account id.\nWrap them in safeSessionId(), or — if the value is a storage key rather than ` +
      `something a human reads — add the exact pattern to DATA_KEY_ALLOWLIST in this test.\n\n` +
      violations.join('\n'),
  );
});

test('the allowlist stays honest: every entry is still present in the source', () => {
  const all = sourceFiles(SRC)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  for (const allowed of DATA_KEY_ALLOWLIST) {
    assert.ok(all.includes(allowed), `stale allowlist entry, no longer in src: ${allowed}`);
  }
});
