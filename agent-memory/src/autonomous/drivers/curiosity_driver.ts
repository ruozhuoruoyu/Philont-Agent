/**
 * CuriosityDriver — the "curiosity" component of the initiative architecture.
 *
 * Key difference from the old TsCuriosityDrive:
 *   - Old: scans **user messages** for tokens and nudges the LLM "you should look this up"
 *   - New: scans **its own memory state** (tokens extracted from timeline minus already-queried
 *          history, plus high-stake aging pursuits that have never been advanced),
 *          and lets the executor **actually do the lookup**
 *
 * Trigger sources:
 *   A. token-gap   — specific tokens that appear repeatedly in the past 7-day timeline but
 *                    have never appeared in facts.sourceRefs or any done initiative
 *   B. dormant-pursuit — active pursuit with last_touched_ts > 14 days and stake_weight ≥ 7,
 *                    with empty evidenceRefs (never produced any fact/note)
 *
 * At most top-3 candidates are produced per tick (self-capped inside the driver);
 * the loop sorts and truncates again globally.
 */

import type {
  Driver,
  InitiativeProposal,
  MemorySnapshot,
} from '../types.js';
import { shouldPromoteToGoal, DEFAULT_TRAITS, type TraitProfile } from '../../drives_to_goals.js';
import { looksLikeCredential, redactForLog } from '../../credential_shape.js';

// ── extractSpecificTokens ────────────────────────────────────────────────────
//
// Extracts tokens from the timeline that name something OUTSIDE this system and are therefore worth one
// web lookup:
//   1. Academic/standard IDs (arxiv/CVE/RFC/PEP/ISO/IETF)
//   2. lib@version
//   3. URL
//   4. Quoted content that is shaped like a PRODUCT / MODEL / VERSION name — ASCII, no spaces, and
//      carrying a digit ("Hermes-2", "GPT-4", "v1.2.3")
//   5. Content inside 《》 book-title brackets — by convention, a work's title
//
// ── What was removed, and why (2026-07-23) ──────────────────────────────────
//
// Two further rules used to run here and produced, empirically, ALL of the junk and none of the value:
//
//   - any run of 3+ uppercase letters not in a 30-word blacklist;
//   - any quoted string of 2..40 chars containing "a structural signal", which was implemented as
//     "contains at least one ASCII letter, digit or separator" — so every quoted English phrase passed.
//
// The acronym rule is GONE: nothing distinguishes "DSML" from "USERS" by shape, so only a vocabulary
// could separate them, and a vocabulary is the trap. The quoted rule is NARROWED rather than deleted,
// because it did have a real intended case with a test behind it — a quoted product/model/version name.
// That case has a shape: ASCII, no spaces, and a digit. Every one of the 45 junk tokens fails it, and
// "Hermes-2" / "GPT-4" / "v1.2.3" still pass.
//
// Over one production night those two rules generated 45 research targets and the ID/URL rules generated
// zero. The 45: POST, CST, UTC, ZERO, HIGH, USERS, COMMUNITIES, AGENTS, "body", "...", "great point",
// "and handle", "post_id", "community_id". Each became a real webSearch and a real initiative; the night
// cost ~48k tokens and produced nothing.
//
// The fix is not a longer blacklist. The blacklist was already the hard-coded-vocabulary trap this
// codebase has been bitten by repeatedly, and no list of English words could have been long enough,
// because the premise was wrong:
//
//   > The timeline is philont's own conversation with its owner. A bare string lifted out of it is OUR
//   > OWN vocabulary — a field name, an HTTP verb, a log level, a phrase the owner used — not an external
//   > entity. Only tokens that are external identifiers BY CONSTRUCTION are worth an outside lookup.
//
// Note what this does NOT cost: those rules never caught the case that would have justified them either.
// An unfamiliar proper noun ("FunSearch", "Drużkowski") is usually neither all-caps nor quoted, so the
// good case was already being missed. Recovering it is a semantic judgement — "is this an external entity
// worth researching?" — which by this repo's own standing rule belongs to the aux LLM, not to a regex.
// Until that exists, proposing nothing is strictly better than proposing junk.
//
// Pure heuristic, no LLM calls.

