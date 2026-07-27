/**
 * ReasoningStore — persisted state for the deep reasoning subsystem (schema v25).
 *
 * This is the core of philont's deep reasoning: persist the intermediate state of reasoning
 * (subgoal trees / proved lemmas / dead ends) into DB, accumulating across turns and days.
 * Other AutoResearch implementations keep reasoning state within a single call; this one persists.
 *
 *   reasoning_sessions  a reasoning session for a hard problem/conjecture (root proposition + status + cross-turn budget accumulation)
 *   reasoning_nodes     subgoal tree nodes (parent_id forms tree; status includes dead_end;
 *                       approaches_tried is backtracking memory — remembers tried dead ends to avoid repeating them)
 *
 * Pure CRUD, does not call LLM or touch tool permissions. Orchestration (mini-loop / rendering / convergence)
 * is done on the server side in deep_explore.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// 'answered' (2026-06-28): a DELIBERATE session that has gathered enough cited evidence and stopped
// making converge progress — the engine auto-delivers its synthesis and closes here. Distinct from
// 'solved' (a formal proof's root proved) and 'stuck' (frontier exhausted with nothing established):
// 'answered' means "an evidence-backed answer was delivered." Terminal like solved/stuck (not 'active',
// so getMostRecentActiveSession / listActiveSessions / auto-advance all stop resuming it).
export type ReasoningSessionStatus = 'active' | 'solved' | 'stuck' | 'abandoned' | 'answered';
/**
 * Reasoning mode = which domain "profile" the deep_explore engine runs:
 *   - 'formal'     : mathematical / formal proof — claims settled by machine-check + skeptic (z3/pari/…)
 *   - 'deliberate' : general open-ended judgment (decisions, diagnosis, due-diligence) — claims settled
 *                    by cited evidence + adversarial review. Verification substrate is evidence, not proof.
 * Persisted on the session so continue/status/finalize pick the same profile across turns. Default 'formal'.
 */
export type ReasoningSessionMode = 'formal' | 'deliberate';
/**
 * Exploration phase (orthogonal to mode/domain): which kind of round the session runs.
 *   - 'converge' : eliminative — decompose / discriminate / settle (today's default behavior).
 *   - 'diverge'  : generative — open up the space (conjectures / candidate options) without
 *                  settling; novelty/diversity favored over pruning.
 * Session state, not constant: it ratchets diverge→converge via the transition gate. Default
 * 'converge' so existing sessions are unchanged. (Phase A: persisted; dispatch wired in Phase B+.)
 */
export type ReasoningPhase = 'diverge' | 'converge';
export type ReasoningNodeKind = 'subgoal' | 'lemma' | 'construction' | 'counterexample' | 'conjecture';
export type ReasoningNodeStatus = 'open' | 'proved' | 'refuted' | 'dead_end' | 'blocked';
/**
 * For empirical-domain (deliberate) nodes: which kind of evidence settled the node.
 *   - 'empirical'    : backed by an external cited source/observation (today's strict gate).
 *   - 'preferential' : a value-laden conclusion grounded in the USER's own stated values/data
 *                      (truth-maker is the user's utility, not the open web).
 * null = unset → treated as 'empirical' (today's default). (Gate logic lands in Phase D.)
 */
export type ReasoningSettleBasis = 'empirical' | 'preferential';

