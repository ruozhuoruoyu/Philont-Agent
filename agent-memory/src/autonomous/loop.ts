/**
 * AutonomousLoop — K8 initiative layer tick scheduler.
 *
 * Runs in parallel with IdleConsolidator, each handling its own concern:
 * IdleConsolidator does memory consolidation (extractor/reflector);
 * AutonomousLoop does proactive research. Both use setInterval + unref'd timers,
 * and each stops independently on SIGINT.
 *
 * Per-tick steps:
 *   1. Check enabled switch (config + environment variable)
 *   2. Check global kill switch (autonomous_budget daily budget not exhausted)
 *   3. Take MemorySnapshot (one SQLite read for facts/routing/skills/pursuits/recent tokens)
 *   4. Call all driver.propose() to collect candidates
 *   5. Sort by utility, dispatch sequentially (not in parallel, to avoid budget race + DB write conflicts)
 *   6. For each initiative: insert pending → markRunning → executor.run() →
 *      markDone/Failed/Skipped → budget commit → fire interrupt
 *   7. Once budget is exhausted within a tick, all remaining candidates are skipped
 *
 * Testing: exposes tickOnce() for synchronous await; fake clock can be injected.
 */

import type Database from 'better-sqlite3';
import type { MemoryStore } from '../store.js';
import type { NotesStore } from '../notes.js';
import type { RawStore } from '../raw.js';
import type { PursuitStore } from '../pursuit.js';
import type { SkillStore } from '../skills.js';
import type { RoutingRuleStore } from '../routing_rules.js';
import { BOOTSTRAP_ROOT_PURSUIT_ID } from '../schema.js';
import {
  BudgetTracker,
  DEFAULT_BUDGET_CAPS,
  type BudgetCaps,
} from './budget.js';
import { extractSpecificTokens } from './drivers/curiosity_driver.js';
import { InitiativeStore } from './initiatives.js';
import type {
  Driver,
  Initiative,
  InitiativeExecutor,
  InitiativeProposal,
  InitiativeRunResult,
  MemorySnapshot,
  OutcomeHook,
} from './types.js';

export type AutonomousInterruptKind =
  | 'discovery_made'
  | 'initiative_blocked';

export interface AutonomousInterruptPayload {
  kind: AutonomousInterruptKind;
  initiativeId: string;
  summary: string;
  /**
   * Which driver produced this, and what it was aimed at.
   *
   * `kind` has exactly two values and both are outcome shapes, so the funnel log could not distinguish a
   * curiosity lookup from a compass-anchored pursuit advance — every drop read `kind=discovery_made`
   * whatever produced it. That made the owner-funnel unwatchable in the one dimension that now matters:
   * whether the mechanism-side escalation (isOwnerDeclared) ever fires. Prod 2026-07-22: eight drops in
   * one tick, all identical in the log, all unattributable.
   */
  driver?: string;
  targetRef?: string;
}

/**
 * Minimal interface for the loop to fire interrupts. Injected from the server side;
 * pumps payload into Rust-side InterruptController.send_*() so the drainer can render it in the next turn.
 *
 * Does not reference napi types, to avoid agent-memory reverse-depending on server / agent-node.
 */
export interface InterruptSink {
  fire(severity: 'normal' | 'high', payload: AutonomousInterruptPayload): void;
}

/**
 * Audit hook for the loop (optional). Called once per tick.
 */
export interface AutonomousAuditHook {
  onTick(event: TickEvent): void;
}

export interface TickEvent {
  startedAt: number;
  durationMs: number;
  proposalsCollected: number;
  initiativesRun: number;
  llmTokensSpent: number;
  toolCallsSpent: number;
  skipped: number;
  failed: number;
  budgetExhausted: boolean;
}

