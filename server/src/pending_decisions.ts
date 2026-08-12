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

/**
 * May a bare "同意" resolve this, when it is the only thing it could be answering?
 *
 * For a routing choice or an ordinary question, yes — the cost of a misread is a wasted round. For
 * publishing, credentials or a destructive command it is not: a yes that arrives out of context,
 * possibly minutes later and about something the owner has half-forgotten, should not be what
 * authorizes `git push`. Those want the owner to point at the thing they mean.
 */
export type ResolutionPolicy = 'unique_bare_reply_allowed' | 'explicit_address_required';

/** One thing philont is waiting on the owner for. The payload stays with whoever created it. */
export interface PendingDecision {
  id: string;
  kind: 'tool_authorization' | 'research_authorization' | 'deep_explore_entry' | 'question';
  /** One line, as shown on the card — used to match a quoted reply and to render the list. */
  title: string;
  /** For a high-risk item, the exact thing being authorized (the command, the URL). Shown in full. */
  detail?: string;
  /** The words this card offered, matched exactly. Empty for open questions. */
  offered: readonly string[];
  resolutionPolicy: ResolutionPolicy;
  createdAt: number;
  expiresAt: number;
}

/**
 * The list as the owner last saw it.
 *
 * "1 同意" means the first item OF THAT LIST. Re-deriving the numbering from whatever is outstanding
 * when the reply arrives is a race with a plausible-looking wrong answer: a new request registered
 * in between shifts every position, and the owner's "1" silently authorizes something they were
 * never shown in that slot. Ordinals resolve against the snapshot or not at all.
 */
export interface DecisionListSnapshot {
  displayedAt: number;
  /** Position → decision id, exactly as rendered. */
  ordinals: readonly string[];
}

/** How long a displayed list stays addressable by position. */
export const SNAPSHOT_TTL_MS = 30 * 60_000;

export type ReplyRouting =
  | { kind: 'addressed'; id: string; how: 'quoted' | 'indexed' | 'named' | 'only-one' }
  | { kind: 'ambiguous'; candidates: PendingDecision[] }
  /** Exactly one candidate, but it is not the kind of thing a bare yes may decide. */
  | { kind: 'needs-address'; decision: PendingDecision }
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
 * `1` / `1 同意` / `第2个 拒绝` — a position in the list the owner was last SHOWN. Short numbers are
 * what a person types on a phone; ids exist for replies that arrive somewhere else.
 *
 * Two things make a number safe to act on. It has to resolve against the snapshot that was displayed
 * rather than against the live set, or a request registered in between shifts every position under
 * the owner's answer. And a number alone is not a decision: "2 个问题都先放着" opens with a 2 and
 * answers nothing, so the rest of the sentence still has to be one of the words that item offered.
 */
function resolveOrdinal(
  reply: string,
  live: readonly PendingDecision[],
  snapshot: DecisionListSnapshot | undefined,
  now: number,
): PendingDecision | null {
  if (!snapshot || now - snapshot.displayedAt > SNAPSHOT_TTL_MS) return null;
  const normalized = normalize(reply);
  const m = normalized.match(/^第?([0-9１-９]{1,2})[个号.、]?/) ?? normalized.match(/第([0-9１-９]{1,2})个?/);
  if (!m) return null;
  const digits = m[1].replace(/[１-９]/g, (d) => String('１２３４５６７８９'.indexOf(d) + 1));
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1 || n > snapshot.ordinals.length) return null;

  const target = live.find((d) => d.id === snapshot.ordinals[n - 1]);
  if (!target) return null; // that slot has since been resolved or expired

  const remainder = normalized.replace(m[0], '');
  if (remainder.length === 0) return target;
  return target.offered.length === 0 || target.offered.some((w) => remainder === normalize(w))
    ? target
    : null;
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
  opts: { now: number; quotedText?: string; snapshot?: DecisionListSnapshot } = { now: Date.now() },
): ReplyRouting {
  const live = outstanding.filter((d) => d.expiresAt > opts.now);
  if (live.length === 0) return { kind: 'unaddressed' };

  // 1. The owner quoted the card. Exact, and free for them — the channel already carries it.
  if (opts.quotedText && opts.quotedText.trim()) {
    const quoted = normalize(opts.quotedText);
    const hit = live.find((d) => quoted.includes(normalize(d.title)) || quoted.includes(normalize(d.id)));
    if (hit) return { kind: 'addressed', id: hit.id, how: 'quoted' };
  }

  // 2. An id, said outright — the form that survives arriving in a different conversation.
  const named = live.find((d) => mentionsId(reply, d.id));
  if (named) return { kind: 'addressed', id: named.id, how: 'named' };

  // 3. A position in the list as it was shown.
  const byOrdinal = resolveOrdinal(reply, live, opts.snapshot, opts.now);
  if (byOrdinal) return { kind: 'addressed', id: byOrdinal.id, how: 'indexed' };

  // 4. Nothing points at a specific one. A reply using none of the offered vocabulary is not an
  //    answer to a card at all — it is a new message, and every card stays up.
  //
  //    Ambiguity is judged over everything this reply COULD be answering, before policy narrows it.
  //    Filtering by policy first would let a bare "同意" quietly resolve the low-risk item while the
  //    `git push` the owner may well have meant sits beside it — the mis-addressing this exists to
  //    stop, wearing a safer-looking mask.
  const candidates = live.filter((d) => d.offered.length === 0 || usesOfferedWord(reply, d));
  if (candidates.length === 0) return { kind: 'unaddressed' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };

  const only = candidates[0]!;
  if (only.resolutionPolicy === 'explicit_address_required') {
    return { kind: 'needs-address', decision: only };
  }
  return { kind: 'addressed', id: only.id, how: 'only-one' };
}

