/**
 * Is this bare string shaped like a credential? — for paths that are about to SEND it somewhere.
 *
 * Sibling of detectSecretShapedValue (tools.ts), which guards the fact store. That one takes a key for
 * context and errs toward letting writes through, because a false positive there blocks a legitimate
 * memory write. This one guards egress, where the asymmetry runs the opposite way and much harder:
 *
 *   - a false POSITIVE costs one skipped web search — nothing;
 *   - a false NEGATIVE puts a live key into a third-party search engine's query log, which cannot be
 *     undone by any later fix.
 *
 * So this errs heavily toward suppression, needs no key context, and does not care about precision.
 *
 * Why it exists: the curiosity driver turns strings lifted out of the timeline into `webSearch(query)`.
 * A production night shows it proposing `mycox-api-key`, `<你的API密钥>` and a bare UUID as research
 * targets. Those three are placeholders — but the mechanism had NO credential filter at all, and
 * detectSecretShapedValue, built for exactly this class in July, had a single caller on an unrelated path.
 * A detector nothing consults is a detector that does not exist.
 */

/** Vendor prefixes that are unambiguous on sight. */
const KNOWN_PREFIX =
  /^(?:sk-|pk-|rk_|sk_live|sk_test|ghp_|gho_|ghs_|ghu_|github_pat_|xox[bpsare]-|glpat-|AKIA|ASIA|AIza|ya29\.|hf_|npm_|dop_v1_|SG\.|EAAC)/i;

const JWT = /^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}$/;
/** `<service>_<long hex>` — the shape a service-minted key usually takes. */
const SERVICE_KEY = /^[A-Za-z][A-Za-z0-9]{1,24}[_-][A-Fa-f0-9]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A long hex or base64-ish run: no vendor prefix, but nothing else looks like this either. */
const OPAQUE_BLOB = /^(?=.*\d)[A-Za-z0-9+/=_-]{28,}$/;
const LONG_HEX = /^[A-Fa-f0-9]{24,}$/;

/**
 * Names that ANNOUNCE a credential. Searching the name rather than the value still discloses which
 * services the owner holds keys for, and suppressing it costs nothing, so the name is treated the same
 * as the value. Matched as a substring: `mycox-api-key`, `<你的API密钥>`, `openai_token` all qualify.
 */
const CREDENTIAL_NAME =
  /(api[_\- ]?key|apikey|secret|passwd|password|credential|bearer|access[_\- ]?token|refresh[_\- ]?token|private[_\- ]?key|(?:^|[^A-Za-z])tokens?(?:$|[^A-Za-z])|密钥|密码|凭证|口令)/i;

/**
 * True when this string must not leave the process as free text.
 *
 * Deliberately has no allowlist and no length floor beyond what the individual shapes require: every
 * carve-out is a way for a real key to get through, and the thing on the other side of this gate is a
 * search-engine query log.
 */
export function looksLikeCredential(token: string | null | undefined): boolean {
  const t = (token ?? '').trim();
  if (!t) return false;
  if (CREDENTIAL_NAME.test(t)) return true;
  // Multi-word strings are prose; a key does not contain spaces. Checked AFTER the name test, so
  // "your api key" is still caught.
  if (/\s/.test(t)) return false;
  return (
    KNOWN_PREFIX.test(t) || JWT.test(t) || SERVICE_KEY.test(t) || UUID.test(t) || LONG_HEX.test(t) || OPAQUE_BLOB.test(t)
  );
}

/**
 * A form safe to write to a log. The point of suppression is defeated if the value is then printed in
 * full next to the words "suppressed a credential".
 */
export function redactForLog(token: string): string {
  const t = token.trim();
  if (t.length <= 8) return `${t.slice(0, 2)}…(${t.length} chars)`;
  return `${t.slice(0, 4)}…${t.slice(-2)} (${t.length} chars)`;
}