export interface AutonomousLoopOptions {
  db: Database.Database;
  facts: MemoryStore;
  notes: NotesStore;
  raw: RawStore;
  skills: SkillStore;
  routingRules: RoutingRuleStore;
  pursuits: PursuitStore;
  drivers: readonly Driver[];
  executor: InitiativeExecutor;
  /** Default 5 minutes. PHILONT_AUTONOMOUS_TICK_MS env var overrides. */
  tickIntervalMs?: number;
  /** Default 'default' — fixed value for single-tenant; multi-tenant passes this via caller. */
  userId?: string;
  /** Default BOOTSTRAP_ROOT_PURSUIT_ID */
  rootPursuitId?: string;
  /** Default DEFAULT_BUDGET_CAPS */
  budgetCaps?: BudgetCaps;
  /** Explicitly disable (can be turned off in tests). Also responds to env var PHILONT_AUTONOMOUS=0. */
  enabled?: boolean;
  /** How many recent raw messages to extract specific tokens from. Default 200. */
  recentMessagesForTokens?: number;
  interrupt?: InterruptSink;
  /**
   * Does this initiative advance something the OWNER declared (a compass focus area)? Supplied as a
   * callback so agent-memory does not have to reach back into the pursuit/compass wiring — the same
   * shape PursuitDriver's `isGranted` uses. Undefined = never owner-declared (previous behaviour).
   *
   * Why it exists (2026-07-22): escalation to 'high' — the only severity that can reach the owner —
   * required the executor LLM to BOTH self-rate `shouldEscalate: true` AND emit at least one fact
   * carrying non-empty sourceRefs. That is three conditions, all of them judgements by a weak model
   * working inside a 2000-token per-initiative budget, ANDed together. Across three production logs and
   * a hundred-plus initiatives it passed zero times, and the owner's report was "I don't perceive the
   * autonomy at all".
   *
   * A compass focus is a better relevance signal than any self-rating, because it is the one place the
   * owner has literally written down what matters. It is also self-limiting: a compass pursuit advances
   * once at kickoff and then on the stalled cadence, so this cannot become a firehose.
   */
  isOwnerDeclared?: (targetRef: string) => boolean;
  audit?: AutonomousAuditHook;
  /**
   * Side-effect hook after each initiative is persisted (added 2026-05-06, serves PursuitProgressWriter etc.).
   * Called once per initiative after markDone/Failed/Skipped. Hook errors are caught by loop and only logged;
   * they do not affect the main flow.
   */
  onOutcome?: OutcomeHook;
  /**
   * WS2 (selfhood_closure): per-driver propose cooldowns, read fresh each tick (the values live in
   * memory_drive_configs and are tuned by SessionDriveReflector). A driver whose most recent
   * initiative is younger than its cooldown is skipped this tick. Missing/invalid entry = no
   * throttle (legacy behavior).
   */
  driverCooldowns?: () => Record<string, number | undefined>;
  logger?: { log: (m: string) => void; error: (m: string, e?: unknown) => void };
}

const DEFAULT_TICK_MS = 5 * 60_000;

export interface AutonomousLoopHandle {
  /** Start the background timer. Idempotent; can be called multiple times. */
  start(): void;
  /** Stop the timer + drain in-flight ticks. Idempotent; must be awaited. */
  stop(): Promise<void>;
  /**
   * Runtime pause / resume (can be toggled repeatedly) — timer keeps running, but each tick is a no-op.
   * For use as a global emergency stop.
   * Difference from stop(): stop() is a one-way shutdown (stopped is irreversible); pause() can be toggled.
   */
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  /** Explicitly run one tick (for testing / pre-shutdown consolidation). Returns TickEvent. */
  tickOnce(now?: number): Promise<TickEvent>;
  /** Expose budget tracker (for testing / monitoring) */
  readonly budget: BudgetTracker;
  /** Expose initiative store (for testing / rendering) */
  readonly initiatives: InitiativeStore;
}

