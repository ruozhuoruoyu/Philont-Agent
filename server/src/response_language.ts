/**
 * Response-language resolution for the open-source i18n split.
 *
 * Context: the codebase and system prompts are being moved to English for open-source
 * readability, but user-facing replies must stay in the user's language — in particular
 * WeChat users expect Chinese. This module decouples *prompt language* (English) from
 * *response language* (per channel / per user), so flipping prompts to English never
 * strands WeChat users.
 *
 * Background (note for WeChat channel maintainers): system prompts and code are migrating to
 * English for open-source readability, but user-facing replies must stay in the user's language —
 * WeChat users in particular expect Chinese. This module decouples "prompt language (English)"
 * from "response language (per channel / per user)", ensuring WeChat users still receive
 * Chinese after the prompts are flipped to English.
 */

/** Human-readable language name fed to the model, e.g. 'Chinese', 'English'. */
export type ResponseLanguage = string;

/** Language names this module can round-trip (produced by observeUserLanguage, parsed by localeToLanguage). */
const KNOWN_LANGUAGES: readonly ResponseLanguage[] = [
  'Chinese', 'English', 'Japanese', 'Korean', 'French', 'German', 'Spanish', 'Russian',
];

/**
 * Per-channel default response language.
 *
 * 2026-07-14: WeChat was pinned to Chinese. That was wrong on the facts — WeChat is international, and a
 * channel is not evidence of a language; the USER is. The pin only ever looked load-bearing because
 * priority 1 below (the user's own locale) was DEAD CODE: no caller ever passed userLocale and nothing
 * ever wrote the `user.locale` fact it named, so the pin was silently doing all the work for everyone.
 *
 * Deliberately left empty rather than deleted: the tier is still the right escape hatch for a channel that
 * genuinely IS single-language. Nothing qualifies today.
 */
const CHANNEL_DEFAULT_LANGUAGE: Readonly<Record<string, ResponseLanguage>> = {};

/** Fallback when neither an explicit user locale nor a channel default applies. */
const MIRROR_USER_LANGUAGE: ResponseLanguage = "the user's own language";

/** Extract the channel id from a sessionId (or pass a bare channel through). */
export function channelOf(sessionIdOrChannel: string | null | undefined): string {
  return (sessionIdOrChannel ?? '').split(':')[0] ?? '';
}

/** Map a BCP-47-ish locale / `user.locale` fact value to a language name the model understands. */
export function localeToLanguage(locale: string | null | undefined): ResponseLanguage | null {
  if (typeof locale !== 'string') return null;
  const l = locale.trim().toLowerCase();
  if (!l) return null;
  // Accept a language NAME as well as a locale code. observeUserLanguage() writes `user.locale` as a name
  // ('Chinese'), while a settings-supplied locale is a code ('zh-CN'). Parsing only codes meant the fact we
  // had just written was silently unparseable and dropped on the floor — the writer and the reader were not
  // speaking the same language, which is the exact defect shape this file exists to fix.
  const byName = KNOWN_LANGUAGES.find((n) => n.toLowerCase() === l);
  if (byName) return byName;
  if (l.startsWith('zh')) return 'Chinese';
  if (l.startsWith('en')) return 'English';
  if (l.startsWith('ja')) return 'Japanese';
  if (l.startsWith('ko')) return 'Korean';
  if (l.startsWith('fr')) return 'French';
  if (l.startsWith('de')) return 'German';
  if (l.startsWith('es')) return 'Spanish';
  if (l.startsWith('ru')) return 'Russian';
  return null; // unknown -> let caller fall back
}

/**
 * The owner's declared language (AGENT_LANGUAGE, set in the web-ui). Empty / unset = auto.
 *
 * A declaration outranks an inference: this is the owner telling us, not us guessing from their script or
 * their choice of messaging app. It is also the only source that is available on a turn with NO user message
 * — which is exactly what a proactive push is, the agent speaking first with nothing to mirror.
 */
export function configuredLanguage(): ResponseLanguage | null {
  return localeToLanguage(process.env.AGENT_LANGUAGE ?? '');
}

/**
 * Resolve the response language. Priority:
 *   1. AGENT_LANGUAGE — the owner DECLARED it in the web-ui. A declaration beats any inference;
 *   2. the user's OBSERVED language (the `user.locale` fact, written by observeUserLanguage);
 *   3. per-channel default (currently empty — a channel is not evidence of a language);
 *   4. mirror the user's own language (works whenever the model can see their text in context).
 *
 * Tiers 1 and 2 are the ones that survive a turn with no user message. Tier 4 cannot: there is nothing to
 * mirror when we speak first.
 */
