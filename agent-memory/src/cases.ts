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
  /**
   * 2026-10-08 (trajectory replay): the step's input excerpt (shell command, code, or the tool's main
   * argument) and output excerpt. Optional: a case without them still renders as the one-line
   * (goal → tools → verdict) summary. Bounded at write time (INPUT_MAX / OUTPUT_MAX) so a case stays
   * a compact record, not a transcript. Why content matters: on AppWorld / ConvStream (philosophers
   * exp 115/116) replaying *what was actually run* in similar successful tasks is the one memory form
   * that wins on a weaker model (+7/+10 paired); tool-name-only traces cannot carry that information.
   */
  input?: string;
  output?: string;
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
  /** 2026-10-08: the owner's own verdict on the reply this case came from (owner_verdict.ts); null until they give one. */
  ownerVerdict: 'accepted' | 'rejected' | null;
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
  owner_verdict?: string | null;
}

/** Hard cap on stored cases; oldest beyond it are deleted on write. */
export const CASE_RETAIN_MAX = 5000;
const GOAL_MAX = 2000;
const EVIDENCE_MAX = 500;
const TRACE_MAX_STEPS = 60;
const INPUT_MAX = 300;
const OUTPUT_MAX = 200;

function clip(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

function normStep(t: { toolName: unknown; ok: unknown; input?: unknown; output?: unknown }): CaseToolStep {
  const step: CaseToolStep = { toolName: String(t.toolName), ok: !!t.ok };
  const input = clip(t.input, INPUT_MAX);
  const output = clip(t.output, OUTPUT_MAX);
  if (input) step.input = input;
  if (output) step.output = output;
  return step;
}

/**
 * Compact trajectory text for prompt injection: the goal, then one line per step that has content
 * (`tool: input → output`). Steps without content are folded into a tool-name list. Bounded by
 * `maxChars` (default 900) — the tail is dropped, the head (how the task was approached) is kept.
 */
export function renderCaseTrajectory(c: Case, maxChars = 900): string {
  const lines: string[] = [`· Task: "${c.goal.slice(0, 160)}"`];
  const bare: string[] = [];
  for (const st of c.trace) {
    if (st.input) {
      lines.push(`    ${st.toolName}${st.ok ? '' : ' (failed)'}: ${st.input}${st.output ? ` → ${st.output}` : ''}`);
    } else {
      bare.push(st.toolName + (st.ok ? '' : '!'));
    }
  }
  if (lines.length === 1) lines.push(`    tools: ${c.tools.join(' → ') || '(none)'}`);
  else if (bare.length) lines.push(`    (other calls: ${bare.slice(0, 12).join(', ')})`);
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 1 > maxChars) {
      out += '\n    …';
      break;
    }
    out += (out ? '\n' : '') + l;
  }
  return out;
}

function rowToCase(r: CaseRow): Case {
  let trace: CaseToolStep[] = [];
  try {
    const parsed = JSON.parse(r.trace_json);
    if (Array.isArray(parsed)) trace = parsed.filter((t) => t && typeof t.toolName === 'string').map((t) => normStep(t));
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
    ownerVerdict: r.owner_verdict === 'accepted' || r.owner_verdict === 'rejected' ? r.owner_verdict : null,
  };
}

export class CaseStore {
  constructor(private readonly db: Database.Database) {}

  /** Append a case. Returns null (and writes nothing) for a blank goal or an empty trace. */
  record(input: CaseInput, now: number = Date.now()): Case | null {
    const goal = (input.goal ?? '').replace(/\s+/g, ' ').trim().slice(0, GOAL_MAX);
    const trace = (input.trace ?? []).slice(0, TRACE_MAX_STEPS).map((t) => normStep(t));
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

  /** Record the owner's verdict on the reply this case came from. Returns false when the case is unknown. */
  setOwnerVerdict(id: string, verdict: 'accepted' | 'rejected'): boolean {
    return this.db.prepare(`UPDATE memory_cases SET owner_verdict = ? WHERE id = ?`).run(verdict, id).changes > 0;
  }

  /** Judge verdict × owner verdict, over cases that have both — the judge's calibration table. */
  judgeVsOwner(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT verdict, owner_verdict AS owner, COUNT(*) AS n FROM memory_cases WHERE owner_verdict IS NOT NULL GROUP BY verdict, owner_verdict`,
    ).all() as Array<{ verdict: string; owner: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.verdict}/${r.owner}`] = r.n;
    return out;
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
