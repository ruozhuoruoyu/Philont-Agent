/**
 * Acceptance–repair loop (2026-10-06) — the self-evolution primitive that survived the measurements.
 *
 * Across 2026-10-04/06 (philosophers exps 111–113; docs/design/memory_interface_evidence.md §3e–§3j) no memory
 * form — cases, skills, playbooks, failure cases, distilled conventions, self-written verifiers — moved a
 * frontier-class model's accuracy on LifelongAgentBench OS, and every published self-improvement method tied with
 * a memoryless agent on the same model. The one intervention that moved it was feeding the REAL acceptance
 * check's failures back for one repair turn: +11/+17 of 60 tasks for philont, 72 gained / 0 lost of 360 for a
 * plain agent at 27B. Its boundary is the model (a 7B repaired <15%) and the existence of a real signal.
 *
 * This module runs an acceptance command after a turn and classifies the result. The command is whatever the
 * environment can verify mechanically — a test runner, a checker script, a downstream validator — and runs
 * through the same shell program as the agent's `shell` tool (PHILONT_SHELL_BIN honoured), so it sees the same
 * machine the agent acted on. headless.ts owns the loop (check → repair turn → re-check); this file owns the
 * check and the prompt, so both are unit-testable without an LLM.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface AcceptanceResult {
  passed: boolean;
  exitCode: number | null;
  /** Combined stdout+stderr, tail-trimmed. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export function acceptanceShell(): string {
  const forced = (process.env.PHILONT_SHELL_BIN ?? '').trim();
  if (forced && existsSync(forced)) return forced;
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Run `cmd` as `<shell> -c <cmd>`; never throws. */
export function runAcceptance(cmd: string, timeoutMs = 60_000, shell: string = acceptanceShell()): Promise<AcceptanceResult> {
  return new Promise((resolveP) => {
    const started = Date.now();
    let out = '';
    let done = false;
    const child = spawn(shell, ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const push = (b: Buffer) => { out += b.toString('utf8'); if (out.length > 20_000) out = out.slice(-20_000); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolveP({ passed: false, exitCode: null, output: tail(out), timedOut: true, durationMs: Date.now() - started });
    }, timeoutMs);
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolveP({ passed: false, exitCode: null, output: tail(out + `\n[spawn error] ${String(e)}`), timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolveP({ passed: code === 0, exitCode: code, output: tail(out), timedOut: false, durationMs: Date.now() - started });
    });
  });
}

/**
 * Diagnosis (2026-10-06 v2). Many acceptance commands are silent chains — `test A && test B && exit 0 || exit 1`
 * — whose only signal is the exit code. The first native run on LifelongAgentBench showed why that is not enough:
 * handed only "exit code 1", the agent repaired 6 of 32 failures; handed the failing clause, the harness-side loop
 * had repaired 28 of 35. So when a failed check produced no output, run the chain's `&&` clauses one by one and
 * name the ones that fail. Pure string splitting on " && " outside the trailing exit idiom; clauses that cannot be
 * split (quotes, subshells) simply run as a whole and the agent gets the exit code as before.
 */
export function splitClauses(cmd: string): string[] {
  let body = cmd.trim();
  for (const suf of [' && exit 0 || exit 1', '&& exit 0 || exit 1', ' && exit 0', '|| exit 1']) body = body.split(suf).join('');
  const parts = body.split(' && ').map((c) => c.trim()).filter((c) => c && c !== 'exit 0' && c !== 'exit 1');
  return parts.length > 1 ? parts.slice(0, 16) : [];
}

export async function diagnoseAcceptance(cmd: string, result: AcceptanceResult, timeoutMs: number, shell: string = acceptanceShell()): Promise<string[]> {
  if (result.passed || result.output.trim()) return [];
  const failing: string[] = [];
  for (const clause of splitClauses(cmd)) {
    const r = await runAcceptance(clause, Math.min(timeoutMs, 15_000), shell);
    if (!r.passed) failing.push(clause.slice(0, 200));
  }
  return failing;
}

export function tail(s: string, max = 3000): string {
  const t = s.trim();
  return t.length > max ? '…' + t.slice(-max) : t;
}

/**
 * The repair prompt. It names the failed checks verbatim and asks for a minimal fix: the measurements showed the
 * agent repairs ~90% of failures when the failing check is named, and that paraphrased "lessons" do not help.
 */
export function repairPrompt(taskText: string, result: AcceptanceResult, attempt: number, maxAttempts: number, failingClauses: string[] = []): string {
  const why = result.timedOut
    ? 'the acceptance check did not finish within its time limit'
    : `the acceptance check exited with code ${result.exitCode ?? 'unknown'}`;
  const detail = failingClauses.length
    ? ['These acceptance checks FAILED (bash; each must pass):', ...failingClauses.map((c) => `- ${c}`)]
    : ['Acceptance check output (this is the ground truth of what is still missing or wrong):', '```', result.output || '(no output)', '```'];
  return [
    `[验收未通过 ${attempt}/${maxAttempts}] The task is not accepted yet: ${why}.`,
    ...detail,
    'Fix exactly what the check reports — do not redo or undo work that already satisfies it. Verify with the same kind of command the check uses, then reply in two lines with what you changed.',
    '',
    'Original task for reference:',
    taskText.length > 3000 ? taskText.slice(0, 3000) + '…' : taskText,
  ].join('\n');
}
