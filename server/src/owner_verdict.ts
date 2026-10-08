/**
 * Owner verdict capture (2026-10-08) — the acceptance loop's third layer, for work that has no mechanical
 * oracle: advice, writing, plans, research syntheses. The owner's next message IS the acceptance check.
 * Until now "不对 / 重来" was processed as a new task and nothing recorded that the previous reply failed;
 * recording it closes three gaps at once — the loop for unverifiable work, the truth column the learning
 * judge's calibration never had (judge said success, owner said no), and the honesty gate's unmeasured
 * false-positive / false-negative rate.
 *
 * Detection follows the house rule for reading the owner's words: a deterministic FLOOR of unmistakable
 * phrases decides the easy cases on its own (a whole-message "好的" is acceptance; nothing is inferred
 * from it), and the aux model is consulted only to CONFIRM a rejection candidate against the previous
 * reply — it is asked what the message is, never asked to grade the reply. Every failure path is
 * `none`: an absent or erroring aux costs nothing and records nothing.
 */

export type OwnerVerdict = 'accepted' | 'rejected' | 'none';

export const OWNER_VERDICT_MAX_CHARS = 80;
/** The previous reply must be this recent for a short message to be read as a verdict on it. */
export const OWNER_VERDICT_WINDOW_MS = 2 * 60 * 60_000;

const ACCEPT_WHOLE_RE =
  /^(?:对|对的|好|好的|可以|行|没问题|不错|很好|谢谢|多谢|收到|明白|了解|ok|okay|good|great|nice|thanks|thank you|perfect|correct|yes|right|fine)[!！。.~～\s]*$/i;

const REJECT_CUE_RE =
  /不对|不是这个|不是我要|不是这样|错了|有错|搞错|重来|重做|重新来|没用|没有用|不行|还是不行|不对啊|失败了|没成功|不可以|不正确|不准确|\bwrong\b|\bincorrect\b|not (?:what|right|correct|working)|doesn'?t work|didn'?t work|\bfailed\b|\bnope\b|\bbroken\b|try again|redo\b/i;

export function verdictFloor(message: string): 'accept' | 'reject-candidate' | 'none' {
  const m = (message ?? '').trim();
  if (!m || m.length > OWNER_VERDICT_MAX_CHARS) return 'none';
  if (ACCEPT_WHOLE_RE.test(m)) return 'accept';
  if (REJECT_CUE_RE.test(m)) return 'reject-candidate';
  return 'none';
}

export function buildVerdictPrompt(message: string, previousReply: string): { system: string; user: string } {
  return {
    system:
      'You classify what a short message from a user IS, relative to the assistant reply it follows. Reply with exactly one word: ' +
      'rejected (the user says the previous reply was wrong, unwanted, or did not work), accepted (the user approves it), or neither ' +
      '(a new request, a question, an approval of a pending action, or anything else). Never judge whether the reply was good.',
    user: ['Previous assistant reply (excerpt):', previousReply.slice(0, 1200) || '(empty)', '', 'User message:', message.slice(0, 300), '', 'One word:'].join('\n'),
  };
}

export function parseVerdict(raw: string | null | undefined): OwnerVerdict {
  const t = (raw ?? '').trim().toLowerCase();
  if (/^rejected\b/.test(t)) return 'rejected';
  if (/^accepted\b/.test(t)) return 'accepted';
  return 'none';
}

export interface DetectVerdictInput {
  message: string;
  previousReply: string;
  ask?: (req: { system: string; user: string; maxTokens: number }) => Promise<string | null>;
}

/** Floor first; the aux model only to confirm a rejection candidate. Never throws. */
export async function detectOwnerVerdict(input: DetectVerdictInput): Promise<{ verdict: OwnerVerdict; basis: 'floor' | 'llm' | 'none' }> {
  const floor = verdictFloor(input.message);
  if (floor === 'accept') return { verdict: 'accepted', basis: 'floor' };
  if (floor !== 'reject-candidate' || !input.ask) return { verdict: 'none', basis: 'none' };
  try {
    const { system, user } = buildVerdictPrompt(input.message, input.previousReply);
    const verdict = parseVerdict(await input.ask({ system, user, maxTokens: 8 }));
    return verdict === 'none' ? { verdict: 'none', basis: 'none' } : { verdict, basis: 'llm' };
  } catch {
    return { verdict: 'none', basis: 'none' };
  }
}

/** The one-line directive for the turn that follows a rejection. */
export function renderRejectionDirective(message: string): string {
  return (
    `[owner-verdict] The owner rejected the previous reply ("${message.trim().slice(0, 80)}"). Treat this turn as a REPAIR of that reply: ` +
    'identify what was wrong or missing, fix that specifically, verify it, and report the verified state. Do not start over from scratch and do not defend the previous answer.'
  );
}
