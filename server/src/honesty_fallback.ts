import { classifyToolResult } from '@agent/memory';

interface LedgerRecord {
  toolName: string;
  content: string;
}

/** Deterministic final reply after the model failed the honesty gate twice. Contains ledger facts only. */
export function renderHonestyFallback(
  records: ReadonlyArray<LedgerRecord>,
  language: 'zh' | 'en' = 'zh',
): string {
  const ok = records.filter((r) => classifyToolResult(r.content) === 'ok').map((r) => r.toolName);
  const failed = records.filter((r) => classifyToolResult(r.content) === 'fail').map((r) => r.toolName);
  const unknown = records.filter((r) => classifyToolResult(r.content) === 'unknown').map((r) => r.toolName);
  const names = (xs: string[]): string => xs.length ? xs.join(', ') : language === 'zh' ? '无' : 'none';
  return language === 'zh'
    ? `本轮无法安全采用模型生成的总结；第二次诚实校验仍未通过。工具账本：成功 ${ok.length}（${names(ok)}），失败 ${failed.length}（${names(failed)}），状态不明 ${unknown.length}（${names(unknown)}）。未被工具账本支持的完成、数值或证明结论均不作发布。`
    : `The model summary could not be published safely because it failed the second honesty check. Tool ledger: ${ok.length} succeeded (${names(ok)}), ${failed.length} failed (${names(failed)}), ${unknown.length} unknown (${names(unknown)}). No unsupported completion, numeric, or proof claim is being published.`;
}