export function resolveResponseLanguage(opts: {
  channel?: string | null;
  userLocale?: string | null;
}): ResponseLanguage {
  const declared = configuredLanguage();
  if (declared) return declared;
  const fromLocale = localeToLanguage(opts.userLocale);
  if (fromLocale) return fromLocale;
  const ch = channelOf(opts.channel);
  if (ch && CHANNEL_DEFAULT_LANGUAGE[ch]) return CHANNEL_DEFAULT_LANGUAGE[ch];
  return MIRROR_USER_LANGUAGE;
}

/**
 * The language for CODE-AUTHORED template strings (push cards, status phrases) — the half of the output a
 * prompt directive can do nothing about, because no LLM is involved: they are literals in the source.
 *
 * Derived from the SAME resolution as the model's directive, so a push card and the reply that follows it
 * can never disagree. We ship two template languages, so anything not Chinese renders in English — that is
 * a real ceiling, not a claim of full i18n: an observed Japanese user gets English cards today.
 */
export function resolvePhraseLang(opts: {
  channel?: string | null;
  userLocale?: string | null;
}): 'zh' | 'en' {
  return resolveResponseLanguage(opts) === 'Chinese' ? 'zh' : 'en';
}

/**
 * Build the system-prompt directive that controls the user-facing reply language.
 * Appended to the (English) system prompt so the model writes the "## For User" section
 * in the resolved language while internal sections may stay English.
 */
export function buildLanguageDirective(language: ResponseLanguage): string {
  return (
    `\n\n**Response language**: Write the user-facing reply (the "## For User" section) in ${language}. ` +
    `If the user clearly writes in a different language, mirror their language instead. ` +
    `Internal sections (work log, tool traces) may stay in English.`
  );
}


/**
 * Observe the user's language from what they actually wrote, so it can be persisted (`user.locale`) and
 * used on turns that have no user message at all — a proactive push is the agent speaking FIRST, so there
 * is nothing to mirror. This is the tier that lets us stop guessing a language from the channel.
 *
 * Script-decisive only, and deliberately so. Han/Kana/Hangul/Cyrillic identify a language; the Latin
 * alphabet does not (English, French, Spanish and German share it), so for Latin text this returns null
 * and the caller falls through to mirroring — which is correct, because the model can read their words.
 * Guessing "English" from Latin script would be exactly the kind of confident wrong answer we keep fixing.
 *
 * Requires a real signal: a bare "ok" / "查" is too short to re-decide a user's language on, and a pasted
 * English stack trace must not flip a Japanese user to English. Only a decisive majority re-decides.
 */
export function observeUserLanguage(text: string | null | undefined): ResponseLanguage | null {
  const t = (text ?? '').trim();
  if (t.length < 4) return null; // too little to conclude anything

  let han = 0, kana = 0, hangul = 0, cyrillic = 0, latin = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x3040 && c <= 0x30ff) kana++;               // hiragana + katakana
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;        // hangul syllables
    else if (c >= 0x4e00 && c <= 0x9fff) han++;           // CJK ideographs
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic++;      // cyrillic
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  const scripted = han + kana + hangul + cyrillic + latin;
  if (scripted < 4) return null; // URLs, code, digits, emoji — no linguistic signal

  // ABSOLUTE count, not a ratio against Latin. A ratio gets this backwards on the single most common real
  // message there is: "这个报错是什么意思 TypeError: undefined is not a function" is 8 Han among ~35 Latin,
  // and a 30% bar reads it as undecidable. But the Latin there is a PASTED ARTIFACT — the user's own words
  // are the Han ones. Writing in a non-Latin script is strong evidence on its own; nobody types four Han
  // characters by accident, whereas anyone may paste an English stack trace.
  //
  // Kana is checked first and is decisive for Japanese (Japanese always carries kana alongside kanji, so
  // this must not be mistaken for Chinese).
  if (kana >= 2) return 'Japanese';
  if (hangul >= 3) return 'Korean';
  if (han >= 3) return 'Chinese';
  if (cyrillic >= 4) return 'Russian';
  return null; // Latin script → cannot be decided by script; let the mirror directive handle it
}