export function startAutonomousLoop(
  opts: AutonomousLoopOptions,
): AutonomousLoopHandle {
  const tickIntervalMs =
    opts.tickIntervalMs ??
    parseIntSafe(process.env.PHILONT_AUTONOMOUS_TICK_MS) ??
    DEFAULT_TICK_MS;
  const userId = opts.userId ?? 'default';
  const rootId = opts.rootPursuitId ?? BOOTSTRAP_ROOT_PURSUIT_ID;
  const recentMessages = opts.recentMessagesForTokens ?? 200;
  const log = opts.logger ?? {
    log: (m) => console.log(m),
    error: (m, e) => console.error(m, e),
  };
  const enabled =
    (opts.enabled ?? true) && process.env.PHILONT_AUTONOMOUS !== '0';

  const initiatives = new InitiativeStore(opts.db);
  const budget = new BudgetTracker(opts.db, opts.budgetCaps ?? DEFAULT_BUDGET_CAPS);

  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let paused = false; // Runtime emergency-stop switch (can be toggled); tickOnce no-ops when true

  function snapshot(now: number): MemorySnapshot {
    // facts: active facts across all namespaces. Number of namespaces is small (~10); list each and merge.
    const namespaces = opts.facts.listNamespaces();
    const facts = namespaces.flatMap((ns) => opts.facts.listFacts(ns));

    const routingRules = opts.routingRules.listAll();
    const skills = opts.skills.listAll(500);
    const activePursuits = opts.pursuits.listActive(rootId);

    // Recent timeline tokens
    const recent = opts.raw.queryTimeline({ order: 'desc', limit: recentMessages });
    const tokenSet = new Set<string>();
    for (const m of recent) {
      for (const t of extractSpecificTokens(m.content)) {
        tokenSet.add(t);
      }
    }

    const recentDoneTargetRefs = initiatives.listRecentSettledTargetRefs(
      24 * 60 * 60 * 1000,
      now,
    );

    return {
      facts,
      routingRules,
      skills,
      activePursuits,
      recentTimelineTokens: Array.from(tokenSet),
      recentDoneTargetRefs,
      now,
    };
  }

  async function runOne(initiative: Initiative): Promise<{
    finalStatus: 'done' | 'failed' | 'skipped';
    spent: { llmTokens: number; toolCalls: number };
  }> {
    const result = await opts.executor.run(initiative);
    const spent = {
      llmTokens: Math.max(0, result.llmTokensSpent | 0),
      toolCalls: Math.max(0, result.toolCallsSpent | 0),
    };

    if (result.status === 'done') {
      const updated = initiatives.markDone(
        initiative.id,
        result.outcomeSummary ?? '(executor returned no summary)',
        result.outcomeRefs ?? { facts: [], notes: [], pursuits: [] },
        spent.llmTokens,
      );
      // Commit budget even if markDone fails (double safety)
      budget.commit(userId, spent);
      if (updated && opts.interrupt) {
        // WS6 (selfhood_closure): escalate to 'high' only when the executor LLM flagged the finding
        // AND it produced at least one NEW FACT (evidence-backed knowledge). Notes do NOT qualify:
        // prod 2026-07-08 — the executor wrote a note saying "no tools called, verification produced
        // no new data" and self-rated it escalate=true, so a zero-progress status report surfaced as
        // a HIGH finding in the web-ui. A discovery worth interrupting the user carries a sourced
        // fact by definition; note-only outcomes stay 'normal' (next-turn silent injection).
        const hasNewFacts =
          result.outcomeRefs != null && result.outcomeRefs.facts.length > 0;
        // Either the LLM cleared the (very high) evidence bar, or the mechanism knows the owner asked
        // for this by name. See isOwnerDeclared.
        let ownerDeclared = false;
        try {
          ownerDeclared = opts.isOwnerDeclared?.(initiative.targetRef) === true;
        } catch {
          ownerDeclared = false; // never let relevance lookup break the loop
        }
        opts.interrupt.fire(
          ownerDeclared || (result.escalate === true && hasNewFacts) ? 'high' : 'normal',
          {
            kind: 'discovery_made',
            initiativeId: initiative.id,
            summary: updated.outcomeSummary ?? '',
            driver: initiative.driver,
            targetRef: initiative.targetRef,
          },
        );
      }
      // onOutcome hook (PursuitProgressWriter etc.) — pass the latest persisted initiative
      // status as parameter; errors are only logged.
      await invokeOnOutcome(updated ?? initiative, result);
      return { finalStatus: 'done', spent };
    }

    if (result.status === 'failed') {
      const updated = initiatives.markFailed(initiative.id, result.error ?? 'unknown', spent.llmTokens);
      // Failed also spent tokens; must commit to prevent infinite retries
      if (spent.llmTokens > 0 || spent.toolCalls > 0) {
        budget.commit(userId, spent);
      }
      // 2026-05-07: per-initiative failure log for easier grep debugging.
      // Previously tick summary only showed failed=N; now exposes kind/driver/error for each failure.
      const reasonShort = String(result.error ?? 'unknown').replace(/\s+/g, ' ').slice(0, 240);
      log.error(
        `[autonomous-fail] id=${initiative.id} kind=${initiative.kind} driver=${initiative.driver} ` +
          `target=${initiative.targetRef} llmTokens=${spent.llmTokens} toolCalls=${spent.toolCalls} ` +
          `reason="${reasonShort}"`,
      );
      await invokeOnOutcome(updated ?? initiative, result);
      return { finalStatus: 'failed', spent };
    }

    // Skipped
    const updated = initiatives.markSkipped(
      initiative.id,
      result.error ?? 'skipped by executor',
    );
    // Skipped usually means budget gate or dedup; low informational value but occasionally useful
    const skipReason = String(result.error ?? 'skipped by executor').slice(0, 200);
    log.log(
      `[autonomous-skip] id=${initiative.id} kind=${initiative.kind} driver=${initiative.driver} ` +
        `reason="${skipReason}"`,
    );
    await invokeOnOutcome(updated ?? initiative, result);
    return { finalStatus: 'skipped', spent: { llmTokens: 0, toolCalls: 0 } };
  }

  async function invokeOnOutcome(
    initiative: Initiative,
    result: InitiativeRunResult,
  ): Promise<void> {
    if (!opts.onOutcome) return;
    try {
      await opts.onOutcome(initiative, result);
    } catch (e) {
      log.error(`[autonomous] onOutcome threw error for initiative=${initiative.id}`, e);
    }
  }

  async function tickOnce(nowOverride?: number): Promise<TickEvent> {
    const now = nowOverride ?? Date.now();
    const startedAt = now;
    const event: TickEvent = {
      startedAt,
      durationMs: 0,
      proposalsCollected: 0,
      initiativesRun: 0,
      llmTokensSpent: 0,
      toolCallsSpent: 0,
      skipped: 0,
      failed: 0,
      budgetExhausted: false,
    };

    if (!enabled) {
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    if (paused) {
      // Emergency stop active: timer keeps running but each tick exits immediately,
      // no proposals are collected and no initiatives are run.
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    if (inFlight) {
      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    }
    inFlight = true;

    try {
      budget.resetTick(userId);
      const initialCheck = budget.checkCanRun(userId, now);
      if (!initialCheck.allowed) {
        log.log(`[autonomous] tick skipped: ${initialCheck.reason}`);
        event.budgetExhausted = true;
        event.durationMs = (nowOverride ?? Date.now()) - startedAt;
        opts.audit?.onTick(event);
        return event;
      }

      const snap = snapshot(now);

      // WS2: reflector-tuned per-driver cooldowns (memory_drive_configs.params.cooldownMs).
      let cooldowns: Record<string, number | undefined> = {};
      if (opts.driverCooldowns) {
        try {
          cooldowns = opts.driverCooldowns() ?? {};
        } catch (e) {
          log.error('[autonomous] driverCooldowns read failed; no throttle this tick', e);
        }
      }

      const allProposals: InitiativeProposal[] = [];
      for (const driver of opts.drivers) {
        const cooldownMs = cooldowns[driver.name];
        if (typeof cooldownMs === 'number' && Number.isFinite(cooldownMs) && cooldownMs > 0) {
          const last = initiatives.lastCreatedAtByDriver(driver.name);
          if (last !== null && now - last < cooldownMs) {
            log.log(
              `[autonomous] driver ${driver.name} cooling down ` +
                `(${Math.round((now - last) / 1000)}s/${Math.round(cooldownMs / 1000)}s)`,
            );
            continue;
          }
        }
        try {
          const ps = driver.propose(snap);
          allProposals.push(...ps);
        } catch (e) {
          log.error(`[autonomous] driver ${driver.name} propose threw error`, e);
        }
      }
      event.proposalsCollected = allProposals.length;
      if (allProposals.length === 0) {
        event.durationMs = (nowOverride ?? Date.now()) - startedAt;
        opts.audit?.onTick(event);
        return event;
      }

      // Active-research (pursuit:advance-question, utility 0.9) is dispatched first when tied,
      // ensuring user-assigned ongoing research isn't crowded out of the tick by trivial gap items.
      // All others are sorted by utility descending.
      const isActiveResearch = (p: InitiativeProposal): boolean =>
        p.driver === 'pursuit' && p.kind === 'pursuit:advance-question' && p.utility >= 0.9;
      allProposals.sort((a, b) => {
        const ar = isActiveResearch(a);
        const br = isActiveResearch(b);
        if (ar !== br) return ar ? -1 : 1;
        return b.utility - a.utility;
      });

      for (const proposal of allProposals) {
        const check = budget.checkCanRun(userId, now);
        if (!check.allowed) {
          event.budgetExhausted = true;
          // Mark remaining candidates as skipped (explicitly persisted for audit visibility)
          const inserted = initiatives.insert(proposal);
          initiatives.markSkipped(inserted.id, `budget gate: ${check.reason ?? ''}`);
          event.skipped += 1;
          log.log(
            `[autonomous-skip] id=${inserted.id} kind=${proposal.kind} driver=${proposal.driver} ` +
              `reason="budget gate: ${check.reason ?? ''}"`,
          );
          continue;
        }

        const inserted = initiatives.insert(proposal);
        const running = initiatives.markRunning(inserted.id);
        if (!running) {
          event.skipped += 1;
          continue;
        }

        try {
          const r = await runOne(running);
          if (r.finalStatus === 'done') {
            event.initiativesRun += 1;
          } else if (r.finalStatus === 'failed') {
            event.failed += 1;
          } else {
            event.skipped += 1;
          }
          event.llmTokensSpent += r.spent.llmTokens;
          event.toolCallsSpent += r.spent.toolCalls;
        } catch (e) {
          // Edge case: executor threw an uncaught exception (should not happen, but fallback)
          log.error(`[autonomous] runOne uncaught`, e);
          initiatives.markFailed(running.id, `uncaught: ${String(e)}`, 0);
          event.failed += 1;
        }
      }

      event.durationMs = (nowOverride ?? Date.now()) - startedAt;
      opts.audit?.onTick(event);
      return event;
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer) return;
    if (!enabled) {
      log.log('[autonomous] loop disabled (enabled=false / PHILONT_AUTONOMOUS=0)');
      return;
    }
    timer = setInterval(() => {
      void tickOnce().catch((e) => log.error('[autonomous] tick uncaught', e));
    }, tickIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    log.log(`[autonomous] loop started, tick=${tickIntervalMs}ms`);
  }

  return {
    start,
    pause(): void { paused = true; log.log('[autonomous] paused (e-stop)'); },
    resume(): void { paused = false; log.log('[autonomous] resumed'); },
    isPaused(): boolean { return paused; },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const drainStart = Date.now();
      const TIMEOUT = 10_000;
      while (inFlight) {
        if (Date.now() - drainStart > TIMEOUT) {
          log.error('[autonomous] stop drain timeout, giving up waiting for in-flight tick');
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    tickOnce,
    budget,
    initiatives,
  };
}

function parseIntSafe(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