export interface ReasoningSession {
  id: string;
  goal: string;
  assumptions: string[];
  status: ReasoningSessionStatus;
  /** Chat session (wechat:… / web-ui id / system:scheduled:…) that started this reasoning; null for pre-v28 sessions. Scopes continue/status so concurrent channels don't hijack each other. */
  ownerSessionId: string | null;
  rootNodeId: string | null;
  /** Cumulative LLM token cost across turns (single-turn loop gate is PlanBudgetTracker; this is the running total) */
  budgetSpent: number;
  /** Consecutive rounds that made NO net tree progress (reset on any progress). Drives stuck handling. */
  noProgressRounds: number;
  /** Per-session opt-in: when true, the background loop auto-advances this session round-by-round. */
  autoAdvance: boolean;
  /** When the followup loop last asked the owner about this idle session (persisted; null = never asked). */
  followupAskedAt: number | null;
  /** Which reasoning profile this session runs (formal proof vs general evidence-based deliberation). Default 'formal'. */
  mode: ReasoningSessionMode;
  /** Exploration phase: 'converge' (eliminative, default) vs 'diverge' (generative). Ratchets diverge→converge. */
  phase: ReasoningPhase;
  /** Consecutive diverge rounds with no net-new viable candidate (saturation signal for the transition gate). */
  divergeIdleRounds: number;
  /** Cumulative count of advancing rounds run (never reset). Backs the deliberate auto-answer round ceiling. */
  roundsRun: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningNode {
  id: string;
  sessionId: string;
  parentId: string | null;
  claim: string;
  kind: ReasoningNodeKind;
  status: ReasoningNodeStatus;
  result: string | null;
  /** Backtracking memory: which approaches were tried for this node (appended on dead_end), to avoid repeating them */
  approachesTried: string[];
  evidenceRefs: string[];
  depth: number;
  /** value-guided node selection: latest estimate from an independent aux-LLM of "value/attackability towards the root proposition" (0-1, null=not yet evaluated) */
  value: number | null;
  /** Number of turns this node has been advanced as an active frontier (denominator for UCB exploration term) */
  visits: number;
  /** Proof/exploration technique tag (behavior descriptor for MAP-Elites bucketing + novelty; null=unclassified) */
  technique: string | null;
  /**
   * What would CONFIRM OR REFUTE this node — stated when the node is created, not discovered afterwards.
   * A node with no criterion can be worked forever without anyone being able to say whether it moved, which
   * is the shape of a session that runs for hours and yields no signal. null = never stated.
   */
  checkCriterion: string | null;
  /** For empirical (deliberate) nodes: evidence basis the node was settled on ('empirical'/'preferential'); null=unset (treated as empirical). */
  settleBasis: ReasoningSettleBasis | null;
  createdAt: number;
  updatedAt: number;
}

interface SessionRow {
  id: string;
  goal: string;
  assumptions_json: string | null;
  status: string;
  owner_session_id: string | null;
  root_node_id: string | null;
  budget_spent: number;
  no_progress_rounds: number;
  auto_advance: number;
  followup_asked_at: number | null;
  mode: string | null;
  phase: string | null;
  diverge_idle_rounds: number;
  rounds_run: number;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  claim: string;
  kind: string;
  status: string;
  result: string | null;
  approaches_tried_json: string | null;
  evidence_refs_json: string | null;
  depth: number;
  value: number | null;
  visits: number;
  technique: string | null;
  check_criterion: string | null;
  settle_basis: string | null;
  created_at: number;
  updated_at: number;
}

function rowToSession(r: SessionRow): ReasoningSession {
  return {
    id: r.id,
    goal: r.goal,
    assumptions: r.assumptions_json ? (JSON.parse(r.assumptions_json) as string[]) : [],
    status: r.status as ReasoningSessionStatus,
    ownerSessionId: r.owner_session_id ?? null,
    rootNodeId: r.root_node_id,
    budgetSpent: r.budget_spent,
    noProgressRounds: r.no_progress_rounds ?? 0,
    autoAdvance: !!r.auto_advance,
    followupAskedAt: r.followup_asked_at ?? null,
    mode: (r.mode === 'deliberate' ? 'deliberate' : 'formal') as ReasoningSessionMode,
    phase: (r.phase === 'diverge' ? 'diverge' : 'converge') as ReasoningPhase,
    divergeIdleRounds: r.diverge_idle_rounds ?? 0,
    roundsRun: r.rounds_run ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToNode(r: NodeRow): ReasoningNode {
  return {
    id: r.id,
    sessionId: r.session_id,
    parentId: r.parent_id,
    claim: r.claim,
    kind: r.kind as ReasoningNodeKind,
    status: r.status as ReasoningNodeStatus,
    result: r.result,
    approachesTried: r.approaches_tried_json
      ? (JSON.parse(r.approaches_tried_json) as string[])
      : [],
    evidenceRefs: r.evidence_refs_json ? (JSON.parse(r.evidence_refs_json) as string[]) : [],
    depth: r.depth,
    value: r.value ?? null,
    visits: r.visits ?? 0,
    technique: r.technique ?? null,
    checkCriterion: r.check_criterion ?? null,
    settleBasis:
      r.settle_basis === 'empirical' || r.settle_basis === 'preferential' ? r.settle_basis : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Thrown when the parent node does not exist (or does not belong to this session) — lets the deep_explore tool return an error text for the sub-LLM to self-correct. */
export class ReasoningNodeNotFoundError extends Error {
  constructor(public readonly nodeId: string) {
    super(`reasoning node not found: ${nodeId}`);
    this.name = 'ReasoningNodeNotFoundError';
  }
}

export class ReasoningStore {
  constructor(private readonly db: Database.Database) {}

  /** Create a session + root node (claim=goal). Returns both. mode defaults to 'formal' (math proof). */
  createSession(input: {
    goal: string;
    assumptions?: string[];
    ownerSessionId?: string | null;
    mode?: ReasoningSessionMode;
  }): {
    session: ReasoningSession;
    rootNode: ReasoningNode;
  } {
    const now = Date.now();
    const sessionId = randomUUID();
    const rootId = randomUUID();

    this.db
      .prepare<[string, string, string, string | null, string, string, number, number]>(
        `INSERT INTO reasoning_sessions
          (id, goal, assumptions_json, status, owner_session_id, root_node_id, budget_spent, mode, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        sessionId,
        input.goal,
        JSON.stringify(input.assumptions ?? []),
        input.ownerSessionId ?? null,
        rootId,
        input.mode === 'deliberate' ? 'deliberate' : 'formal',
        now,
        now,
      );

    this.db
      .prepare<[string, string, string, number, number]>(
        `INSERT INTO reasoning_nodes
          (id, session_id, parent_id, claim, kind, status, result,
           approaches_tried_json, evidence_refs_json, depth, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'subgoal', 'open', NULL, '[]', '[]', 0, ?, ?)`,
      )
      .run(rootId, sessionId, input.goal, now, now);

    return {
      session: this.getSession(sessionId)!,
      rootNode: this.getNode(sessionId, rootId)!,
    };
  }

  getSession(id: string): ReasoningSession | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM reasoning_sessions WHERE id = ?`)
      .get(id) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Active sessions, most recently updated first. */
  /**
   * Active sessions, most recently updated first. When `ownerSessionId` is provided, only sessions
   * started by that chat session are returned — this is what keeps two concurrent channels from
   * seeing each other's reasoning. Passing `undefined`/`null` returns ALL active sessions (legacy).
   */
  listActiveSessions(ownerSessionId?: string | null): ReasoningSession[] {
    const rows = (
      ownerSessionId == null
        ? this.db
            .prepare(`SELECT * FROM reasoning_sessions WHERE status = 'active' ORDER BY updated_at DESC`)
            .all()
        : this.db
            .prepare(
              // Owner-scoped, BUT legacy NULL-owner sessions (created before v28, when no owner was
              // recorded) stay resumable by any channel — a graceful migration so an in-flight
              // pre-upgrade reasoning session isn't orphaned. They age out as they close; every NEW
              // session has a non-NULL owner and is therefore strictly isolated.
              `SELECT * FROM reasoning_sessions
               WHERE status = 'active' AND (owner_session_id = ? OR owner_session_id IS NULL)
               ORDER BY updated_at DESC`,
            )
            .all(ownerSessionId)
    ) as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Default target for a bare `continue`/`status` (no id) — "the deep_explore the user is currently
   * working on". Scoped to the owner so one channel never grabs another's reasoning.
   *
   * Ordered by **created_at DESC** (most recently STARTED), NOT updated_at: when a chat has more than
   * one active session, an older one's updated_at gets bumped by background work (autonomous tick / idle
   * consolidator / a mis-resolved continue), which made `continue` ping-pong onto a stale session (seen
   * in prod: a P-vs-NP "继续" advanced a days-old GLM-910C session). created_at is immutable, so the
   * resolver always pins to the session the user most recently chose to start = their current focus.
   * Omitting `ownerSessionId` falls back to the global most-recently-started (legacy).
   */
  getMostRecentActiveSession(ownerSessionId?: string | null): ReasoningSession | null {
    // Ordered by created_at, NOT updated_at, and that is deliberate: background work (an autonomous tick,
    // the idle consolidator, a previously mis-resolved continue) bumps updated_at on an OLD session, and
    // ordering by it made `continue` ping-pong between threads. See the anti-ping-pong test.
    //
    // The cost of that choice showed up on 2026-07-27. The session the conversation was actually on had
    // just been CLOSED, so it left the candidate set entirely — and this resolver silently substituted a
    // graph-visualisation session created three days earlier, the newest still-active one. Six minutes of
    // 知识图谱 / 思维导图 later the owner asked 这是跑偏到什么地方去了？
    //
    // Neither ordering is right, because neither answers the real question ("which thread is this
    // conversation on") — both are proxies, and each fails where the other holds. Rather than trade one
    // silent wrong answer for another, the substitution is now VISIBLE: every round result names the
    // question it advanced (renderSessionSubject), so a wrong pick costs one glance instead of six
    // minutes. A resolver that cannot be right in every case must at least be legible in every case.
    const row = (
      ownerSessionId == null
        ? this.db
            .prepare(
              `SELECT * FROM reasoning_sessions WHERE status = 'active'
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get()
        : this.db
            .prepare(
              // Legacy NULL-owner sessions (pre-v28) stay resumable by any channel; every NEW session
              // has a non-NULL owner and is strictly isolated (mirrors listActiveSessions).
              `SELECT * FROM reasoning_sessions
               WHERE status = 'active' AND (owner_session_id = ? OR owner_session_id IS NULL)
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get(ownerSessionId)
    ) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Compact ground-truth snapshot of a session: status + open-frontier / proved / dead counts.
   * "Open frontier" = open leaf nodes (no children). Used by the honesty gate to check a
   * "reasoning concluded" claim against reality, and reusable for progress rendering.
   */
  summarizeSession(
    sessionId: string,
  ): { status: ReasoningSessionStatus; openFrontierCount: number; provedCount: number; deadCount: number } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const nodes = this.getNodes(sessionId);
    const hasChild = new Set<string>();
    for (const n of nodes) if (n.parentId) hasChild.add(n.parentId);
    const openFrontierCount = nodes.filter((n) => n.status === 'open' && !hasChild.has(n.id)).length;
    const provedCount = nodes.filter((n) => n.status === 'proved').length;
    const deadCount = nodes.filter((n) => n.status === 'dead_end').length;
    return { status: session.status, openFrontierCount, provedCount, deadCount };
  }

  getNode(sessionId: string, nodeId: string): ReasoningNode | null {
    const row = this.db
      .prepare<[string, string]>(
        `SELECT * FROM reasoning_nodes WHERE id = ? AND session_id = ?`,
      )
      .get(nodeId, sessionId) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  /** All nodes in a session (sorted by depth, created_at for tree rendering). */
  getNodes(sessionId: string): ReasoningNode[] {
    const rows = this.db
      .prepare<[string]>(
        `SELECT * FROM reasoning_nodes WHERE session_id = ? ORDER BY depth, created_at`,
      )
      .all(sessionId) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Claims the agent has already hung on SOME reasoning tree — the memory a fresh session otherwise
   * starts without. Returns nodes from every OTHER session, plus this session's settled ones
   * (dead_end / refuted), newest first.
   *
   * Production 2026-07-25: three times in one evening the owner had to say "你在之前也试过" about a
   * candidate the tree already held, and each time the agent agreed only after being told. Generation
   * never consulted the record. See claim_novelty.ts.
   */
  listPriorClaims(
    opts: { excludeSessionId?: string; limit?: number } = {},
  ): Array<{ claim: string; status: string; sessionId: string }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 400, 2000));
    const sid = opts.excludeSessionId ?? '';
    const rows = this.db
      .prepare<[string, number]>(
        `SELECT claim, status, session_id FROM reasoning_nodes
          WHERE claim IS NOT NULL AND length(claim) > 0
            AND (session_id != ? OR status IN ('dead_end', 'refuted'))
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sid, limit) as Array<{ claim: string; status: string; session_id: string }>;
    return rows.map((r) => ({ claim: r.claim, status: r.status, sessionId: r.session_id }));
  }

  getTree(sessionId: string): { session: ReasoningSession; nodes: ReasoningNode[] } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return { session, nodes: this.getNodes(sessionId) };
  }

  /**
   * Add child nodes under parentId (decompose). Validates that parent exists in this session;
   * throws ReasoningNodeNotFoundError if not found (so the tool can return an error text).
   * Returns **newly created nodes (with ids)**.
   */
  addNodes(
    sessionId: string,
    parentId: string,
    children: Array<{ claim: string; kind: ReasoningNodeKind; check?: string | null }>,
  ): ReasoningNode[] {
    const parent = this.getNode(sessionId, parentId);
    if (!parent) throw new ReasoningNodeNotFoundError(parentId);

    const now = Date.now();
    const created: ReasoningNode[] = [];
    const insert = this.db.prepare<
      [string, string, string, string, string, string | null, number, number, number]
    >(
      `INSERT INTO reasoning_nodes
        (id, session_id, parent_id, claim, kind, status, result,
         approaches_tried_json, evidence_refs_json, check_criterion, depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, '[]', '[]', ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of children) {
        const id = randomUUID();
        const check = typeof c.check === 'string' && c.check.trim() ? c.check.trim().slice(0, 400) : null;
        insert.run(id, sessionId, parentId, c.claim, c.kind, check, parent.depth + 1, now, now);
        created.push(this.getNode(sessionId, id)!);
      }
    });
    tx();
    this.touchSession(sessionId, now);
    return created;
  }

  /**
   * Update node status/result (record). WHERE id AND session_id; returns null if not found (so the tool can return an error text).
   *   - appendApproach: when dead_end, append the tried approach to approaches_tried (backtracking memory)
   *   - addEvidence: append an evidence ref
   */
  updateNode(
    sessionId: string,
    nodeId: string,
    patch: {
      status?: ReasoningNodeStatus;
      result?: string | null;
      appendApproach?: string;
      addEvidence?: string;
      /** Empirical-domain evidence basis ('empirical'/'preferential'); omit to leave unchanged. */
      settleBasis?: ReasoningSettleBasis | null;
    },
  ): ReasoningNode | null {
    const node = this.getNode(sessionId, nodeId);
    if (!node) return null;

    const status = patch.status ?? node.status;
    const result = patch.result !== undefined ? patch.result : node.result;
    const approaches = patch.appendApproach
      ? [...node.approachesTried, patch.appendApproach]
      : node.approachesTried;
    const evidence = patch.addEvidence
      ? [...node.evidenceRefs, patch.addEvidence]
      : node.evidenceRefs;
    const settleBasis = patch.settleBasis !== undefined ? patch.settleBasis : node.settleBasis;
    const now = Date.now();

    this.db
      .prepare<[string, string | null, string, string, string | null, number, string, string]>(
        `UPDATE reasoning_nodes
           SET status = ?, result = ?, approaches_tried_json = ?, evidence_refs_json = ?, settle_basis = ?, updated_at = ?
         WHERE id = ? AND session_id = ?`,
      )
      .run(status, result, JSON.stringify(approaches), JSON.stringify(evidence), settleBasis, now, nodeId, sessionId);
    this.touchSession(sessionId, now);
    return this.getNode(sessionId, nodeId);
  }

  setSessionStatus(id: string, status: ReasoningSessionStatus): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE reasoning_sessions SET status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, Date.now(), id);
  }

  /** Accumulate cross-turn budget cost. */
  addBudgetSpent(id: string, tokens: number): void {
    this.db
      .prepare<[number, number, string]>(
        `UPDATE reasoning_sessions SET budget_spent = budget_spent + ?, updated_at = ? WHERE id = ?`,
      )
      .run(Math.max(0, Math.floor(tokens)), Date.now(), id);
  }

  /** Increment the cumulative advancing-round counter and return the new total. Backs the deliberate auto-answer round ceiling. */
  incrementRoundsRun(id: string): number {
    this.db
      .prepare<[number, string]>(
        `UPDATE reasoning_sessions SET rounds_run = rounds_run + 1, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    const row = this.db
      .prepare<[string]>(`SELECT rounds_run FROM reasoning_sessions WHERE id = ?`)
      .get(id) as { rounds_run: number } | undefined;
    return row?.rounds_run ?? 0;
  }

  /**
   * Record whether a round made net tree progress. On progress → reset the counter to 0; on no progress
   * → increment it. Returns the new consecutive-no-progress count (used for stuck handling). A "stuck"
   * session is one whose counter has crossed the caller's threshold.
   */
  recordRoundProgress(id: string, madeProgress: boolean): number {
    if (madeProgress) {
      this.db
        .prepare<[number, string]>(
          `UPDATE reasoning_sessions SET no_progress_rounds = 0, updated_at = ? WHERE id = ?`,
        )
        .run(Date.now(), id);
      return 0;
    }
    this.db
      .prepare<[number, string]>(
        `UPDATE reasoning_sessions SET no_progress_rounds = no_progress_rounds + 1, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    const row = this.db
      .prepare<[string]>(`SELECT no_progress_rounds FROM reasoning_sessions WHERE id = ?`)
      .get(id) as { no_progress_rounds: number } | undefined;
    return row?.no_progress_rounds ?? 0;
  }

  /** Set the exploration phase (diverge/converge). Set by the transition gate; ratchets diverge→converge. */
  setPhase(id: string, phase: ReasoningPhase): void {
    this.db
      .prepare<[string, number, string]>(
        `UPDATE reasoning_sessions SET phase = ?, updated_at = ? WHERE id = ?`,
      )
      .run(phase, Date.now(), id);
  }

  /**
   * Record whether a diverge round produced a net-new viable candidate. Net-new → reset the idle
   * counter to 0; otherwise increment. Returns the new consecutive-idle count (saturation signal for
   * the diverge→converge transition gate). Diverge analogue of recordRoundProgress.
   */
  recordDivergeProgress(id: string, madeProgress: boolean): number {
    if (madeProgress) {
      this.db
        .prepare<[number, string]>(
          `UPDATE reasoning_sessions SET diverge_idle_rounds = 0, updated_at = ? WHERE id = ?`,
        )
        .run(Date.now(), id);
      return 0;
    }
    this.db
      .prepare<[number, string]>(
        `UPDATE reasoning_sessions SET diverge_idle_rounds = diverge_idle_rounds + 1, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    const row = this.db
      .prepare<[string]>(`SELECT diverge_idle_rounds FROM reasoning_sessions WHERE id = ?`)
      .get(id) as { diverge_idle_rounds: number } | undefined;
    return row?.diverge_idle_rounds ?? 0;
  }

  /** Opt a session in/out of background auto-advance. */
  setAutoAdvance(id: string, on: boolean): void {
    this.db
      .prepare<[number, number, string]>(
        `UPDATE reasoning_sessions SET auto_advance = ?, updated_at = ? WHERE id = ?`,
      )
      .run(on ? 1 : 0, Date.now(), id);
  }

  /**
   * Record that the followup loop just asked the owner about this idle session. Persisted so the
   * "asked once → quiet for the grace period → auto-archive" lifecycle survives a server restart.
   * Deliberately does NOT bump updated_at (that would look like the session was worked on, defeating the
   * quiet-since-ask check).
   */
  setFollowupAskedAt(id: string, at: number = Date.now()): void {
    this.db
      .prepare<[number, string]>(`UPDATE reasoning_sessions SET followup_asked_at = ? WHERE id = ?`)
      .run(at, id);
  }

  /** Active sessions opted into background auto-advance (most recently updated first). */
  listAutoAdvanceSessions(): ReasoningSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reasoning_sessions WHERE status = 'active' AND auto_advance = 1 ORDER BY updated_at DESC`,
      )
      .all() as SessionRow[];
    return rows.map(rowToSession);
  }

  /**
   * Batch-write node values (value-guided node selection; clamped to [0,1]). Optionally includes technique (MAP-Elites bucketing).
   * technique omitted (undefined) → only updates value, retains original technique; provided (including null) → also writes technique. Only touches this session.
   */
  setNodeValues(
    sessionId: string,
    values: Array<{ id: string; value: number; technique?: string | null }>,
  ): void {
    if (values.length === 0) return;
    const valueOnly = this.db.prepare<[number, string, string]>(
      `UPDATE reasoning_nodes SET value = ? WHERE id = ? AND session_id = ?`,
    );
    const valueAndTech = this.db.prepare<[number, string | null, string, string]>(
      `UPDATE reasoning_nodes SET value = ?, technique = ? WHERE id = ? AND session_id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const { id, value, technique } of values) {
        const v = Math.max(0, Math.min(1, value));
        if (technique === undefined) valueOnly.run(v, id, sessionId);
        else valueAndTech.run(v, technique, id, sessionId);
      }
    });
    tx();
  }

  /** Increment visits by 1 for a batch of nodes (UCB exploration term: records "these frontier nodes were advanced another round"). */
  incrementVisits(sessionId: string, nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    const stmt = this.db.prepare<[string, string]>(
      `UPDATE reasoning_nodes SET visits = visits + 1 WHERE id = ? AND session_id = ?`,
    );
    const tx = this.db.transaction(() => {
      for (const id of nodeIds) stmt.run(id, sessionId);
    });
    tx();
  }

  private touchSession(id: string, now: number): void {
    this.db
      .prepare<[number, string]>(`UPDATE reasoning_sessions SET updated_at = ? WHERE id = ?`)
      .run(now, id);
  }
}