export function extractSpecificTokens(text: string): string[] {
  const found = new Set<string>();

  const idPatterns: RegExp[] = [
    /\barxiv[:\s]*(\d+\.\d+(?:v\d+)?)/gi,
    /\bcve-\d+-\d+/gi,
    /\brfc[:\s]*\d+/gi,
    /\bpep[:\s]*\d+/gi,
    /\biso[:\s]*\d+/gi,
    /\bietf[-\s]+[a-z0-9]+(?:-[a-z0-9]+)*/gi,
  ];
  for (const re of idPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(m[0].trim());
  }

  const verPattern = /\b([a-z][a-z0-9_-]{2,})@(\d+(?:\.\d+){0,2})/gi;
  let vm: RegExpExecArray | null;
  while ((vm = verPattern.exec(text)) !== null) found.add(vm[0].trim());

  const urlPattern = /\bhttps?:\/\/[^\s<>"'）)】\]]+/gi;
  let um: RegExpExecArray | null;
  while ((um = urlPattern.exec(text)) !== null) found.add(um[0].trim());

  // Quoted content, restricted to the shape of a product / model / version NAME. The digit is what
  // carries the signal: a name people bother to quote and would look up almost always caries a version or
  // generation marker, while our own vocabulary ("body", "post_id", "great point") does not. Requiring
  // pure ASCII drops quoted Chinese fragments like "2篇原创帖", which have a digit but name nothing
  // external.
  const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9._-]{1,30}$/;
  const quotedPatterns: RegExp[] = [/"([^"]{2,40})"/g, /"([^"]{2,40})"/g, /「([^」]{2,40})」/g];
  for (const re of quotedPatterns) {
    let qm: RegExpExecArray | null;
    while ((qm = re.exec(text)) !== null) {
      const inner = qm[1].trim();
      if (NAME_SHAPE.test(inner) && /\d/.test(inner)) found.add(inner);
    }
  }

  // 《》 titles. The convention is CJK: a Chinese-language work, or a foreign publication named as one
  // word (《Nature》). It used to accept anything at all — "structural signal not required, these are book
  // names" — and production duly researched 《Barrier Survey》 and 《ES Quadratic Obstruction》, which were
  // the agent's own section headings in its own reply. In a Chinese sentence 《》 marks any title, not only
  // published works, so a multi-word ASCII phrase inside it is far more likely to be our own formatting
  // than an external work worth looking up.
  const bookPattern = /《([^》]{2,40})》/g;
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  let bm: RegExpExecArray | null;
  while ((bm = bookPattern.exec(text)) !== null) {
    const inner = bm[1].trim();
    if (inner.length < 2) continue;
    if (CJK.test(inner) || !/\s/.test(inner)) found.add(inner);
  }

  // Defence in depth: applied to every rule's output, not just the removed ones. A URL can carry a token
  // in its query string, and a standard-ID match can overlap a key. The cost of dropping one candidate is
  // a skipped lookup; the cost of missing one is a live credential in a search engine's query log.
  return Array.from(found).filter((t) => !looksLikeCredential(t));
}

// ── Driver ───────────────────────────────────────────────────────────────

export interface CuriosityDriverConfig {
  /**
   * Dormancy before an OWNER-DECLARED focus is picked up, in days. Separate from pursuitAgingDays because
   * the two mean opposite things: an incidental pursuit going quiet for two weeks is probably stale, while
   * a COMPASS focus going quiet means the thing the owner explicitly asked me to care about is being
   * ignored — which is urgent almost immediately, not in a fortnight.
   *
   * Non-zero on purpose. A compass pursuit is seeded with last_touched = now precisely so that declaring
   * five focus areas does not fire five sessions at startup; one day preserves that stagger while cutting
   * the dead window from fourteen days to one.
   */
  compassAgingDays?: number;
  /** Minimum number of times a token must appear to be considered "recurring"; default 1. Snap is already deduplicated, so 1 suffices */
  minTokenMentions: number;
  /** Pursuit aging threshold (days); default 14 */
  pursuitAgingDays: number;
  /** Minimum stake_weight threshold for pursuits; default 7 */
  pursuitMinStakeWeight: number;
  /** Maximum candidates to produce per tick; default 3 */
  maxProposals: number;
  /**
   * Optional stuck-suppression hook (Phase 18, 2026-06-16). When it returns true the system is in a doom-loop
   * (e.g. high global same_root_cause) and token-curiosity is SUPPRESSED — autonomously looking up timeline
   * tokens just feeds adjacent dead topics while the main thread is walled. Injected by the server (which can
   * read the action ledger / barriers). Undefined = never suppress (back-compat).
   */
  isSystemStuck?: () => boolean;
  /**
   * S4 P1: when true (default), a sustained high-stake dormant pursuit is proposed as a COMMITTED
   * deep_explore goal-loop (promote_goal_loop) rather than a one-shot lookup — the drive → goal promotion.
   * Set false to keep the legacy one-shot dormant lookup.
   */
  promoteToGoalLoop?: boolean;
  /**
   * S4/WS1: trait profile — tunes the goal-loop promotion bar. Accepts a provider callback so a
   * driver constructed at module load still sees FRESH trait values each tick (the server derives
   * them from lived history via currentTraitProfile; a static object would freeze the personality
   * at boot, which is exactly the defect WS1 removes).
   */
  traits?: TraitProfile | (() => TraitProfile);
}

