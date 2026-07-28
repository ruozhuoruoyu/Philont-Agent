/**
 * Does this goal have a REFUTATION direction — and therefore a subgoal a machine can decide?
 *
 * The 14-round Goldbach session and the 2026-07-22 Jacobian session share one diagnosis: the tree held no
 * node that anything could check, so no round produced a signal, and "am I closer or further?" stayed
 * unanswerable for hours. Reflection stated that as a lesson for the owner to remember. A lesson you have
 * to remember is not a mechanism.
 *
 * The mechanism exists because of an asymmetry that holds for every universally quantified statement:
 * CONFIRMING it needs an argument (no finite check settles it), but REFUTING it needs one witness — which
 * is always finite, always cheap, and always decidable. So a session attacking a ∀-claim can always be
 * given at least one node with a verifier attached, whatever happens on the proof side.
 *
 * This detector decides when that pairing applies. It deliberately encodes NO list of famous conjectures:
 * a curated vocabulary of problem names would be the hard-coded-table trap this codebase has been bitten by
 * elsewhere, and it would fail on the first problem nobody thought to list. It reads STRUCTURE — an explicit
 * quantifier, or the words that mark a statement as a conjecture — which generalises to problems that do
 * not exist yet.
 */

export interface RefutableGoal {
  /** Why the pairing applies: an explicit quantifier, or conjecture-shaped phrasing. */
  reason: 'quantifier' | 'conjecture';
  /** The cue that matched, for the log and the milestone line. */
  cue: string;
}

/**
 * An explicit universal quantifier, in either language, including the symbol.
 *
 * The `i` flag is load-bearing and was missing until 2026-07-28. Its two siblings below both carry one;
 * this one did not, so the detector matched "for all n" and missed "For all n" — i.e. it missed every
 * goal that OPENS with its quantifier, which is how a mathematical proposition is normally written.
 *
 * What that cost: the LRC session's root was `Prove: For any set S of k positive integers whose residues
 * modulo (k+1) are a permutation of {1,...,k}, if S ≠ {1,...,k}, then there exists t with min distance >
 * 1/(k+1)`. Capital F, no pairing, no refutation node — so the tree never held a node a machine could
 * decide, and six consecutive sessions ground on the proof side and reported "structural mismatch between
 * the tool and the problem".
 *
 * The proposition is FALSE. S = {1,3,4,7} has residues {1,3,4,2} mod 5, is not {1,2,3,4}, and its best t
 * achieves exactly 1/5 — never more (verified two ways: exact critical-point enumeration, and brute force
 * over every p/q with q ≤ 400). A counterexample search would have returned it in seconds. That search is
 * precisely the node this function exists to create.
 */
const UNIVERSAL_RE =
  /∀|\bfor\s+(?:all|every|each|any)\b|\bfor\s+arbitrary\b|\b(?:holds|true|valid)\s+for\s+(?:all|every)\b|\balways\b|\bnever\b|\bno\s+\w+\s+(?:exists|satisfies)\b|\bthere\s+is\s+no\b|对(?:所有|任意|任一|每(?:一)?个)|任意|所有|每(?:一)?个|恒(?:成立|等|为)|总是|从不|不存在/i;

/** Conjecture-shaped: the claim is asserted as generally true and awaits proof or refutation. */
const CONJECTURE_RE = /\bconjectur|\bhypothesis\b|\btheorem\b|猜想|假说|定理/i;

/**
 * Decision / preference / narrative goals. These have no refutation direction — "should I adopt X" is not
 * false in the presence of a witness — and pairing them with a counterexample hunt would be noise. Screened
 * first, so a decision goal that happens to contain "all" or "every" stays out.
 */
const DECISION_RE =
  /\bshould\s+(?:i|we)\b|\bwhich\s+(?:one|option|approach)\b|\bhow\s+(?:do|should)\s+(?:i|we)\b|\brecommend\b|\bcompare\b|\bworth\s+it\b|该不该|要不要|值不值|怎么(?:选|做|办)|选哪|哪(?:个|种)更|建议我/i;

/**
 * Return the pairing reason, or null when the goal has no refutation direction.
 *
 * Failure direction is deliberately toward NOT creating the node: a missing pairing leaves today's
 * behaviour, while a spurious one puts a nonsense claim on the tree that the model must then dispose of.
 */
export function findRefutableGoal(goal: string | null | undefined): RefutableGoal | null {
  const text = (goal ?? '').trim();
  if (text.length < 6) return null;
  if (DECISION_RE.test(text)) return null;

  const q = UNIVERSAL_RE.exec(text);
  if (q) return { reason: 'quantifier', cue: q[0] };

  const c = CONJECTURE_RE.exec(text);
  if (c) return { reason: 'conjecture', cue: c[0] };

  return null;
}

/**
 * The paired node's claim.
 *
 * It is phrased as a PROPOSITION, not as a task. "Search for a counterexample" is something one can be
 * busy with forever; it has no truth value, so nothing can ever check it — which is failure mode (3) from
 * the same diagnosis, and the reason a decomposition full of tasks produces no signal. "No counterexample
 * exists in region R" is true or false, and both outcomes are worth having: a witness refutes the parent
 * goal outright, and an exhausted region is a real, citable result.
 */
export function renderRefutationClaim(goal: string): string {
  const g = goal.trim().replace(/\s+/g, ' ').slice(0, 160);
  return (
    `No counterexample to "${g}" exists inside an explicitly stated bounded region. ` +
    `Settle this ONLY with the output of an actual computation (pariGp / shell): either the witness — ` +
    `which refutes the goal itself, the strongest possible outcome — or the region you enumerated and the ` +
    `tool's report that it is clear. Naming the region is part of the claim; "I looked and found nothing" ` +
    `is not a result.`
  );
}

/** One line for the owner-facing start milestone, so the pairing is visible rather than silent. */
export function renderRefutationNote(reason: RefutableGoal['reason']): string {
  const why =
    reason === 'quantifier'
      ? 'this goal is universally quantified'
      : 'this goal is conjecture-shaped, so it asserts something generally true';
  return (
    `🎯 Paired a refutation node: ${why}, and while a proof needs an argument, a DISPROOF needs one ` +
    `witness — which a machine can decide. The tree therefore starts with at least one node something can ` +
    `check, whatever happens on the proof side.`
  );
}
