/**
 * Detection of a SELF-CONTAINED, MACHINE-CHECKABLE object inside a settled claim.
 *
 * Sibling of findOrderClaim (honesty_gate.ts), which catches the asymptotic/estimate class. This one
 * catches the class that made the 2026-07-22 Jacobian session embarrassing: a deliberate (evidence-based)
 * session held an explicit polynomial map, an explicit determinant value, and three explicit points said to
 * collide — every one of them decidable by one tool call, in about four seconds — and settled the node on
 * CITATIONS instead. The engine had z3Verify / pariGp / shell available the whole time.
 *
 * The gap was structural, not a lapse: mode is chosen once at session start, so a formal object landing
 * inside a deliberate session met no verification tooth at all. A claim's checkability is a property of the
 * CLAIM, not of the session it happens to land in.
 *
 * Precision over recall, deliberately. A false positive costs one refused settle (the caller re-settles and
 * is let through with a caveat); a false negative is only the status quo. So every pattern requires BOTH an
 * assertion cue AND real algebraic structure — a bare number, a version string, a config line or a citation
 * must never match.
 */

export type CheckableKind =
  /** An explicit determinant / Jacobian value: "the Jacobian determinant is identically -2". */
  | 'determinant'
  /** A symbolic identity with algebraic structure on at least one side: "f = (1+xy)^3 z + y^2(1+xy)". */
  | 'identity'
  /** An explicit point/tuple said to evaluate to an explicit image: "(0,0,-1/4) -> (-1/4,0,0)". */
  | 'evaluation'
  /** An explicit primality / divisibility claim about a concrete expression. */
  | 'arithmetic';

export interface CheckableObject {
  kind: CheckableKind;
  /** Short excerpt of what was matched, for the message shown to the model. */
  excerpt: string;
  /** The tool that decides this class here. */
  tool: 'pariGp' | 'z3Verify';
}

/** Trim an excerpt around a match so the message names what was seen without dumping the node. */
function excerptAround(text: string, at: number, len: number): string {
  return text.slice(Math.max(0, at - 16), at + len + 44).replace(/\s+/g, ' ').trim().slice(0, 90);
}

/**
 * Screens that kill a match before it is considered. These are the shapes that carry an `=` or a number
 * without asserting any mathematics: URLs and query strings, environment/config lines, version numbers,
 * and counts of characters/tokens/lines (the Jacobian transcript contained "216 characters", which must
 * not be read as an arithmetic claim).
 */
const URL_OR_CONFIG_RE = /https?:\/\/|\?[a-z_]+=|^[A-Z][A-Z0-9_]{3,}=|\b(?:version|v)\s*=?\s*\d+\.\d+/im;
const COUNT_NOUN_RE = /\d+\s*(?:characters?|chars?|tokens?|lines?|bytes?|字符|个字|行|条|次)\b/i;

/** A variable-looking symbol: a single latin letter, optionally subscripted, not part of a longer word. */
const VAR = '[a-zA-Z](?:[_₀-₉]?[0-9₀-₉]?)';

/**
 * Algebraic structure test: does this side of an equation look like an EXPRESSION rather than a value or a
 * word? Requires a variable in contact with arithmetic — a coefficient (`3x`), a juxtaposed product (`xy`),
 * a power (`x^3`, `y²`), or a parenthesised group containing an operator.
 */
function hasAlgebraicStructure(side: string): boolean {
  if (!side) return false;
  // Both conditions are required. Either alone is a known false-positive source: an operator alone matches
  // any hyphenated prose, and a "juxtaposed variables" test alone matched every two-letter English word —
  // "the whole difficulty here" read as algebra until this was split in two.
  const hasOperator = /[+*/^]|\s-\s|[²³⁴⁵⁶⁷⁸⁹]/.test(side);
  if (!hasOperator) return false;
  const coefficient = new RegExp(`\\d\\s*${VAR}(?![A-Za-z])`).test(side); // 3x, 2 y
  const power = new RegExp(`(?<![A-Za-z])${VAR}\\s*(?:\\^|\\*\\*|[²³⁴⁵⁶⁷⁸⁹])`).test(side); // x^3, y²
  const group = /\([^()]*[-+*/^][^()]*\)/.test(side); // (1+xy), (4+3xy)
  return coefficient || power || group;
}

/** A numeric literal, including a rational and the common unicode vulgar fractions. */
const NUM = '-?(?:\\d+(?:\\.\\d+)?(?:/\\d+)?|[¼½¾⅓⅔])';
/** A tuple of >= 2 numeric entries, e.g. (0,0,-1/4) or (-¼, 0, 0). Full-width parens included. */
const TUPLE = `[(（]\\s*${NUM}(?:\\s*[,，]\\s*${NUM}){1,6}\\s*[)）]`;

