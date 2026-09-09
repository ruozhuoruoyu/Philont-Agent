/** Reject unchanged timeout retries, without disabling unrelated diagnostic shell commands. */
export function shellTimeoutRetryRejection(
  input: Record<string, unknown>,
  records: readonly { toolName: string; success: boolean; toolInput?: Record<string, unknown>; resultText?: string }[],
): string | null {
  const command = String(input.command ?? '').trim();
  const failures = records.filter((r) => r.toolName === 'shell' && !r.success &&
    String(r.toolInput?.command ?? '').trim() === command &&
    /killed=true|shell:timeout|timed out|did not finish within/.test(r.resultText ?? ''));
  if (!failures.length) return null;
  if (failures.length >= 3) return 'This command timed out three times. Diagnose or split the work; no further retries of this command this turn.';
  const previousLimit = Math.max(...failures.map((r) => Number(r.toolInput?.timeout ?? 30_000)));
  if (Number(input.timeout ?? 30_000) <= previousLimit) {
    return `This command already timed out at ${previousLimit}ms. Retry only with a larger explicit timeout within the remaining turn budget, or use a different diagnostic command.`;
  }
  return null;
}
