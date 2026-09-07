/** One lifetime ceiling shared by foreground execution and background scheduling. */
export const SESSION_TOKEN_BUDGET = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_TOKEN_BUDGET);
  return Number.isInteger(n) && n >= 50_000 ? n : 300_000;
})();

export function exploreBudgetExhausted(session: { budgetSpent: number }): boolean {
  return session.budgetSpent >= SESSION_TOKEN_BUDGET;
}

export function exploreBudgetNotice(session: { budgetSpent: number }): string {
  return `探索累计 token 预算已耗尽（${session.budgetSpent}/${SESSION_TOKEN_BUDGET}）。本次没有启动新一轮；“继续”或“自动推进”只补充批次轮数，不会增加累计预算。需要明确调整预算后才能恢复。`;
}
