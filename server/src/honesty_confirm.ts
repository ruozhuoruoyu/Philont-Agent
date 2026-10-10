/**
 * Confirmation of a PROVISIONAL honesty verdict (2026-10-10).
 *
 * The size-claim branch of the honesty gate decides on its own only when the sentence names a file
 * the turn's tools touched. Every other figure the ledger cannot match used to be ruled a fabricated
 * file size outright — "84GB" of VRAM, "2MB per token", "24 GB" quoted from a paper — and after the
 * rewrite said it again, the whole reply was withheld. Keyword lists for "is this about a file" were
 * tried and withdrawn the same day; the house rule applies instead: the model is consulted inside the
 * window the mechanism opened and asked only what the sentence ASSERTS, never whether it is true.
 * Every failure path drops the verdict: a figure the gate cannot classify is not a lie it can prove.
 */
import type { HonestyEvaluation, HonestyConfirmation } from '@agent/memory';

export type AskFn = (req: { system: string; user: string; maxTokens: number; requireComplete?: boolean }) => Promise<string | null>;

/**
 * Master switch for the honesty gate (2026-10-10). Default ON; PHILONT_HONESTY_GATE=0/off/false/no drops
 * every verdict before it can intercept, regenerate or confirm anything. It exists for ablation runs that
 * measure what the gate buys on a benchmark — not for production, where the gate is the safety belt.
 */
export function honestyGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PHILONT_HONESTY_GATE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

export function buildSizeConfirmPrompt(c: HonestyConfirmation): { system: string; user: string } {
  return {
    system:
      'You classify what ONE sentence of an assistant reply asserts. Decide only this: does the sentence state the given figure as ' +
      'the byte size of a file the assistant itself created, wrote, downloaded, converted or inspected in this turn? ' +
      'Memory, VRAM, GPU or disk capacity, model weights or parameters, bandwidth, quotas, limits, estimates, and figures quoted ' +
      'or attributed to a document, a paper, a web page or another source are NOT such files. Never judge whether the figure is true. ' +
      'Answer with JSON only: {"file_size_claim": true|false, "file": "<file name or null>"}',
    user: [
      `Files this turn's tools touched: ${c.ledgerFiles.length ? c.ledgerFiles.join(', ') : '(none named)'}`,
      `Tool output the figure was compared with (abbreviated): ${c.ledgerExcerpt || '(none)'}`,
      '',
      `Figure: ${c.figure}`,
      `Sentence: ${c.sentence.slice(0, 600)}`,
      '',
      'JSON:',
    ].join('\n'),
  };
}

/** Lenient JSON read; null when the reply does not answer the question. */
export function parseSizeConfirmation(raw: string | null | undefined): boolean | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const m = /"file_size_claim"\s*:\s*(true|false)/i.exec(t);
  if (m) return m[1].toLowerCase() === 'true';
  if (/^\s*(true|yes)\b/i.test(t)) return true;
  if (/^\s*(false|no)\b/i.test(t)) return false;
  return null;
}

export interface ConfirmOutcome {
  verdict: 'confirmed' | 'cleared' | 'unavailable';
  basis: 'llm' | 'none';
  evaluation: HonestyEvaluation | null;
}

/** Confirm or drop a provisional verdict. A verdict without `confirm` passes through untouched. Never throws. */
export async function confirmProvisionalHonesty(
  v: HonestyEvaluation | null,
  ask: AskFn | undefined,
): Promise<ConfirmOutcome> {
  if (!v) return { verdict: 'cleared', basis: 'none', evaluation: null };
  if (!v.confirm) return { verdict: 'confirmed', basis: 'none', evaluation: v };
  if (!ask) return { verdict: 'unavailable', basis: 'none', evaluation: null };
  try {
    const { system, user } = buildSizeConfirmPrompt(v.confirm);
    const answer = parseSizeConfirmation(await ask({ system, user, maxTokens: 64, requireComplete: true }));
    if (answer === null) return { verdict: 'unavailable', basis: 'none', evaluation: null };
    if (!answer) return { verdict: 'cleared', basis: 'llm', evaluation: null };
    const { confirm: _dropped, ...rest } = v;
    return { verdict: 'confirmed', basis: 'llm', evaluation: rest as HonestyEvaluation };
  } catch {
    return { verdict: 'unavailable', basis: 'none', evaluation: null };
  }
}
