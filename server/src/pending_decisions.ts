/**
 * Which pending decision is this reply answering?
 *
 * Philont asks its owner for several different things — enter deep reasoning, authorize this tool,
 * let background research use that one, answer a question — and each kind kept its own
 * `Map<sessionId, pending>` and tried to interpret whatever arrived next. Two consequences, both
 * silent:
 *
 *   · Same kind, one slot. `pendingResearchGrants.set(sessionId, …)` with no check, so research B's
 *     request overwrote research A's. The owner answers the card they can see; the server applies it
 *     to the other one, and A waits forever for a reply that was already spent.
 *
 *   · Different kinds, fixed order. The reply goes to whichever module is checked first in the
 *     handler — deep-explore ask, then tool authorization, then research, then question — which has
 *     nothing to do with which card the owner was looking at. "同意" typed at a research card can
 *     approve a `git push` that happened to be asked later.
 *
 * The fix is not another map. The replies were never addressed: several modules were competing to
 * read one unaddressed sentence. This is the address book. It does not own the pending state — each
 * kind keeps its own payload and its own resume path — it owns the question "who is this for", and
 * it refuses to guess when the answer is not determined.
 *
 * The channel already carries the best address available: WeChat inbound messages include `ref_msg`
 * when the owner quotes what they are replying to. Quoting the card is exact, costs the owner
 * nothing, and needs no new vocabulary.
 */

/** One thing philont is waiting on the owner for. The payload stays with whoever created it. */
export interface PendingDecision {
  id: string;
  kind: 'tool_authorization' | 'research_authorization' | 'deep_explore_entry' | 'question';
  /** One line, as shown on the card — used to match a quoted reply and to render the list. */
  title: string;
  /** The words this card offered, matched exactly. Empty for open questions. */
  offered: readonly string[];
  createdAt: number;
  expiresAt: number;
}

export type ReplyRouting =
  | { kind: 'addressed'; id: string; how: 'quoted' | 'indexed' | 'named' | 'only-one' }
  | { kind: 'ambiguous'; candidates: PendingDecision[] }
  | { kind: 'unaddressed' };

const punctuation = /[。！？，,!?.\s"'「」【】()（）]+/g;

function normalize(text: string): string {
  return (text ?? '').trim().toLowerCase().replace(punctuation, '');
}

/** Does this reply use one of the words a card offered? Exact match, as those words are ours. */
function usesOfferedWord(reply: string, decision: PendingDecision): boolean {
  const normalized = normalize(reply);
  if (!normalized) return false;
  return decision.offered.some((w) => normalized === normalize(w));
}

/**
 * `1` / `1 同意` / `第2个 拒绝` — an index into the list as it was last rendered. Short numbers are
 * what a person types on a phone; the ids exist for replies that arrive somewhere else.
 *
 * A number alone is not enough to claim a reply: "2 个问题都先放着" opens with a 2 and answers
 * nothing. The index counts only when what remains around it is empty or is one of the words that
 * item offered — so the number selects, and the rest still has to say something.
 */
function extractIndex(
  reply: string,
  decisions: readonly PendingDecision[],
): number | null {
  const normalized = normalize(reply);
  const m = normalized.match(/^第?([0-9１-９]{1,2})[个号.、]?/) ?? normalized.match(/第([0-9１-９]{1,2})个?/);
  if (!m) return null;
  const digits = m[1].replace(/[１-９]/g, (d) => String('１２３４５６７８９'.indexOf(d) + 1));
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > decisions.length) return null;

  const remainder = normalized.replace(m[0], '');
  const target = decisions[n - 1]!;
  if (remainder.length === 0) return n;
  return target.offered.length === 0 || target.offered.some((w) => remainder === normalize(w)) ? n : null;
}

function mentionsId(reply: string, id: string): boolean {
  return normalize(reply).includes(normalize(id));
}

/**
 * Route a reply to at most one pending decision.
 *
 * The rule that matters is the refusal: with more than one thing outstanding, a bare "同意" is
 * ambiguous and is reported as such rather than applied to whichever module happens to be checked
 * first. Guessing here does not merely mislabel — it spends the owner's answer on the wrong
 * authorization and leaves the other request waiting for a reply that will never come again.
 */
