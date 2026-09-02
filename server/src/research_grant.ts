/**
 * research_grant — pure logic for connecting background research "permission requests" to
 * WeChat (independently testable; does not load chat-handler).
 *
 * When background research encounters a gated tool → executor returns needsGrant → chat-handler:
 *   (1) Reconstructs a stable sessionId from the subscribed WeChat DM user, registers a
 *       PendingResearchGrant;
 *   (2) pushDispatcher sends an authorization card (renderResearchGrantPrompt).
 * User replies "agree/deny" in WeChat → decideResearchGrantAction produces a deterministic
 * decision; chat-handler writes grant / cancels request / passes through accordingly.
 *
 * This module contains only pure functions + types; side effects (grant / setQuestionPendingTool
 * / push) remain in chat-handler.
 */

/** Idle-time pending grant (keyed by sessionId; same structure as turn-local pendingAuth but without tool-chain resume). */
export interface PendingResearchGrant {
  pursuitId: string;
  questionId: string;
  tool: string;
  why: string;
  /** The addressable identity of the card shown for this request. See pending_decisions.ts. */
  decisionId?: string;
  /** Registration timestamp (epoch ms), used for TTL expiry */
  ts: number;
}

/**
 * Render the authorization card (aligned with the existing 🔐 auth request style).
 *
 * A code-authored template — no LLM is involved, so no prompt directive can affect it. It used to be
 * hardcoded Chinese, which meant an English-speaking owner got a Chinese card AND was told to reply with a
 * Chinese word. The language comes from resolvePhraseLang (AGENT_LANGUAGE → observed → mirror), the same
 * resolution the model's own directive uses, so the card and the reply after it cannot disagree.
 */
export function renderResearchGrantPrompt(
  title: string,
  tool: string,
  why: string,
  ttlMs: number,
  lang: 'zh' | 'en' = 'zh',
): string {
  const mins = Math.round(ttlMs / 60000);
  if (lang === 'en') {
    return [
      '🔐 Background research needs your approval',
      `Researching "${title}" cannot continue without \`${tool}\`${why ? ` (${why})` : ''}.`,
      `Permission: execute/system · valid for about ${mins} minutes`,
      'Reply "approve" to allow / "reject" to decline.',
    ].join('\n');
  }
  return [
    '🔐 后台研究请求授权',
    `研究「${title}」需要用 \`${tool}\` 才能继续${why ? `(${why})` : ''}。`,
    `权限:execute/system · 约 ${mins} 分钟内有效`,
    '回复「同意」批准 / 「拒绝」拒绝。',
  ].join('\n');
}

/**
 * Deterministic match on the words THE CARD ITSELF OFFERED — in BOTH languages, always, regardless of which
 * language the card was rendered in.
 *
 * This is not defensive padding, it is the whole point. The moment we hand the user a closed enum ("reply
 * approve / reject"), their reply is no longer open natural language — it is us reading back our own
 * vocabulary, and it must be matched exactly, not shipped to a semantic classifier. We have already been
 * bitten by precisely this: a user replied with one of OUR OWN offered words and the general-purpose intent
 * classifier read it as the opposite. Widening a classifier's jurisdiction promotes its false positives from
 * harmless to harmful.
 *
 * Both vocabularies are always accepted because the rendered language does not constrain the human: a
 * bilingual owner will type 同意 at an English card, and being strict there would punish them for a setting.
 * Anything NOT in our enum falls through to the classifier, where open language belongs.
 */