/**
 * What to send when a reply could have been meant for several things.
 *
 * Merging the NOTIFICATION is right; merging the decision is not. A shell run, an external publish
 * and a routing choice carry different consequences, and one yes covering all three is how an
 * approval comes to mean more than the person granting it intended — so there is no approve-all, and
 * each line names its subject, its action and what it is for. It also says plainly that nothing was
 * executed: the system knows exactly where the ambiguity is, and "I didn't understand" would be
 * both false and useless.
 */
export function renderAmbiguityPrompt(
  candidates: readonly PendingDecision[],
  lang: 'zh' | 'en' = 'zh',
): string {
  const line = (d: PendingDecision, i: number) =>
    `${i + 1}. ${d.title}${d.detail ? `\n   ${d.detail}` : ''}`;
  const items = candidates.map(line).join('\n');
  return lang === 'en'
    ? `That could be answering more than one of these, so I have run none of them:\n${items}\n\n` +
      `Reply "1 yes" / "2 no", or quote the card you mean.`
    : `这句话可能是在回答其中不止一件，所以我一个都没有执行：\n${items}\n\n` +
      `请回复「1 同意」或「2 拒绝」，也可以直接引用对应卡片回复。`;
}

/**
 * The one candidate is real, but it is not the kind of thing a bare yes may decide. Say which, and
 * show the exact operation — a `git push` is authorized by pointing at that command, not by a word
 * that arrived some minutes later about a subject the owner has half put down.
 */
export function renderNeedsAddressPrompt(
  decision: PendingDecision,
  lang: 'zh' | 'en' = 'zh',
): string {
  const what = decision.detail ? `\n   ${decision.detail}` : '';
  return lang === 'en'
    ? `This one needs you to point at it, so I have not run it:\n1. ${decision.title}${what}\n\n` +
      `Reply "1 yes", quote the card, or say the id ${decision.id}.`
    : `这一件需要你明确指向，所以我没有执行：\n1. ${decision.title}${what}\n\n` +
      `回复「1 同意」、引用那张卡片，或者说出编号 ${decision.id}。`;
}

/**
 * The tail added to an ordinary reply while things are outstanding. A nudge, not a re-ask: the
 * owner's message answered none of them and must consume none of them.
 */
export function renderPendingTail(
  outstanding: readonly PendingDecision[],
  lang: 'zh' | 'en' = 'zh',
): string {
  if (outstanding.length === 0) return '';
  return lang === 'en'
    ? `\n\n(Also: ${outstanding.length} thing(s) waiting on your decision — say "pending" to see them.)`
    : `\n\n（另外还有 ${outstanding.length} 件事等你决定；回复「待办」可以查看。）`;
}

/** The outstanding decisions of one conversation. Each kind keeps its own payload and resume path. */
export class PendingDecisionBook {
  private readonly bySession = new Map<string, PendingDecision[]>();
  private readonly lastShown = new Map<string, DecisionListSnapshot>();

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

  /**
   * Record the list exactly as it was rendered, so "1" keeps meaning what the owner saw. Called by
   * whoever displays a numbered list — the disambiguation prompt, the digest, the pending view.
   */
  snapshot(sessionId: string, shown: readonly PendingDecision[], now = Date.now()): void {
    this.lastShown.set(sessionId, { displayedAt: now, ordinals: shown.map((d) => d.id) });
  }

  lastSnapshot(sessionId: string): DecisionListSnapshot | undefined {
    return this.lastShown.get(sessionId);
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
