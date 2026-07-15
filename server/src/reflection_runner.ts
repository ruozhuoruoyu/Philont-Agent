/**
 * Reflection runner: triggers an async reflection LLM call after the main turn ends,
 * then parses and applies the result.
 *
 * Does not block the user response: fire-and-forget mode; reflection runs in the background
 * after the user has already seen the agent's reply. Failures are only logged; they do not
 * affect the turn outcome.
 *
 * Flow:
 *   1. collectReflectionState — compute trigger inputs from messages[]
 *      (turnCount / toolFailures / taskClosing)
 *   2. shouldTriggerReflection — evaluate whether to trigger (pure function, see agent-memory)
 *   3. No trigger → return immediately
 *   4. Trigger → callAuxLLM(reflectionPrompt + recent conversation context)
 *   5. parseReflectionOutput → validate → applyReflection → audit log
 *
 * Fire-and-forget: caller does not await; all exceptions are caught internally and only
 * printed to console.
 */

import type { NativeMessage } from './llm-adapter.js';
import {
  parseReflectionOutput,
  applyReflection,
  shouldTriggerReflection,
  renderReflectionPrompt,
  type ReflectionTriggerInput,
  type SkillStore,
  type RoutingRuleStore,
  type PlanStore,
  type MetricsStore,
} from '@agent/memory';
import type { AuditEventType } from '@agent/policy';
import { callAuxLLM } from '@agent/tools';

/** Regex for "task complete / done / finished" user expressions, used to detect task closing */
const TASK_CLOSING_RE =
  /(完成了?|搞定|搞好|结束|结题|没问题了?|可以了|好了|done|finished|all\s*set|wrap\s*up|that.?s\s*it)/i;

/**
 * Additional turn-local signals for reflection triggering.
 * chat-handler fills these in at turn close time and passes them in.
 */
/**
 * Which recent lesson-playbooks are superseded by an executable artifact just produced for `taskSignature`.
 *
 * A playbook name is `playbook-<sig>-<hash>`; the sig regex extracts "<sig>-fail" for plan-failure
 * playbooks, so those (a stronger, curated signal) are intentionally NOT matched here and are never
 * auto-retired. Already-deprecated playbooks are skipped. Pure + unit-testable (the retirement itself —
 * setMaturity('deprecated') — is done by the caller). See self_learning_redesign Phase 0.2.
 */
export function playbooksSupersededBy<T extends { name: string; maturity: string }>(
  recentPlaybooks: ReadonlyArray<T>,
  taskSignature: string,
): T[] {
  const out: T[] = [];
  for (const pb of recentPlaybooks) {
    if (pb.maturity === 'deprecated') continue;
    const sigMatch = pb.name.match(/^playbook-(.+?)-[a-z0-9]+$/);
    if (!sigMatch) continue;
    if (sigMatch[1] !== taskSignature) continue;
    out.push(pb);
  }
  return out;
}

export interface ReflectionTurnSignals {
  /** Whether HonestyGate fired this turn (any reason counts) */
  honestyFired?: boolean;
  /** Whether InterruptDrainer drained ≥ 1 critical/high/normal signal this turn */
  interruptDrained?: boolean;
  /** Consecutive failures with the same root cause (not yet wired up; interface reserved for future audit-cross-turn implementation) */
  sameRootCauseFailures?: number;
  /** Turn start timestamp (ms), used to compute taskDurationMin */
  turnStartTs?: number;
  /**
   * 2026-05-15: Whether this turn was forcibly degraded by the mechanism layer
   * (plan-circuit-breaker / in-turn-tool-block not recovered / plan auto-close failure).
   * true → reflection uses negative-distillation prompt + applyReflection rejects new_skill / skill_refine.
   */
  turnDegraded?: boolean;
  /**
   * Phase 14 (2026-05-18): successful turn within a scheduled session
   * (outcome=ok|partial + httpOk ≥ 1).
   * true → triggers plan_knowledge distillation path (reflection prompt guides LLM to extract
   * success_endpoints and write them into the plan.md Operational Knowledge section).
   */
  scheduledSuccess?: boolean;
}

/**
 * Compute reflection trigger inputs from the message array and the current user message.
 *
 * Fields:
 *   - turnCount: number of user role + string content messages (each user input counts as 1)
 *   - toolFailures: number of tool_result messages whose content starts with ⚠ or TOOL FAILED
 *   - taskClosing: whether the current user message contains a completion phrase
 *   - honestyFired / interruptDrained / taskDurationMin: derived from caller-supplied ReflectionTurnSignals
 *   - sameRootCauseFailures: temporarily fixed at 0; cross-turn audit correlation deferred to phase D
 */
