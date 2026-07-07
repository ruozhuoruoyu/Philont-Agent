/**
 * /autonomy status surface (selfhood_closure WS6 §8).
 *
 * One builder, two consumers:
 *   - GET /api/autonomous/selfhood (index.ts) → JSON for the web-ui dashboard's Selfhood section
 *   - the '/autonomy' chat command (chat-handler) → renderSelfhoodStatusText for WeChat/CLI
 *
 * Observability is half of felt selfhood: the traits, the self-model, the agenda and the pending
 * identity proposals become VISIBLE, not just operative. Read-only — this module never writes.
 */

import {
  listSelfObservations,
  renderProposalCard,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  type ConstitutionProposalStore,
  type MemoryStore,
  type PursuitStore,
  type TraitProfile,
  type InitiativeStore,
  type BudgetTracker,
} from '@agent/memory';

export interface SelfhoodPursuit {
  id: string;
  title: string;
  stakeWeight: number;
  lastTouchedAt: number;
  evidenceCount: number;
}

export interface SelfhoodStatus {
  traits: TraitProfile & { live: boolean };
  observations: Array<{ key: string; content: string; sinceTs: number }>;
  pursuits: SelfhoodPursuit[];
  proposals: Array<{ id: string; kind: string; card: string; createdAt: number }>;
  initiativesToday: { done: number };
  initiativesTotalByStatus: Record<string, number>;
  budget: { llmTokensUsed: number; toolCallsUsed: number; initiativesRun: number };
}

export interface SelfhoodStatusDeps {
  traits: () => TraitProfile;
  traitsLive: boolean;
  facts: MemoryStore;
  pursuits: PursuitStore;
  proposals: ConstitutionProposalStore;
  initiatives: InitiativeStore;
  budget: BudgetTracker;
  userId?: string;
  rootPursuitId?: string;
}

export function buildSelfhoodStatus(
  deps: SelfhoodStatusDeps,
  now: number = Date.now(),
): SelfhoodStatus {
  const rootId = deps.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
  const userId = deps.userId ?? 'default';

  const active = deps.pursuits
    .listActive(rootId)
    .filter((p) => p.id !== rootId)
    .sort((a, b) => b.stakeWeight - a.stakeWeight)
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      title: p.title,
      stakeWeight: p.stakeWeight,
      lastTouchedAt: p.lastTouchedAt,
      evidenceCount: p.evidenceRefs.length,
    }));

  const startOfDay = now - (now % 86_400_000);
  const doneToday = deps.initiatives.listRecentDone(startOfDay, 100).length;
  const byStatus = deps.initiatives.countByStatusGroup();

  const usage = deps.budget.getDailyUsage(userId, now);

  return {
    traits: { ...deps.traits(), live: deps.traitsLive },
    observations: listSelfObservations(deps.facts, 5).map((o) => ({
      key: o.key,
      content: o.content,
      sinceTs: o.sinceTs,
    })),
    pursuits: active,
    proposals: deps.proposals.listPending(rootId, 5).map((p) => ({
      id: p.id,
      kind: p.kind,
      card: renderProposalCard(p),
      createdAt: p.createdAt,
    })),
    initiativesToday: { done: doneToday },
    initiativesTotalByStatus: byStatus,
    budget: {
      llmTokensUsed: usage.llmTokensUsed,
      toolCallsUsed: usage.toolCallsUsed,
      initiativesRun: usage.initiativesRun,
    },
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function daysAgo(ts: number, now: number): string {
  if (!(ts > 0)) return '—';
  const d = Math.floor((now - ts) / 86_400_000);
  return d <= 0 ? '今天' : `${d}天前`;
}

/** Chinese status text for the '/autonomy' chat command (WeChat / CLI have no dashboard). */
export function renderSelfhoodStatusText(s: SelfhoodStatus, now: number = Date.now()): string {
  const lines: string[] = [];
  lines.push('🧭 自主状态');
  lines.push(
    `人格(${s.traits.live ? '实时' : '冻结默认'}): 好胜 ${pct(s.traits.competitiveness)} · ` +
      `好奇 ${pct(s.traits.curiosity)} · 尽责 ${pct(s.traits.conscientiousness)}`,
  );
  lines.push(
    `今日自主工作: 完成 ${s.initiativesToday.done} 件 · ` +
      `${s.budget.llmTokensUsed} tokens · ${s.budget.toolCallsUsed} 次工具调用`,
  );
  if (s.pursuits.length > 0) {
    lines.push('在追目标:');
    for (const p of s.pursuits.slice(0, 5)) {
      lines.push(
        `  · ${p.title} (stake ${p.stakeWeight}/10, 上次推进 ${daysAgo(p.lastTouchedAt, now)}, 证据 ${p.evidenceCount})`,
      );
    }
  } else {
    lines.push('在追目标: 暂无 — 想让我持续盯着什么,直接说。');
  }
  if (s.observations.length > 0) {
    lines.push('我对自己的观察(有据):');
    for (const o of s.observations) lines.push(`  · ${o.content}`);
  }
  if (s.proposals.length > 0) {
    lines.push('待你决定的宪法修正提案:');
    for (const p of s.proposals) lines.push(`  · ${p.card}`);
    lines.push('  回复"同意提案 <id前8位>"或"拒绝提案 <id前8位>"。');
  }
  return lines.join('\n');
}

/** The chat messages that trigger the status command (exact match after trim). */
export function isAutonomyStatusCommand(userMessage: string): boolean {
  const m = userMessage.trim().toLowerCase();
  return m === '/autonomy' || m === '自主状态' || m === '/自主';
}