export function classifyGrantReply(reply: string): 'grant' | 'deny' | null {
  const r = (reply ?? '').trim().toLowerCase().replace(/[。！？，,!?.\s"'「」]+/g, '');
  if (!r) return null;
  if (/^(同意|批准|授权|允许|可以|好|approve|approved|allow|grant|granted|yes|ok|okay)$/.test(r)) return 'grant';
  if (/^(拒绝|不同意|不批准|不允许|不要|不|别|reject|rejected|deny|denied|decline|no|nope)$/.test(r)) return 'deny';
  return null; // open language → the semantic classifier
}

/**
 * Reconstruct a stable DM sessionId from a push subscription item (channel + peer).
 *
 * Aligned with each channel's makeSessionId: DM = `<platform>:<accountId>:<userId>`;
 * subscription channel=`<platform>:<accountId>`, peer=userId → sessionId = `${channel}:${peer}`.
 * Supports wechat / telegram — both have the same DM sessionId convention (`${channel}:${peer}`),
 * so "proactive permission requests" registered here work for both channels.
 * Group subscriptions (peer starts with `group:`; "approve" ownership is ambiguous) or unknown
 * channels → return null; not included in routing.
 */
export function reconstructDmSessionId(channel: string, peer: string): string | null {
  if (peer.startsWith('group:')) return null;
  if (channel.startsWith('wechat:') || channel.startsWith('telegram:')) {
    return `${channel}:${peer}`;
  }
  return null;
}

/** A single (tool, capability, domain) grant to apply. */
export interface WorkflowGrant {
  tool: string;
  capability: 'write' | 'execute';
  domain: 'local' | 'network';
}

/**
 * The full set of LOCAL research-workflow tools. A math-research push is a write→run→write→run loop:
 * writeFile a .gp/.py script → shell/pariGp run it → patch/writeFile fix it → run again. Under the old
 * per-capability sibling grant, approving a `write` tool granted only the other `write` tools, so the
 * first `shell`/`pariGp` still bounced a fresh auth card — and vice versa. Every research loop needs BOTH
 * write and execute, so the user paid (at least) one "ok" per capability AND per tool not in the list
 * (pariGp/z3Verify were missing entirely). This unified set lets ONE approval of any member cover the
 * whole local loop for WORKFLOW_GRANT_TTL_MS.
 *
 * downloadFile (write/network) IS included since 2026-07-07: `shell` in this same set can fetch any
 * URL anyway (curl/python), so a per-call confirmation on downloadFile bought no security — only
 * consent fatigue (prod: ~12 "ok"s for one PPT task, mostly re-approving downloads). The set is
 * only granted after the user approves one of its members, for WORKFLOW_GRANT_TTL_MS.
 *
 * Deliberately excluded (stay per-call): deleteFile (destructive) and any external/untrusted
 * execution (domain≠local).
 */
export const LOCAL_RESEARCH_WORKFLOW: WorkflowGrant[] = [
  { tool: 'writeFile', capability: 'write', domain: 'local' },
  { tool: 'patch', capability: 'write', domain: 'local' },
  { tool: 'moveFile', capability: 'write', domain: 'local' },
  { tool: 'shell', capability: 'execute', domain: 'local' },
  // process (spawn/status/kill) is the same execute×local capability as shell — same commandAllowlist
  // validation, same risk profile. Excluding it meant every `process spawn` (long-running python/z3)
  // forced a separate auth_pending even after the user approved shell — half the auth interrupts in
  // a research session were this one gap (prod 2026-08-05 LRC overnight).
  { tool: 'process', capability: 'execute', domain: 'local' },
  { tool: 'pariGp', capability: 'execute', domain: 'local' },
  { tool: 'z3Verify', capability: 'execute', domain: 'local' },
  { tool: 'leanCheck', capability: 'execute', domain: 'local' },
  { tool: 'downloadFile', capability: 'write', domain: 'network' },
];

/**
 * Given the tool the user just approved, return the sibling local-workflow grants to apply alongside it
 * (the whole local set minus the approved tool itself, which the caller grants separately with its own
 * TTL). Returns [] when the approval is NOT a local write/execute action — network downloads, destructive
 * deletes, and external/untrusted execution are never batched and keep their per-call confirmation.
 */
export function localWorkflowGrants(
  approvedCapability: string,
  approvedDomain: string,
  approvedTool: string,
): WorkflowGrant[] {
  // Entry: a local write/execute approval, or approving downloadFile itself (an artifact loop that
  // STARTS with a download continues with write/run — same workflow, same one-approval contract), or
  // approving deep_explore.
  //
  // deep_explore is classified execute×SELF, so it fell outside `domain === 'local'` in both
  // directions and neither approval covered the other. Prod 2026-09-02 06:50: the owner approved
  // deep_explore, the round it authorised then hit `blocked pariGp — denied by permission matrix`,
  // reasoned from memory instead, and recorded `no_commit`. Ten minutes later they paid a second "ok"
  // for the same workflow. A reasoning round's whole job is write a probe → run it → record what came
  // back; approving the engine and withholding its hands buys a dark round, not safety.
  //
  // Deliberately one-directional in the widening sense: this adds deep_explore as an ENTRY, and
  // deep_explore is not added to LOCAL_RESEARCH_WORKFLOW, so approving a plain writeFile still does
  // not start the reasoning engine.
  const isLocalWorkflow =
    approvedDomain === 'local' &&
    (approvedCapability === 'write' || approvedCapability === 'execute');
  const isDownload = approvedTool === 'downloadFile';
  const isDeepExplore = approvedTool === 'deep_explore';
  if (!isLocalWorkflow && !isDownload && !isDeepExplore) return [];
  return LOCAL_RESEARCH_WORKFLOW.filter((g) => g.tool !== approvedTool);
}

export type ResearchGrantAction = 'grant' | 'deny' | 'expired' | 'passthrough';

/**
 * User reply → deterministic decision.
 *   - No pending          → passthrough (let normal turn flow handle it)
 *   - Pending past TTL    → expired (pass through and clear the stale pending)
 *   - intent=grant        → grant
 *   - intent=deny         → deny
 *   - intent=unclear      → passthrough (do not consume; let LLM handle the pending section)
 */
export function decideResearchGrantAction(
  pending: PendingResearchGrant | undefined,
  intent: 'grant' | 'deny' | 'unclear',
  now: number,
  ttlMs: number,
): ResearchGrantAction {
  if (!pending) return 'passthrough';
  if (now - pending.ts > ttlMs) return 'expired';
  if (intent === 'grant') return 'grant';
  if (intent === 'deny') return 'deny';
  return 'passthrough';
}
