/**
 * A chained command's exit code belongs to its LAST segment only.
 *
 * Production 2026-07-22, on Windows: `where python & dir …2511* & dir … & dir …`. `where` found both
 * interpreters; the trailing `dir` matched no files and returned 1. The call came back as
 * `[exitCode=1] (no stderr output)` with the answer buried in a truncated stdout preview — counted twice
 * into same_root_cause_failures, triggering a reflection, and read by the model as a broken command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellTool } from '../src/index.js';

async function run(command: string, timeout = 20000) {
  return shellTool.execute({ command, timeout });
}

const isWindows = process.platform === 'win32';
const chainOp = isWindows ? '&' : ';';
/** A command that succeeds and prints, followed by one that fails silently with no stderr. */
const NOISELESS_FAIL = isWindows ? 'dir /b nonexistent-philont-*' : 'grep -q philont-nonexistent /dev/null';

test('a chained command explains that the exit code is only the last segment', async () => {
  const r = await run(`echo FIRST_SEGMENT_RAN ${chainOp} ${NOISELESS_FAIL}`);

  assert.equal(r.success, false, 'still reported as a failure — relabelling it success is the same lie inverted');
  assert.match(r.error ?? '', /only the LAST one/, 'the model must be told which segment the code belongs to');
  // The part that worked has to survive into the result; it is the answer the caller asked for.
  assert.match(`${r.output ?? ''}${r.error ?? ''}`, /FIRST_SEGMENT_RAN/);
});

test('a non-zero exit with no stderr is described as "nothing matched", not as a broken command', async () => {
  const r = await run(NOISELESS_FAIL);

  assert.equal(r.success, false);
  assert.match(r.error ?? '', /nothing matched \/ not found/);
  assert.doesNotMatch(r.error ?? '', /only the LAST one/, 'a single command carries no chain note');
});

test('a real error still reports its stderr, unchanged', async () => {
  const r = await run('philont-definitely-not-a-command-xyz');
  assert.equal(r.success, false);
  // Either the shell's own message or the missing-command hint — what matters is that it is not silent.
  assert.ok((r.error ?? '').length > 20);
});

test('a plain success is untouched', async () => {
  const r = await run('echo OK_PLAIN');
  assert.equal(r.success, true);
  assert.match(r.output ?? '', /OK_PLAIN/);
});

/**
 * The child's OWN encoding, which our decoder cannot reach.
 *
 * On a Chinese Windows install Python writes stdout as cp936; printing anything outside it raises
 * UnicodeEncodeError and kills the script. Production reported that to the owner as "PDF encoding problem,
 * most text cannot be extracted" — a false statement about the PDF, and the worst shape a bug can take:
 * an environment defect narrated as an honest capability limit.
 */
/** python3 on most Linux images, python on Windows — try both before skipping. */
async function python(script: string) {
  for (const bin of ['python3', 'python']) {
    const r = await run(`${bin} -c "${script}"`);
    if (r.success) return r;
  }
  return null;
}

test('a spawned python is told to write UTF-8', async (t) => {
  const r = await python('import sys; print(sys.stdout.encoding)');
  if (!r) return t.skip('no python on PATH');
  assert.match((r.output ?? '').toLowerCase(), /utf-?8/);
});

test('a non-ASCII character survives a round trip through the child', async (t) => {
  // Hungarian ő — the exact character class that killed the production run.
  const r = await python("print('Weingartner \u0151 \u02dd ok')");
  if (!r) return t.skip('no python on PATH');
  assert.match(r.output ?? '', /Weingartner ő ˝ ok/);
});
