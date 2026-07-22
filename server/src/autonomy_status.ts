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

import type { PhraseLang } from './channel_phrases.js';
import { renderAutonomyReach, type AutonomyReachSummary } from './autonomy_reach.js';
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
  /** 24h findings-vs-reached summary; omitted when the caller does not supply one. */
  reach?: AutonomyReachSummary;
}

export interface SelfhoodStatusDeps {
  traits: () => TraitProfile;
  traitsLive: boolean;
  facts: MemoryStore;
  pursuits: PursuitStore;
  proposals: ConstitutionProposalStore;
  initiatives: InitiativeStore;
  budget: BudgetTracker;
  reach?: () => AutonomyReachSummary;
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
    reach: deps.reach?.(),
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

function daysAgo(ts: number, now: number, lang: PhraseLang): string {
  if (!(ts > 0)) return '—';
  const d = Math.floor((now - ts) / 86_400_000);
  if (lang === 'en') return d <= 0 ? 'today' : `${d}d ago`;
  return d <= 0 ? '今天' : `${d}天前`;
}

/** Status text for the '/autonomy' chat command (WeChat / CLI have no dashboard). */
export function renderSelfhoodStatusText(
  s: SelfhoodStatus,
  now: number = Date.now(),
  lang: PhraseLang = 'zh',
): string {
  const lines: string[] = [];
  const en = lang === 'en';
  lines.push(en ? '🧭 Autonomy status' : '🧭 自主状态');
  lines.push(
    en
      ? `Traits (${s.traits.live ? 'live' : 'frozen defaults'}): drive ${pct(s.traits.competitiveness)} · ` +
          `curiosity ${pct(s.traits.curiosity)} · diligence ${pct(s.traits.conscientiousness)}`
      : `人格(${s.traits.live ? '实时' : '冻结默认'}): 好胜 ${pct(s.traits.competitiveness)} · ` +
          `好奇 ${pct(s.traits.curiosity)} · 尽责 ${pct(s.traits.conscientiousness)}`,
  );
  lines.push(
    en
      ? `Autonomous work today: ${s.initiativesToday.done} done · ` +
          `${s.budget.llmTokensUsed} tokens · ${s.budget.toolCallsUsed} tool calls`
      : `今日自主工作: 完成 ${s.initiativesToday.done} 件 · ` +
          `${s.budget.llmTokensUsed} tokens · ${s.budget.toolCallsUsed} 次工具调用`,
  );
  // How much of that work ever reached the person it was done for. The nine delivery gates are correct
  // and stay untouched; what was missing is that their aggregate outcome was only ever written to a
  // console the owner does not read — so an hour of findings and zero messages was indistinguishable
  // from a dead feature. See autonomy_reach.ts.
  if (s.reach) lines.push(renderAutonomyReach(s.reach, en ? 'en' : 'zh'));
  if (s.pursuits.length > 0) {
    lines.push(en ? 'Pursuing:' : '在追目标:');
    for (const p of s.pursuits.slice(0, 5)) {
      lines.push(
        en
          ? `  · ${p.title} (stake ${p.stakeWeight}/10, last advanced ${daysAgo(p.lastTouchedAt, now, lang)}, ${p.evidenceCount} evidence)`
          : `  · ${p.title} (stake ${p.stakeWeight}/10, 上次推进 ${daysAgo(p.lastTouchedAt, now, lang)}, 证据 ${p.evidenceCount})`,
      );
    }
  } else {
    lines.push(
      en
        ? 'Pursuing: nothing yet — tell me what to keep an eye on.'
        : '在追目标: 暂无 — 想让我持续盯着什么,直接说。',
    );
  }
  if (s.observations.length > 0) {
    lines.push(en ? 'What I have observed about myself (evidenced):' : '我对自己的观察(有据):');
    for (const o of s.observations) lines.push(`  · ${o.content}`);
  }
  if (s.proposals.length > 0) {
    lines.push(en ? 'Constitution amendments awaiting your decision:' : '待你决定的宪法修正提案:');
    for (const p of s.proposals) lines.push(`  · ${p.card}`);
    lines.push(
      en
        ? '  Reply "approve proposal <first 8 chars>" or "reject proposal <first 8 chars>".'
        : '  回复"同意提案 <id前8位>"或"拒绝提案 <id前8位>"。',
    );
  }
  return lines.join('\n');
}

/**
 * Match the words THIS PANEL just offered — in both languages, always.
 *
 * Until 2026-07-14 there was NO matcher for these words anywhere in the repo: the panel told the owner to
 * reply "同意提案 <id前8位>" and literally nothing listened. The decision could only land if the model
 * spontaneously noticed and called decide_constitution_proposal — with an id it had never seen in full,
 * against a store that did exact-id lookup. So the constitution-amendment approval path, the capstone of the
 * selfhood design, could not be completed by an owner following our own on-screen instructions.
 *
 * The id we PRINT is 8 chars, so the id we ACCEPT must be too (see ConstitutionProposalStore.getByIdOrPrefix).
 * Both vocabularies are matched regardless of the panel's rendered language — a bilingual owner will type
 * 同意提案 at an English panel, and being strict there punishes them for a setting they never saw.
 */
export function classifyProposalReply(
  userMessage: string,
): { decision: 'approve' | 'reject'; idPrefix: string } | null {
  const m = (userMessage ?? '').trim().replace(/["'「」]/g, '');
  const re = /^(同意提案|批准提案|拒绝提案|驳回提案|approve\s+proposal|reject\s+proposal)\s+([0-9a-fA-F-]{4,36})$/i;
  const hit = re.exec(m);
  if (!hit) return null;
  const verb = hit[1].toLowerCase();
  const decision = /拒绝|驳回|reject/.test(verb) ? 'reject' : 'approve';
  return { decision, idPrefix: hit[2].toLowerCase() };
}

/** The chat messages that trigger the status command (exact match after trim). */
export function isAutonomyStatusCommand(userMessage: string): boolean {
  const m = userMessage.trim().toLowerCase();
  return m === '/autonomy' || m === '自主状态' || m === '/自主';
}
