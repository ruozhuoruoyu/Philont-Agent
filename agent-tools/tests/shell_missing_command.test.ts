import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingShellCommand } from '../src/runtime/shell.js';

test('detects the command name from each shell\'s own "not found" wording', () => {
  // cmd.exe — verbatim from the production failure that killed a step.
  assert.equal(
    missingShellCommand("'head' is not recognized as an internal or external command,\noperable program or batch file."),
    'head',
  );
  // bash / zsh
  assert.equal(missingShellCommand('bash: head: command not found'), 'head');
  assert.equal(missingShellCommand('head: command not found'), 'head');
  // dash / sh
  assert.equal(missingShellCommand('/bin/sh: 1: head: not found'), 'head');
  // PowerShell
  assert.ok(missingShellCommand("head : The term 'head' is not recognized as the name of a cmdlet\nhead"));
});

test('one code path serves every platform — the name comes from the message, never a list', () => {
  // The same logic must work for a PowerShell-ism on Linux as for a Unix-ism on Windows: nothing in the
  // detector knows which commands belong to which OS.
  assert.equal(missingShellCommand('bash: Get-ChildItem: command not found'), 'Get-ChildItem');
  assert.equal(missingShellCommand("'ls' is not recognized as an internal or external command"), 'ls');
  assert.equal(missingShellCommand('bash: sed: command not found'), 'sed');
  assert.equal(missingShellCommand('bash: some-tool-invented-tomorrow: command not found'), 'some-tool-invented-tomorrow');
});

test('a normal command failure is NOT mistaken for a missing command', () => {
  // Only "this command does not exist" qualifies; ordinary non-zero exits must not trigger the hint.
  assert.equal(missingShellCommand('grep: nonexistent.txt: No such file or directory'), null);
  assert.equal(missingShellCommand('The system cannot find the path specified.'), null);
  assert.equal(missingShellCommand('fatal: not a git repository'), null);
  assert.equal(missingShellCommand(''), null);
  assert.equal(missingShellCommand('   '), null);
});

test('the hint reaches the model, names no commands and no OS-specific replacements', async () => {
  const { shellTool } = await import('../src/runtime/shell.js');
  // A command that exists on no platform → the shell reports it missing for real.
  const r = await shellTool.execute({ command: 'philont-no-such-command-xyz' });
  assert.equal(r.success, false);
  const text = `${r.error ?? ''}${r.output ?? ''}`;
  assert.match(text, /does not exist in this host's shell/, 'the correction must be surfaced');
  assert.match(text, /readFile \/ writeFile \/ glob \/ grep/, 'and must point at the cross-platform tools');
  assert.match(text, new RegExp(process.platform), 'and state the real host OS');
  // No Unix-command vocabulary and no OS-specific substitutions may appear in the guidance.
  assert.doesNotMatch(text, /mkdir -p|powershell -Command|Get-Content|\btail\b/i,
    'the hint must not carry a per-OS command list — that is the trap it exists to avoid');
});
