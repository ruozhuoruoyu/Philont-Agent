/**
 * Citation-grounding gate (2026-06-17).
 *
 * The model fabricates a specific arXiv id — and the equations / "results" it attributes to that paper —
 * from memory when no source was actually retrieved this conversation (observed in prod: it cited an
 * arXiv id and reported its Diophantine equation as fact, having never fetched anything). This pure module
 * detects such an ungrounded citation; chat-handler regenerates once to force honest framing (待核实) or an
 * actual fetch. Kept dependency-light (mirrors viability_gate.ts / empty_conclusion_gate.ts) so it is unit
 * testable without importing the heavy chat-handler module.
 */

import { INTERNAL_CORRECTION_FOOTER } from './internal_correction.js';

/** Minimal message shape — only what grounding needs (avoids importing the full adapter type). */
export interface GroundingMessage {
  role: string;
  content: unknown;
}

// Matches a cited arXiv id (YYMM.NNNNN, optional version) however it is written: "arXiv:2603.29831",
// "arxiv.org/abs/2603.29831", "arxiv 2603.29831". The {0,15} non-digit gap spans the "/abs/" URL path or a
// colon/space without crossing into another number. New-style ids only (old math/NNNNNNN ids are rare in
// this agent's domain and were not the fabrication seen in prod).
const ARXIV_CITE_RE = /arxiv[^\d\n]{0,15}(\d{4}\.\d{4,5})/gi;

/**
 * Returns the first arXiv id the reply asserts but that NO grounding source backs — where "grounding
 * source" = any user-role message in the window (the user's own text, plus the tool_results the harness
 * pushes back as user messages: web_fetch / web_search / read_file output). The model's own assistant text
 * never grounds a citation — that is exactly where a hallucinated id lives. Returns null when nothing is
 * cited or every cited id is grounded.
 */
export function detectUngroundedArxivCitation(text: string, messages: GroundingMessage[]): string | null {
  if (!/arxiv/i.test(text)) return null;
  const cited = new Set<string>();
  let m: RegExpExecArray | null;
  ARXIV_CITE_RE.lastIndex = 0;
  while ((m = ARXIV_CITE_RE.exec(text)) !== null) cited.add(m[1]);
  if (cited.size === 0) return null;
  let grounded = '';
  for (const mm of messages) {
    if (mm.role !== 'user') continue;
    grounded += (typeof mm.content === 'string' ? mm.content : JSON.stringify(mm.content)) + '\n';
  }
  for (const id of cited) {
    if (!grounded.includes(id)) return id;
  }
  return null;
}

/** The intra-turn rewrite directive injected when an ungrounded citation is detected. */
export function buildCitationGroundingDirective(id: string): string {
  return (
    `[citation-grounding] You cited arXiv:${id}, but nothing you actually retrieved this conversation ` +
    `contains that id (no web_fetch / web_search / read_file result) and the user never supplied it — you ` +
    `are recalling it from memory, which is precisely how fabricated references and their "results" get ` +
    `introduced.\n\n` +
    `**Rewrite your final reply.** Do NOT present arXiv:${id}, its title, its equations, or its stated ` +
    `results as established fact. Either (a) actually fetch or search for it first so the claim is grounded ` +
    `in a real tool result, or (b) drop the specific id and any equation/result attributed to it and mark ` +
    `that lead as 待核实 (unverified) — describe what you would look for, not what it says. Keep everything ` +
    `you genuinely derived or computed yourself. ` +
    INTERNAL_CORRECTION_FOOTER
  );
}