export function routeReply(
  reply: string,
  outstanding: readonly PendingDecision[],
  opts: { now: number; quotedText?: string } = { now: Date.now() },
): ReplyRouting {
  const live = outstanding.filter((d) => d.expiresAt > opts.now);
  if (live.length === 0) return { kind: 'unaddressed' };

  // 1. The owner quoted the card. Exact, and free for them.
  if (opts.quotedText && opts.quotedText.trim()) {
    const quoted = normalize(opts.quotedText);
    const hit = live.find((d) => quoted.includes(normalize(d.title)) || quoted.includes(normalize(d.id)));
    if (hit) return { kind: 'addressed', id: hit.id, how: 'quoted' };
  }

  // 2. An id, said outright.
  const named = live.find((d) => mentionsId(reply, d.id));
  if (named) return { kind: 'addressed', id: named.id, how: 'named' };

  // 3. A position in the list as it was last shown.
  const index = extractIndex(reply, live);
  if (index !== null) return { kind: 'addressed', id: live[index - 1]!.id, how: 'indexed' };

  // 4. Nothing points at a specific one. A reply that does not use any offered vocabulary is not an
  //    answer to a card at all — it is a new message, and it must leave every card standing.
  const answerable = live.filter((d) => d.offered.length === 0 || usesOfferedWord(reply, d));
  if (answerable.length === 0) return { kind: 'unaddressed' };
  if (answerable.length === 1) return { kind: 'addressed', id: answerable[0]!.id, how: 'only-one' };
  return { kind: 'ambiguous', candidates: answerable };
}

/**
 * What to send when a reply could have been meant for several things. Merging the NOTIFICATION is
 * right; merging the decision is not — a shell run, an external publish and a routing choice carry
 * different consequences and a single "yes to all" is how an approval comes to mean more than the
 * person granting it intended.
 */
export function renderAmbiguityPrompt(
  candidates: readonly PendingDecision[],
  lang: 'zh' | 'en' = 'zh',
): string {
  const lines = candidates.map((d, i) => `${i + 1}. ${d.title}`);
  return lang === 'en'
    ? `That could answer more than one thing, so I have not applied it. Waiting on you:\n${lines.join('\n')}\n\n` +
      `Reply with the number (e.g. "1 yes"), or quote the card you mean.`
    : `这句话能回答不止一件事，所以我没有动它们。等你决定的有：\n${lines.join('\n')}\n\n` +
      `回复序号即可（例如「1 同意」），或者直接引用那张卡片回复。`;
}

/** The outstanding decisions of one conversation. Each kind keeps its own payload and resume path. */
export class PendingDecisionBook {
  private readonly bySession = new Map<string, PendingDecision[]>();

  /**
   * Register a new one. Unlike the single-slot maps this replaces, an arriving request never
   * displaces an unanswered one — that was how a card became an orphan the owner had already seen.
   */
  add(sessionId: string, decision: PendingDecision): void {
    const list = this.bySession.get(sessionId) ?? [];
    list.push(decision);
    this.bySession.set(sessionId, list);
  }

  list(sessionId: string, now = Date.now()): PendingDecision[] {
    const live = (this.bySession.get(sessionId) ?? []).filter((d) => d.expiresAt > now);
    if (live.length === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, live);
    return live;
  }

  resolve(sessionId: string, id: string): void {
    const list = (this.bySession.get(sessionId) ?? []).filter((d) => d.id !== id);
    if (list.length === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, list);
  }

  /** Drop every decision of one kind for this session (e.g. a turn that abandoned its own asks). */
  resolveKind(sessionId: string, kind: PendingDecision['kind']): void {
    const list = (this.bySession.get(sessionId) ?? []).filter((d) => d.kind !== kind);
    if (list.length === 0) this.bySession.delete(sessionId);
    else this.bySession.set(sessionId, list);
  }
}