// The cue is OPTIONAL: production wrote "with constant Jacobian determinant -2", where the assertion is
// carried by the noun and the bare number. Requiring an `=` missed exactly the string that mattered.
const DETERMINANT_RE = new RegExp(
  `(?:jacobian|determinant|行列式|雅可比)[^.。;；\\n]{0,32}?(?:≡|=|==|is\\s+identically|identically|constant|恒(?:等于|为)|等于|为|of)?\\s*(${NUM})\\b`,
  'i',
);

const EVALUATION_RE = new RegExp(`${TUPLE}[^\\n]{0,64}?(?:->|→|↦|\\bmaps? to\\b|映射到|都?(?:映射|送)到)[^\\n]{0,24}?${TUPLE}`, 'i');

const PRIMALITY_RE = new RegExp(
  `(${NUM}|[\\d^*+\\-()]{5,})\\s*(?:is|are|是|为)\\s*(?:a\\s+)?(?:prime|composite|素数|质数|合数)\\b`,
  'i',
);

/**
 * Find the first machine-checkable object in a claim, or null.
 *
 * Order matters only for the message: a determinant claim is reported as such even when the same text also
 * carries an identity, because it names the sharper thing to compute.
 */
export function findCheckableObject(text: string | null | undefined): CheckableObject | null {
  const raw = (text ?? '').trim();
  if (raw.length < 12) return null;
  if (URL_OR_CONFIG_RE.test(raw)) return null;

  const det = DETERMINANT_RE.exec(raw);
  if (det) return { kind: 'determinant', excerpt: excerptAround(raw, det.index, det[0].length), tool: 'pariGp' };

  const evalM = EVALUATION_RE.exec(raw);
  if (evalM) return { kind: 'evaluation', excerpt: excerptAround(raw, evalM.index, evalM[0].length), tool: 'pariGp' };

  // Symbolic identity: a SHORT NAME immediately left of `=`, and a real expression to its right. Anchoring
  // on the whole prefix instead failed on the production string, where the definition sits at the end of a
  // sentence ("a polynomial map F: C^3 -> C^3: a = (1+xy)^3 z + …") — the prefix reads as prose and was
  // screened out, taking the object with it. Comparison and assignment-in-config operators are excluded.
  const IDENTITY_RE = /(?:^|[^A-Za-z0-9_=<>!])([A-Za-z][A-Za-z0-9_₀-₉]{0,12})\s*(?:=|≡)(?!=)\s*([^=\n]{6,})/g;
  for (let m = IDENTITY_RE.exec(raw); m; m = IDENTITY_RE.exec(raw)) {
    // Stop the right side at the next clause boundary: a following ", with constant Jacobian …" is a
    // separate assertion, not part of the expression.
    const rhs = m[2].split(/[,，;；]|\swith\s|\sand\s/)[0];
    if (!rhs || COUNT_NOUN_RE.test(rhs)) continue;
    if (!hasAlgebraicStructure(rhs)) continue;
    return { kind: 'identity', excerpt: excerptAround(raw, m.index, m[0].length), tool: 'pariGp' };
  }

  const prime = PRIMALITY_RE.exec(raw);
  if (prime && !COUNT_NOUN_RE.test(prime[0])) {
    return { kind: 'arithmetic', excerpt: excerptAround(raw, prime.index, prime[0].length), tool: 'pariGp' };
  }

  return null;
}

/** The directive handed back when a settle is refused for carrying an unchecked object. */
export function renderCheckableObjectRefusal(obj: CheckableObject): string {
  const what: Record<CheckableKind, string> = {
    determinant: 'a determinant/Jacobian value',
    identity: 'a symbolic identity',
    evaluation: 'an explicit point and its claimed image',
    arithmetic: 'a primality/divisibility claim about a concrete number',
  };
  return (
    `this claim carries ${what[obj.kind]} — "${obj.excerpt}" — which a machine can DECIDE, and nothing in ` +
    `this session has computed it. Citing a source that asserts it is not the same as checking it. Run ` +
    `${obj.tool} (or shell, for a CAS) on the object itself, then settle with the tool's own output as the ` +
    `result. If the object turns out to be wrong, that is the finding.`
  );
}

/** Caveat appended when the same node is settled again without any verification having happened. */
export const CHECKABLE_OBJECT_CAVEAT =
  '  [⚠ unverified object — this claim contains something machine-decidable that was never computed in ' +
  'this session; it is settled on assertion, not on a check]';
