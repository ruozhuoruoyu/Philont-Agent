import { classifyToolResult, looksLikeCredential } from '@agent/memory';

interface LedgerRecord {
  toolName: string;
  content: string;
}

/**
 * The most informative line of a tool result — enough to say WHAT it produced, not just that it ran.
 * A success puts its output on the lines AFTER the marker; a failure puts the reason ON the marker line
 * (`⚠ TOOL FAILED — [exitCode=1] …`), so reading only the body would drop exactly the failures.
 */
function firstFactLine(content: string): string {
  const [marker = '', ...rest] = content.split('\n');
  const body = rest.map((l) => l.trim()).filter(Boolean);
  const reason = marker.includes('—') ? marker.slice(marker.indexOf('—') + 1).trim() : '';
  const line = body[0] || reason;
  if (!line) return '';
  // This path quotes raw tool output to a chat channel with no model in between to leave things out —
  // a readFile of an .env, a shell that echoed a token, and the deterministic reply would publish it
  // verbatim. Drop the WHOLE line on any credential-shaped token: losing one fact line costs nothing,
  // and this asymmetry is the one credential_shape.ts was written for.
  const tokens = line.split(/[\s,;'"(){}\[\]<>]+/).filter(Boolean);
  if (tokens.some((t) => looksLikeCredential(t))) {
    return '(withheld — this line contains credential-shaped text)';
  }
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/**
 * Deterministic final reply after the model failed the honesty gate twice. Ledger facts only.
 *
 * Two things this must get right, both learned from prod 2026-09-01 09:13, where the fallback correctly
 * blocked an unsupported "Lean 验证，无 sorry":
 *
 *  • It MUST carry the `## 给用户` / `## For User` heading. Without it the WeChat output filter logged
 *    `sectionHit: false` and fell back to shipping the raw text — a mechanism-authored reply that trips
 *    the channel's own contract is not a safe reply, it is one more thing to fix later.
 *  • "23 tools succeeded" is not a report. The owner asked what happened; the honest answer is what the
 *    tools actually returned. The model's SUMMARY is what was rejected, not the tool output, so the
 *    output can be quoted as-is — that is exactly the material a claim must be built on.
 */
export function renderHonestyFallback(
  records: ReadonlyArray<LedgerRecord>,
  language: 'zh' | 'en' = 'zh',
): string {
  const en = language === 'en';
  const ok = records.filter((r) => classifyToolResult(r.content) === 'ok');
  const failed = records.filter((r) => classifyToolResult(r.content) === 'fail');
  const unknown = records.filter((r) => classifyToolResult(r.content) === 'unknown');
  const names = (xs: ReadonlyArray<LedgerRecord>): string =>
    xs.length ? [...new Set(xs.map((r) => r.toolName))].join(', ') : en ? 'none' : '无';

  const lines: string[] = [
    en ? '## For User' : '## 给用户',
    '',
    en
      ? 'The summary written for this turn made a claim the tool ledger does not support, and the rewrite ' +
        'made it again — so it is not being published. What the tools actually did:'
      : '本轮生成的总结里有工具账本不支持的结论，重写后仍然如此，因此不予发布。以下是工具实际做了什么：',
    '',
    en
      ? `- ${ok.length} succeeded (${names(ok)})`
      : `- 成功 ${ok.length}（${names(ok)}）`,
    en
      ? `- ${failed.length} failed (${names(failed)})`
      : `- 失败 ${failed.length}（${names(failed)}）`,
    en
      ? `- ${unknown.length} unknown (${names(unknown)})`
      : `- 状态不明 ${unknown.length}（${names(unknown)}）`,
  ];

  const lastFacts = records.slice(-5).map((r) => {
    const mark = classifyToolResult(r.content);
    const symbol = mark === 'ok' ? '✓' : mark === 'fail' ? '⚠' : '?';
    const fact = firstFactLine(r.content);
    return `- ${symbol} ${r.toolName}${fact ? `: ${fact}` : ''}`;
  });
  if (lastFacts.length) {
    lines.push('', en ? `**Last ${lastFacts.length} tool results**:` : `**最近 ${lastFacts.length} 条工具结果**:`, ...lastFacts);
  }
  lines.push(
    '',
    en
      ? 'No completion, numeric, or proof claim beyond the above is being made.'
      : '除以上内容外，本轮不作任何完成、数值或证明结论。',
  );
  return lines.join('\n');
}