export function collectReflectionState(
  messages: ReadonlyArray<NativeMessage>,
  userMessage: string,
  signals: ReflectionTurnSignals = {},
): ReflectionTriggerInput {
  let turnCount = 0;
  let toolFailures = 0;

  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      turnCount++;
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: string }).type === 'tool_result'
        ) {
          const c = (part as { content?: unknown }).content;
          if (typeof c === 'string' && (c.startsWith('⚠') || /TOOL\s*FAILED/i.test(c))) {
            toolFailures++;
          }
        }
      }
    }
  }

  const taskDurationMin =
    signals.turnStartTs && signals.turnStartTs > 0
      ? Math.max(0, (Date.now() - signals.turnStartTs) / 60_000)
      : 0;

  return {
    turnCount,
    toolFailures,
    taskClosing: TASK_CLOSING_RE.test(userMessage),
    honestyFired: signals.honestyFired === true,
    interruptDrained: signals.interruptDrained === true,
    sameRootCauseFailures: Math.max(0, signals.sameRootCauseFailures ?? 0),
    taskDurationMin,
    turnDegraded: signals.turnDegraded === true,
    scheduledSuccess: signals.scheduledSuccess === true,
  };
}

/**
 * Render the last N assistant/user messages as LLM reflection context.
 * tool_use / tool_result entries are replaced with [tool] placeholders to control prompt length.
 */
