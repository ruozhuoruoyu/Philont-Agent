/**
 * The lifetime token ceiling of a reasoning session, and the one way past it.
 *
 * Until 2026-09-10 the ceiling was a constant and `budget_spent` only ever grew, so a session that crossed
 * it was dead for good: `auto_on` refused, the forced-continue path returned null, and the notice the
 * owner got said "需要明确调整预算后才能恢复" — naming an action that existed nowhere in the product. The
 * owner's main proof (89 nodes proved) crossed 300 000 on 2026-09-0x and then sat for a week while they
 * typed 继续 fifteen times; the engine never ran another round and nothing told them why in a way they
 * could act on.
 *
 * Now the ceiling is `SESSION_TOKEN_BUDGET + budgetGranted`, and `budgetGranted` moves only when the owner
 * answers a budget card. Spend and grant stay separate columns so the ledger still says what was spent
 * and what was allowed.
 */
import type { ReasoningSession } from '@agent/memory';

/** One lifetime ceiling shared by foreground execution and background scheduling. */
export const SESSION_TOKEN_BUDGET = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_TOKEN_BUDGET);
  return Number.isInteger(n) && n >= 50_000 ? n : 300_000;
})();

/** How much one 同意 buys. Default: another full ceiling — one card, one predictable unit. */
export const EXPLORE_BUDGET_GRANT_TOKENS = (() => {
  const n = Number(process.env.PHILONT_DEEP_EXPLORE_BUDGET_GRANT);
  return Number.isInteger(n) && n >= 10_000 ? n : SESSION_TOKEN_BUDGET;
})();

type BudgetView = Pick<ReasoningSession, 'budgetSpent'> & Partial<Pick<ReasoningSession, 'budgetGranted'>>;

export function exploreBudgetCeiling(session: BudgetView): number {
  return SESSION_TOKEN_BUDGET + Math.max(0, session.budgetGranted ?? 0);
}

export function exploreBudgetExhausted(session: BudgetView): boolean {
  return session.budgetSpent >= exploreBudgetCeiling(session);
}

/**
 * The budget card. This text IS the interface: it is pushed to the owner, returned to the model, and
 * printed by the resume path, so it must offer exactly the words `classifyGrantReply` listens for.
 */
export function exploreBudgetNotice(session: BudgetView & { goal?: string }, lang: 'zh' | 'en' = 'zh'): string {
  const goal = (session.goal ?? '').slice(0, 40);
  const spent = session.budgetSpent;
  const ceiling = exploreBudgetCeiling(session);
  const grant = EXPLORE_BUDGET_GRANT_TOKENS;
  return lang === 'en'
    ? `💰 "${goal}" has spent its exploration budget (${spent}/${ceiling} tokens); no new round was started. ` +
      `Reply "approve" to grant another ${grant} tokens and let it continue (auto-advance resumes if it was on), ` +
      `or "reject" to leave it paused — nothing already proved is lost either way.`
    : `💰「${goal}」的探索累计预算已用完（${spent}/${ceiling} token），本次没有启动新一轮。` +
      `回复「同意」再给 ${grant} token 继续（原来开着的自动推进会恢复），或「拒绝」保持暂停——已证明的部分两种情况都不会丢。`;
}