export const DEFAULT_CURIOSITY_CONFIG: CuriosityDriverConfig = {
  minTokenMentions: 1,
  pursuitAgingDays: 14,
  compassAgingDays: 1,
  pursuitMinStakeWeight: 7,
  maxProposals: 3,
  promoteToGoalLoop: true,
};

const DRIVER_NAME = 'curiosity';

export class CuriosityDriver implements Driver {
  readonly name = DRIVER_NAME;

  constructor(private readonly cfg: CuriosityDriverConfig = DEFAULT_CURIOSITY_CONFIG) {}

  propose(snap: MemorySnapshot): InitiativeProposal[] {
    const proposals: InitiativeProposal[] = [];

    // Phase 18: while the system is stuck in a doom-loop (high global same_root_cause), suppress token-curiosity.
    // Autonomously looking up timeline tokens during a wall just spawns grinding on adjacent dead topics
    // (prod: curiosity kept spawning "素数 R…/RDC…/DSML" while the main thread ground a barrier-blocked goal).
    const stuck = this.cfg.isSystemStuck?.() === true;
    if (stuck) {
      console.log('[curiosity] system stuck (same_root_cause high) → token-curiosity suppressed this tick');
    }

    // (A) Token-gap: timeline tokens minus those already referenced by fact sourceRefs or done initiatives
    const facts = snap.facts;
    const knownTokens = new Set<string>();
    for (const f of facts) {
      // Use strings appearing in sourceRefs as "already looked up" markers; sourceRefs are
      // usually URLs or note IDs — matching may not be exact, but coarse-grain is sufficient
      const v = f.value as unknown;
      if (v && typeof v === 'object' && 'sourceRefs' in v) {
        const refs = (v as { sourceRefs?: unknown }).sourceRefs;
        if (Array.isArray(refs)) {
          for (const r of refs) {
            if (typeof r === 'string') knownTokens.add(r);
          }
        }
      }
      // The fact key itself also counts as known
      knownTokens.add(f.key);
    }

    for (const tok of stuck ? [] : snap.recentTimelineTokens) {
      // Second gate, at the point of no return. The extractor already filters, but this is where a token
      // becomes an outbound `webSearch(query)` — and the snapshot is built by the loop, not by us, so a
      // future producer could put anything here. The one place worth paying for a redundant check is the
      // last one before egress.
      if (looksLikeCredential(tok)) {
        console.warn(`[curiosity] suppressed a credential-shaped token before it became a web search: ${redactForLog(tok)}`);
        continue;
      }
      const targetRef = `token:${tok}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;
      // Already referenced by any fact → not considered "unchecked"
      if (knownTokens.has(tok)) continue;
      // Literal substring match also counts as covered (URL concatenated into a sourceRef)
      let covered = false;
      for (const k of knownTokens) {
        if (k.includes(tok)) {
          covered = true;
          break;
        }
      }
      if (covered) continue;

      proposals.push({
        kind: 'curiosity_token',
        driver: DRIVER_NAME,
        targetRef,
        rationale: `"${tok}" repeatedly appears in the timeline but has never been referenced in local facts; worth a one-time lookup`,
        utility: scoreTokenUtility(tok),
        budgetEstimate: 1500,
        plan: [
          {
            tool: 'webSearch',
            params: { query: tok },
          },
        ],
      });
    }

    // (B) Dormant high-stake pursuit: commitment made but not being advanced.
    //
    // Two clocks, because a compass focus and an incidental pursuit are not the same claim on attention.
    // Production 2026-07-23: the owner's single declared focus (stake 8) was seeded on 07-16 and therefore
    // ineligible until 07-30, so for a fortnight the background loop had NOTHING owner-directed to do and
    // spent every night on token curiosity instead. The dormancy gate was doing double duty — it was the
    // anti-startup-storm mechanism AND the staleness filter — and one number could not serve both.
    const cutoff = snap.now - this.cfg.pursuitAgingDays * 86_400_000;
    const compassCutoff = snap.now - (this.cfg.compassAgingDays ?? 1) * 86_400_000;
    // Resolve traits once per propose() — the provider may hit the DB.
    const traits =
      typeof this.cfg.traits === 'function'
        ? this.cfg.traits()
        : this.cfg.traits ?? DEFAULT_TRAITS;
    for (const p of snap.activePursuits) {
      if (p.stakeWeight < this.cfg.pursuitMinStakeWeight) continue;
      const fromCompass = p.origin === 'compass';
      const lastTouched = p.lastTouchedAt ?? p.updatedAt;
      if (lastTouched > (fromCompass ? compassCutoff : cutoff)) continue;
      // Having produced output disqualifies an INCIDENTAL pursuit — it is not "never touched", so reviving
      // it is not urgent. A compass focus is the opposite: sustained attention is the entire promise, so
      // "we worked on it once and then dropped it for a day" is exactly when to pick it up again. Repeat
      // proposals are already bounded by recentDoneTargetRefs (24h) and by lastTouched moving forward each
      // time it is advanced, so the cadence this produces is roughly daily, not continuous.
      if (!fromCompass && p.evidenceRefs.length > 0) continue;
      const targetRef = `pursuit:${p.id}`;
      if (snap.recentDoneTargetRefs.has(targetRef)) continue;

      const ageDays = Math.floor((snap.now - lastTouched) / 86_400_000);
      // S4 P1: a sustained, high-stake, open theme is worth COMMITTING as a deep_explore goal-loop, not just
      // a one-off lookup. stake = stakeWeight/10; a committed-and-aged high-stake pursuit IS sustained, so
      // its stakeWeight doubles as the recurrence proxy; a pursuit is an open theme (openEnded).
      const promote =
        this.cfg.promoteToGoalLoop !== false &&
        shouldPromoteToGoal(
          { stake: p.stakeWeight / 10, recurrence: p.stakeWeight, openEnded: true },
          traits,
        );
      if (promote) {
        proposals.push({
          kind: 'promote_goal_loop',
          driver: DRIVER_NAME,
          targetRef: `goal-loop:pursuit:${p.id}`,
          rationale:
            `pursuit "${p.title}" (stake ${p.stakeWeight}/10, dormant ${ageDays}d) is a sustained high-stake ` +
            `open theme — commit it as a deep_explore goal-loop rather than a one-off lookup`,
          utility: scoreDormancyUtility(p.stakeWeight, ageDays) + 0.05,
          budgetEstimate: 3000,
          plan: [{ tool: 'deep_explore', params: { action: 'start', mode: 'deliberate', goal: p.title } }],
        });
      } else {
        proposals.push({
          kind: 'curiosity_dormant_pursuit',
          driver: DRIVER_NAME,
          targetRef,
          rationale:
            `pursuit "${p.title}" stake=${p.stakeWeight}/10 has not been touched for ${ageDays} days ` +
            `and has no evidenceRefs; should actively advance or re-evaluate`,
          utility: scoreDormancyUtility(p.stakeWeight, ageDays),
          budgetEstimate: 1800,
          plan: [
            {
              tool: 'search_notes',
              params: { query: p.title },
            },
          ],
        });
      }
    }

    // Sort by utility and truncate to top-N (driver self-limits)
    proposals.sort((a, b) => b.utility - a.utility);
    return proposals.slice(0, this.cfg.maxProposals);
  }
}

/**
 * Token type determines the utility baseline:
 *   - Academic/standard IDs (arxiv/CVE/RFC) → 0.75 (strongly worth verifying)
 *   - URL → 0.6 (may be a reference but not necessarily a core unknown)
 *   - lib@version → 0.65
 *   - Other (acronym/quoted) → 0.55
 */
function scoreTokenUtility(token: string): number {
  if (/^(arxiv|cve|rfc|pep|iso|ietf)/i.test(token)) return 0.75;
  if (/^https?:\/\//i.test(token)) return 0.6;
  if (/@\d/.test(token)) return 0.65;
  return 0.55;
}

/**
 * Pursuit dormancy score:
 *   utility = 0.5 + 0.04 * (stake_weight - 7) + min(0.15, 0.005 * ageDays)
 *   Range approximately 0.5..0.85
 */
function scoreDormancyUtility(stakeWeight: number, ageDays: number): number {
  const base = 0.5 + 0.04 * (stakeWeight - 7);
  const ageBonus = Math.min(0.15, 0.005 * ageDays);
  return Math.max(0.5, Math.min(0.85, base + ageBonus));
}