function renderRecentContext(messages: ReadonlyArray<NativeMessage>, n: number): string {
  const recent = messages.slice(-n);
  const lines: string[] = [];
  for (const m of recent) {
    if (typeof m.content === 'string') {
      const txt = m.content.length > 400 ? m.content.slice(0, 400) + '…' : m.content;
      lines.push(`${m.role.toUpperCase()}: ${txt}`);
    } else if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const p of m.content) {
        const t = (p as { type?: string }).type;
        if (t === 'tool_use') {
          const name = (p as { name?: string }).name ?? '?';
          parts.push(`[tool_use:${name}]`);
        } else if (t === 'tool_result') {
          const c = (p as { content?: unknown }).content;
          const txt = typeof c === 'string' ? c.slice(0, 200) : '<…>';
          parts.push(`[tool_result] ${txt}`);
        }
      }
      if (parts.length > 0) {
        lines.push(`${m.role.toUpperCase()}: ${parts.join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}

export interface ReflectionRunOptions {
  sessionId: string;
  messages: ReadonlyArray<NativeMessage>;
  userMessage: string;
  skills: SkillStore;
  routingRules: RoutingRuleStore;
  /** v17 (2026-05-11): PlanStore, supports plan_revision learning; optional — omitting skips plan_revision */
  plans?: PlanStore;
  /**
   * Phase 14 (2026-05-18): PlanFileStore-shaped object, supports plan_knowledge learning.
   * Omitting causes plan_knowledge learning to go into errors (non-blocking for other learning).
   */
  planFiles?: {
    appendKnowledge: (project: string, entry: string, subsection?: string) => boolean;
  };
  /** Audit persistence callback; signature matches chat-handler.internalAudit.append */
  appendAudit?: (
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ) => void;
  /** Maximum number of messages the context LLM sees; default 12 */
  contextWindow?: number;
  /** 2026-06-22: optional instrumentation counters (turn-close reflection fire/skip/production). */
  metrics?: MetricsStore;
  /**
   * Turn-local signals (honesty fire / interrupt drain / task start timestamp).
   * chat-handler fills these at turn close; defaults are backward-compatible (all false/0).
   */
  signals?: ReflectionTurnSignals;
}

/**
 * 2026-06-08: per-session reflection cooldown. On a persistent failure (e.g. mycox same_root_cause
 * failures sitting in the 24h window) the SAME reason-set triggers reflection every single turn —
 * re-running the fire-and-forget reflection LLM call and writing a fresh `reflection_triggered`
 * audit entry each time. That wasted tokens and made failure_recovery_inject pile up identical
 * hints (1→2→3→4). Skip re-firing for the same reason-set within the cooldown; a genuinely new
 * signal (different reasons) bypasses it. In-memory (per process) — exactly the right scope, since
 * the goal is just to not spam within a session.
 */
const REFLECTION_COOLDOWN_MS = 10 * 60_000;
const lastReflectionFire = new Map<string, { ts: number; reasonsKey: string }>();

/**
 * Evaluate and execute reflection. Fire-and-forget: caller does not await; all exceptions
 * are caught internally.
 *
 * The `messages` parameter is a complete snapshot after the current turn has fully executed.
 *
 * Never throws: any error is caught and only printed via console.warn.
 */
export async function maybeRunReflection(opts: ReflectionRunOptions): Promise<void> {
  try {
    const state = collectReflectionState(
      opts.messages,
      opts.userMessage,
      opts.signals,
    );
    const decision = shouldTriggerReflection(state);
    if (!decision.shouldFire) {
      // Even when reflection is not triggered, ≥ 3 tool failures in this turn count as a
      // "soft failure" — write a task_failure_mode audit event; failure_recovery_inject
      // in the next turn will match it and prompt the LLM to switch to planAndExecute / searchSkills.
      if (state.toolFailures >= 3 && opts.appendAudit) {
        opts.appendAudit('task_failure_mode', {
          sessionId: opts.sessionId,
          kind: 'tool_failure_burst',
          ts: Date.now(),
          detail: `${state.toolFailures} tool failures this turn (below reflection threshold)`,
        });
      }
      return;
    }

    // Cooldown: same reason-set on the same session within REFLECTION_COOLDOWN_MS → skip (see above).
    const reasonsKey = decision.reasons.slice().sort().join(',');
    const prevFire = lastReflectionFire.get(opts.sessionId);
    if (prevFire && prevFire.reasonsKey === reasonsKey && Date.now() - prevFire.ts < REFLECTION_COOLDOWN_MS) {
      console.log(
        `[reflection] session=${opts.sessionId} skipped (same reasons "${reasonsKey}" fired ` +
          `${Math.round((Date.now() - prevFire.ts) / 60_000)}min ago, within ${REFLECTION_COOLDOWN_MS / 60_000}min cooldown)`,
      );
      opts.metrics?.increment('reflect.skip_cooldown'); // instrumentation: how often reflection is suppressed
      return;
    }
    lastReflectionFire.set(opts.sessionId, { ts: Date.now(), reasonsKey });

    console.log(
      `[reflection] session=${opts.sessionId} triggered reasons=${decision.reasons.join(',')} ` +
        `turnCount=${state.turnCount} toolFailures=${state.toolFailures} taskClosing=${state.taskClosing}`,
    );

    // task_failure_mode audit: triggering reflection is itself a "soft failure" signal —
    // the task has significant anomalies (same root-cause failures / long turn / honesty fired /
    // interrupt drained) that warrant a strategy change. failure_recovery_inject in the next
    // turn matches this audit event and suggests planAndExecute.
    if (opts.appendAudit) {
      opts.appendAudit('task_failure_mode', {
        sessionId: opts.sessionId,
        kind: 'reflection_triggered',
        ts: Date.now(),
        detail: `reasons=${decision.reasons.join(',')} turnCount=${state.turnCount} toolFailures=${state.toolFailures}`,
      });
    }

    const prompt = renderReflectionPrompt(decision.reasons, state.turnDegraded);
    const ctxN = opts.contextWindow ?? 12;
    const recentCtx = renderRecentContext(opts.messages, ctxN);

    // 2026-05-11: playbook → routing_rule secondary distillation. Inject recent playbook
    // candidates into the reflection LLM to guide it in judging "can a routing_rule be
    // extracted to cover these lessons". Not forced — only provides candidate material.
    // Routing_rules produced here are persisted; these playbooks are then asynchronously
    // marked as promoted (for traceability).
    const recentPlaybooks = opts.skills.listByMaturity('playbook', 8);
    const playbookContext = recentPlaybooks.length > 0
      ? `\n\n## 已有 playbook 候选(考虑能否升级为 routing_rule 或 new_skill)\n` +
        `(若本次反思能写出"trigger_condition + prefer_skill"覆盖下列任一教训,优先写 routing_rule 而不是再加 playbook)\n` +
        recentPlaybooks
          .map((p) => {
            const sigMatch = p.name.match(/^playbook-(.+?)-[a-z0-9]+$/);
            const sig = sigMatch ? sigMatch[1] : 'unknown';
            const body = p.description.split('\n').slice(0, 3).join(' / ');
            return `- [${sig}] ${body.slice(0, 200)}`;
          })
          .join('\n')
      : '';

    const userPart =
      `${prompt}\n\n## 最近对话上下文(用于蒸馏)\n${recentCtx}` +
      `${playbookContext}\n\n` +
      `仅输出 JSON。不要解释。不要 prose。`;

    let llmResponse: string;
    try {
      llmResponse = await callAuxLLM({
        system: '你正在做任务收口反思。仅按要求输出 JSON,不要任何 prose。',
        user: userPart,
        maxTokens: 2048,
      });
    } catch (e) {
      console.warn(`[reflection] aux LLM call failed: ${String(e).slice(0, 200)}`);
      return;
    }

    const parsed = parseReflectionOutput(llmResponse);
    if (!parsed.ok) {
      console.warn(
        `[reflection] session=${opts.sessionId} parse failed: ${parsed.errors.slice(0, 3).join('; ').slice(0, 300)}`,
      );
      opts.appendAudit?.('self_domain_write', {
        source: 'reflection',
        origin: 'Internal',
        toolName: 'reflection_parse_failed',
        sessionId: opts.sessionId,
        reasons: decision.reasons,
        errors: parsed.errors.slice(0, 5),
      });
      return;
    }

    const reflection = parsed.reflection!;
    if (!reflection.hadLesson) {
      console.log(`[reflection] session=${opts.sessionId} LLM self-assessed had_lesson=false; skipping apply`);
      opts.appendAudit?.('self_domain_write', {
        source: 'reflection',
        origin: 'Internal',
        toolName: 'reflection_no_lesson',
        sessionId: opts.sessionId,
        reasons: decision.reasons,
      });
      return;
    }

    const reflectionId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const result = applyReflection(
      reflection,
      {
        skills: opts.skills,
        routingRules: opts.routingRules,
        plans: opts.plans,
        planFiles: opts.planFiles,
        reflectionId,
      },
      { turnDegraded: state.turnDegraded },
    );

    opts.appendAudit?.('self_domain_write', {
      source: 'reflection',
      origin: 'Internal',
      toolName: 'reflection_applied',
      sessionId: opts.sessionId,
      reflectionId,
      reasons: decision.reasons,
      taskSignature: reflection.taskSignature,
      stats: result.stats,
      errorCount: result.errors.length,
    });

    // 2026-05-11 / retired 2026-07-15 (self_learning_redesign Phase 0.2): if this reflection produced an
    // executable artifact (routing_rule / new_skill / skill_refine) with the SAME task_signature as an
    // existing lesson-playbook, that playbook's advice is now encoded in something actionable — so RETIRE
    // it (maturity → 'deprecated', terminal, excluded from both playbook injection paths which select via
    // listByMaturity('playbook', …)).
    //
    // The original code only appended a "[已纳入 reflection]" note to the description and left a comment
    // saying "the next prefix render can filter out already-promoted ones" — but the render never
    // implemented that filter, so a superseded playbook was injected forever alongside the rule that
    // superseded it. Detected, marked, and never acted on: the exact "never retired" hole. Scope note: the
    // sig regex extracts "<sig>-fail" for plan-failure playbooks, so those (a stronger signal) are never
    // matched here and are not auto-retired.
    const producedExecutable =
      result.stats.routingRulesCreated > 0 ||
      result.stats.newSkillsCreated > 0 ||
      result.stats.skillsRefined > 0;
    if (producedExecutable && recentPlaybooks.length > 0) {
      let promotedCount = 0;
      for (const pb of playbooksSupersededBy(recentPlaybooks, reflection.taskSignature)) {
        try {
          // Retire it, and leave a one-line trace of why on the description.
          opts.skills.updateSkill(pb.name, {
            description: `${pb.description}\n[superseded by reflection#${reflectionId} — retired]`,
          });
          opts.skills.setMaturity(pb.name, 'deprecated');
          promotedCount++;
        } catch {
          // updateSkill/setMaturity failure does not affect main flow
        }
      }
      if (promotedCount > 0) {
        // Visible in the production log, matching the [skill-funnel]/[autonomy-funnel] instrumentation —
        // retirement was previously silent (self_learning_redesign Phase 0.3).
        console.log(
          `[learning] retired ${promotedCount} superseded playbook(s) for sig="${reflection.taskSignature}" ` +
            `(now encoded in a routing_rule/skill from reflection#${reflectionId})`,
        );
        opts.appendAudit?.('self_domain_write', {
          source: 'reflection',
          origin: 'Internal',
          toolName: 'playbook_retired',
          sessionId: opts.sessionId,
          reflectionId,
          taskSignature: reflection.taskSignature,
          promotedCount,
        });
      }
    }

    // instrumentation: turn-close reflection fired + what it actually produced
    opts.metrics?.increment('reflect.fire');
    opts.metrics?.increment('reflect.routing_rule', result.stats.routingRulesCreated);
    opts.metrics?.increment('reflect.playbook', result.stats.playbooksCreated);
    opts.metrics?.increment('reflect.new_skill', result.stats.newSkillsCreated);
    opts.metrics?.increment('reflect.skill_refine', result.stats.skillsRefined);

    console.log(
      `[reflection] session=${opts.sessionId} reflectionId=${reflectionId} ` +
        `applied=${result.applied.length} routing=${result.stats.routingRulesCreated} ` +
        `playbooks=${result.stats.playbooksCreated} new_skills=${result.stats.newSkillsCreated} ` +
        `refined=${result.stats.skillsRefined} errors=${result.errors.length}`,
    );
  } catch (e) {
    // Reflection failures must never affect the main flow
    console.warn(`[reflection] exception caught: ${String(e).slice(0, 300)}`);
  }
}
