/**
 * 2026-07-31 13:30:06.828 → 13:30:06.851. Four writeFile calls laying out a Lean project under
 * output/lrc-formal/ failed inside twenty-three milliseconds:
 *
 *   Failed to write file: Error: ENOENT: no such file or directory, open
 *     'E:\dev\philont\server\output\lrc-formal\lean-toolchain'
 *
 * What that cost: writeFile:enoent ×4 → in-turn-tool-block disabled writeFile for the rest of the turn
 * → research-before-retry blocked shell too → auto-revise-on-fail flipped the session to slow and minted
 * a placeholder plan → the reply claimed "已完成" over four failed writes and the honesty gate fired.
 *
 * Every one of those mechanisms did its job. The whole cascade came from a missing directory, and the
 * strategic machinery cannot tell "your approach is wrong" from "mkdir first".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileTool } from '../src/fs/writeFile.js';

async function inTemp(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'philont-writefile-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writing the first file of a new project creates the directory', async () => {
  await inTemp(async (dir) => {
    const path = join(dir, 'lrc-formal', 'lean-toolchain');
    const r = await writeFileTool.execute({ path, content: 'leanprover/lean4:v4.32.0\n' });
    assert.equal(r.success, true, r.error);
    assert.equal(await readFile(path, 'utf-8'), 'leanprover/lean4:v4.32.0\n');
  });
});

test('nested directories are created too', async () => {
  await inTemp(async (dir) => {
    const path = join(dir, 'lrc-formal', 'Lrc', 'Basic.lean');
    const r = await writeFileTool.execute({ path, content: '/-! LRC -/\n' });
    assert.equal(r.success, true, r.error);
    assert.equal(await readFile(path, 'utf-8'), '/-! LRC -/\n');
  });
});

test('an existing file is still overwritten, not appended to', async () => {
  await inTemp(async (dir) => {
    const path = join(dir, 'a.txt');
    await fsWriteFile(path, 'old contents that are longer', 'utf-8');
    const r = await writeFileTool.execute({ path, content: 'new' });
    assert.equal(r.success, true);
    assert.equal(await readFile(path, 'utf-8'), 'new');
  });
});

// mkdir -p must not turn a genuine write failure into a silent success: a path whose parent is a FILE
// cannot be created, and that has to keep reporting failure.
test('a real write failure is still a failure', async () => {
  await inTemp(async (dir) => {
    const file = join(dir, 'notadir');
    await fsWriteFile(file, 'x', 'utf-8');
    const r = await writeFileTool.execute({ path: join(file, 'child.txt'), content: 'y' });
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /Failed to write file/);
  });
});
