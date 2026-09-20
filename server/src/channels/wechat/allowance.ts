/**
 * Per-inbound outbound allowance — what iLink actually meters.
 *
 * The push path was diagnosed as a context-token *time* window; the ledger says otherwise. Three
 * outages, counted from the owner's last inbound message to the first `ret=-2 prepare failed`:
 * 2026-09-13 17:32 after 9 sends, 19:06 after 10, 2026-09-14 07:18 after 10 — while a follow-up
 * went through at 05:29, six hours after the inbound, because only one message had been sent since.
 * Time does not spend the allowance; messages do. Replies, milestones and heartbeats all draw on
 * the same ten; today six of them were "本轮已运行 5 分钟", and the four milestones that carried the
 * night's work all bounced.
 *
 * The allowance is learned, not configured: a refusal after N sends is one observation of the total,
 * and a send that succeeds past the learned total raises it. An unlearned peer starts at the observed
 * ten.
 *
 * One observation is not the total. Prod 2026-09-19/20: a single refusal after three sends set the
 * total to 3; the dispatcher's reserves then held every one of the night's 47 round reports at
 * `remaining=0/3`, and at 04:47 the blocking pause card — sent at the "exhausted" ledger — went
 * through, proving the 3 wrong. A ledger that only ever ratchets down cannot recover, because the
 * reserves stop the very sends that would correct it. The total is now the MAX of the last
 * REFUSAL_WINDOW refusal points: one low outlier changes nothing; a real drop is learned once it
 * repeats. A wrong-high total costs a few refused sends (deferred to the mailbox); a wrong-low one
 * costs a night of silence.
 */
export const REFUSAL_WINDOW = 5;
export interface PeerAllowanceState {
  /** Messages the platform accepts per inbound (learned; DEFAULT_PEER_ALLOWANCE until observed). */
  total: number;
  /** Messages accepted since the peer's last inbound. */
  sentSince: number;
  /** The last REFUSAL_WINDOW send counts at which the platform refused (newest last). */
  refusalPoints?: number[];
  updatedAt: number;
}

export interface PeerAllowanceView {
  remaining: number;
  total: number;
  sentSince: number;
}

export interface AllowancePersistence {
  load(): Record<string, PeerAllowanceState>;
  save(map: Record<string, PeerAllowanceState>): void;
}

export const DEFAULT_PEER_ALLOWANCE = 10;

export class OutboundAllowance {
  private readonly map: Record<string, PeerAllowanceState>;

  constructor(
    private readonly persistence?: AllowancePersistence,
    private readonly defaultTotal = DEFAULT_PEER_ALLOWANCE,
    private readonly now: () => number = Date.now,
  ) {
    let loaded: Record<string, PeerAllowanceState> = {};
    try { loaded = persistence?.load() ?? {}; } catch { loaded = {}; }
    this.map = loaded;
  }

  private state(peer: string): PeerAllowanceState {
    return this.map[peer] ?? (this.map[peer] = { total: this.defaultTotal, sentSince: 0, updatedAt: this.now() });
  }

  private commit(peer: string, s: PeerAllowanceState): void {
    s.updatedAt = this.now();
    this.map[peer] = s;
    try { this.persistence?.save(this.map); } catch { /* the ledger is advisory; never break a send */ }
  }

  /** The peer wrote: a fresh allowance. */
  onInbound(peer: string): void {
    const s = this.state(peer);
    s.sentSince = 0;
    this.commit(peer, s);
  }

  /** A message was accepted. Past the learned total, the total was wrong: raise it. */
  onSent(peer: string): void {
    const s = this.state(peer);
    s.sentSince += 1;
    if (s.sentSince > s.total) s.total = s.sentSince;
    this.commit(peer, s);
  }

  /**
   * The platform refused (`ret=-2 prepare failed`). With sends on the ledger that count is one
   * observation of the allowance; the total is the max over the recent window (see the header).
   * A refusal with nothing sent since the inbound is some other failure; nothing is learned.
   */
  onRefused(peer: string): void {
    const s = this.state(peer);
    if (s.sentSince >= 1) {
      s.refusalPoints = [...(s.refusalPoints ?? []), s.sentSince].slice(-REFUSAL_WINDOW);
      s.total = Math.max(...s.refusalPoints);
    }
    this.commit(peer, s);
  }

  view(peer: string): PeerAllowanceView {
    const s = this.state(peer);
    return { remaining: Math.max(0, s.total - s.sentSince), total: s.total, sentSince: s.sentSince };
  }
}
