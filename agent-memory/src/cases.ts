/**
 * CaseStore (2026-10-04): judge-verified cases — the structured record of a run.
 *
 * A case is `(goal, trace, verdict)`: what the owner asked for, which tools ran and whether each
 * succeeded, and what the learning judge concluded. It is the memory form Memento (Jun Wang, UCL) and the
 * philosophers programme both arrived at: store the run itself with its outcome, and let retrieval find the
 * similar run, instead of asking an LLM to distil the run into prose first. philont's reflection prose
 * (routing rules, playbooks) is read by a model and may or may not change its behaviour — 1022 rules,
 * 0 validated; a case is a fact about what happened, written by the mechanism layer, verified by the judge.
 *
 * Write policy: only `success` and `failure` verdicts are stored. `could_not_verify` is not a case (nothing
 * was established), `not_applicable` is not a task. A case is append-only; nothing is merged or superseded
 * at write time — exp 105 found no benefit in write-time arbitration and exp 89 found similarity
 * supersede harmful. Retention is by count (RETAIN_MAX, oldest trimmed) so the table cannot grow without
 * bound.
 *
 * Read policy: token-Jaccard over the goal text (same tokenizer as plan/skill matching), top-k, score > 0
 * only — a case with no lexical overlap is never returned ("void case"; exp 103: unrelated recall is not
 * neutral). Callers decide what to do with the result; this store injects nothing.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { tokenize, jaccard } from './text_tokenize.js';

export type CaseVerdict = 'success' | 'failure';

export interface CaseToolStep {
  toolName: string;
  ok: boolean;
}

export interface CaseInput {
  sessionId: string;
  goal: string;
  trace: CaseToolStep[];
  verdict: CaseVerdict;
  /** The judge's basis label (e.g. 'rails', 'aux'), if any. */
  basis?: string | null;
  /** The judge's one-line evidence, if any. */
  evidence?: string | null;
}

export interface Case {
  id: string;
  sessionId: string;
  goal: string;
  trace: CaseToolStep[];
  /** Distinct tool names in trace order, for compact rendering. */
  tools: string[];
  verdict: CaseVerdict;
  basis: string | null;
  evidence: string | null;
  createdAt: number;
}

export interface CaseMatch extends Case {
  /** Jaccard overlap between the query and the case goal, in (0,1]. */
  score: number;
}

interface CaseRow {
  id: string;
  session_id: string;
  goal: string;
  trace_json: string;
  tools: string;
  verdict: string;
  basis: string | null;
  evidence: string | null;
  created_at: number;
}

/** Hard cap on stored cases; oldest beyond it are deleted on write. */
export const CASE_RETAIN_MAX = 5000;
const GOAL_MAX = 2000;
const EVIDENCE_MAX = 500;
const TRACE_MAX_STEPS = 60;

function rowToCase(r: CaseRow): Case {
  let trace: CaseToolStep[] = [];
  try {
    const parsed = JSON.parse(r.trace_json);
    if (Array.isArray(parsed)) trace = parsed.filter((t) => t && typeof t.toolName === 'string').map((t) => ({ toolName: String(t.toolName), ok: !!t.ok }));
  } catch {
    trace = [];
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    goal: r.goal,
    trace,
    tools: r.tools ? r.tools.split(' ').filter(Boolean) : [],
    verdict: r.verdict === 'success' ? 'success' : 'failure',
    basis: r.basis,
    evidence: r.evidence,
    createdAt: r.created_at,
  };
}

export class CaseStore {
  constructor(private readonly db: Database.Database) {}

  /** Append a case. Returns null (and writes nothing) for a blank goal or an empty trace. */
  record(input: CaseInput, now: number = Date.now()): Case | null {
    const goal = (input.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, GOAL_MAX);
    const trace = (input.trace ?? []).slice(0, TRACE_MAX_STEPS).map((t) => ({ toolName: String(t.toolName), ok: !!t.ok }));
    if (!goal || trace.length === 0) return null;
    if (input.verdict !== 'success' && input.verdict !== 'failure') return null;
    const tools: string[] = [];
    for (const t of trace) if (!tools.includes(t.toolName)) tools.push(t.toolName);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_cases (id, session_id, goal, trace_json, tools, verdict, basis, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, goal, JSON.stringify(trace), tools.join(' '), input.verdict, input.basis ?? null, (input.evidence ?? null)?.slice(0, EVIDENCE_MAX) ?? null, now);
    this.trim();
    return this.get(id)!;
  }

  get(id: string): Case | null {
    const row = this.db.prepare(`SELECT * FROM memory_cases WHERE id = ?`).get(id) as CaseRow | undefined;
    return row ? rowToCase(row) : null;
  }

  /**
   * Cases whose goal overlaps `query` (token Jaccard > 0), best first, at most `k`. Optional verdict filter.
   * Scans the most recent `scan` rows (default 2000) — the store is bounded and goals are short.
   */
  search(query: string, opts: { k?: number; verdicts?: CaseVerdict[]; scan?: number } = {}): CaseMatch[] {
    const k = Math.max(1, opts.k ?? 3);
    const q = tokenize(query ?? '');
    if (q.size === 0) return [];
    const verdicts = opts.verdicts ?? ['success', 'failure'];
    const rows = this.db
      .prepare(`SELECT * FROM memory_cases WHERE verdict IN (${verdicts.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
      .all(...verdicts, opts.scan ?? 2000) as CaseRow[];
    const scored: CaseMatch[] = [];
    for (const r of rows) {
      const score = jaccard(q, tokenize(r.goal));
      if (score > 0) scored.push({ ...rowToCase(r), score });
    }
    scored.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    return scored.slice(0, k);
  }

  recent(limit = 20): Case[] {
    const rows = this.db.prepare(`SELECT * FROM memory_cases ORDER BY created_at DESC LIMIT ?`).all(limit) as CaseRow[];
    return rows.map(rowToCase);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_cases`).get() as { n: number }).n;
  }

  countByVerdict(): Record<CaseVerdict, number> {
    const rows = this.db.prepare(`SELECT verdict, COUNT(*) AS n FROM memory_cases GROUP BY verdict`).all() as { verdict: string; n: number }[];
    const out: Record<CaseVerdict, number> = { success: 0, failure: 0 };
    for (const r of rows) if (r.verdict === 'success' || r.verdict === 'failure') out[r.verdict] = r.n;
    return out;
  }

  private trim(): void {
    const n = this.count();
    if (n <= CASE_RETAIN_MAX) return;
    this.db
      .prepare(`DELETE FROM memory_cases WHERE id IN (SELECT id FROM memory_cases ORDER BY created_at ASC LIMIT ?)`)
      .run(n - CASE_RETAIN_MAX);
  }
}
