/**
 * Authorization-reply intent classification (2026-07-14).
 *
 * ## What was wrong
 *
 * `chat-handler` picked its classifier by provider:
 *
 *     const intentClassifier = process.env.LLM_PROVIDER === 'anthropic'
 *       ? new LLMIntentClassifier(...)
 *       : new KeywordIntentClassifier();
 *
 * The owner runs DeepSeek. So in production every authorization decision — the gate in front of
 * execute/system tools — was made by KeywordIntentClassifier, which substring-matches a bag of Chinese and
 * English words. Its CJK branch checks deny words, then grants on any of 允许|同意|授权|可以|没问题|确认.
 * Measured, not supposed:
 *
 *     "我可以再想想吗"       → grant     (Can I think about it a bit longer?)
 *     "这个工具可以干什么？"   → grant     (What does this tool even do?)
 *     "你确认一下这是安全的吗" → grant     (Can you confirm this is safe?)
 *
 * Three QUESTIONS about the request, each of which authorised the tool. Asking for time, asking what the
 * thing does, and asking whether it is safe are the three most natural things a cautious owner says at an
 * auth prompt — and all three were read as consent. An enumeration of keywords cannot represent negation,
 * interrogation, or hedging, so it fails in the direction of ACTING.
 *
 * ## The shape of the fix
 *
 * Two layers, and the distinction between them is the whole point:
 *
 *   1. EXACT match on the words WE OFFERED ("回复「同意」/「拒绝」" · "reply approve / reject"). This is not
 *      intent inference — it is reading back our own closed enum, and it must be deterministic. Handing our
 *      own vocabulary to a semantic classifier has already produced a bug (the owner replied with one of our
 *      own DENY words and it was read as consent).
 *   2. Everything else is OPEN natural language → the aux LLM. Regexes must not adjudicate open intent; an
 *      enumeration always loses to unbounded paraphrase.
 *
 * And the safety property that was missing entirely: **uncertainty must never grant**. If the aux model is
 * unconfigured, errors, times out, or returns anything unexpected, the answer is `unclear` — which leaves the
 * pending auth open and re-asks. Asking again is free. Authorising by accident is not.
 */

import { callAuxLLM, isAuxLLMConfigured } from '@agent/tools';

export type GrantIntent = 'grant' | 'deny' | 'unclear';

/**
 * Layer 1 — the closed enum WE handed the owner on the auth card, in both languages, always.
 *
 * Deliberately anchored (^…$) and short: this reads back a word we printed, it does not interpret a
 * sentence. "我可以再想想吗" is a sentence and must fall through to layer 2, where it belongs.
 */
export function matchOfferedAuthWord(reply: string): GrantIntent | null {
  const r = (reply ?? '').trim().toLowerCase().replace(/[。！？，,!?.\s"'「」]+/g, '');
  if (!r) return null;
  if (/^(同意|批准|授权|允许|approve|approved|allow|grant|granted)$/.test(r)) return 'grant';
  if (/^(拒绝|不同意|不允许|不要|别|reject|rejected|deny|denied|decline)$/.test(r)) return 'deny';
  return null;
}

const SYSTEM = [
  'You classify a user\'s reply to an AUTHORIZATION prompt from an AI agent.',
  'The agent asked permission to run a tool. The user has replied. Decide what the user MEANT.',
  '',
  'Answer with exactly one word:',
  '  grant   — the user clearly permits the agent to proceed NOW',
  '  deny    — the user clearly refuses, or wants it stopped/postponed',
  '  unclear — anything else',
  '',
  'CRITICAL: a QUESTION is not consent. "Can I think about it?", "What does this tool do?",',
  '"Are you sure this is safe?", "Why do you need that?" are NOT grants — they are unclear (the user is',
  'still deciding, and answering their question is the correct next move, not running the tool).',
  'Hedging ("maybe later", "hold on") is deny or unclear, never grant.',
  'When in doubt, answer unclear. Re-asking costs nothing; authorizing by mistake is not recoverable.',
].join('\n');

/**
 * Classify an authorization reply. Fails CLOSED: anything we are not sure about is `unclear`, which leaves
 * the pending authorization open and asks again.
 */
export async function classifyAuthIntent(
  userReply: string,
  context: string,
  deps: { call?: (req: { system: string; user: string; maxTokens: number }) => Promise<string> } = {},
): Promise<GrantIntent> {
  const offered = matchOfferedAuthWord(userReply);
  if (offered) return offered;

  const call = deps.call ?? callAuxLLM;
  if (!deps.call && !isAuxLLMConfigured()) {
    // No aux model configured. We do NOT fall back to keyword matching — that is the defect this module
    // exists to remove, and a silent downgrade to it would be worse than an honest re-ask.
    console.warn('[auth-intent] aux LLM not configured — cannot read open-language replies; re-asking');
    return 'unclear';
  }

  try {
    const raw = await call({ system: SYSTEM, user: `Tool requested: ${context}\nUser reply: ${userReply}`, maxTokens: 8 });
    const v = (raw ?? '').trim().toLowerCase();
    if (v.startsWith('grant')) return 'grant';
    if (v.startsWith('deny')) return 'deny';
    return 'unclear';
  } catch (e) {
    console.warn('[auth-intent] aux LLM failed — treating as unclear (never grant on error)', e);
    return 'unclear';
  }
}
