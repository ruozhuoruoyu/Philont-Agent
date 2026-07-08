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
  /** Registration timestamp (epoch ms), used for TTL expiry */
  ts: number;
}

/** Render the WeChat authorization card text (aligned with the existing 🔐 auth request style). */
export function renderResearchGrantPrompt(
  title: string,
  tool: string,
  why: string,
  ttlMs: number,
): string {
  return [
    '🔐 后台研究请求授权',
    `研究「${title}」需要用 \`${tool}\` 才能继续${why ? `(${why})` : ''}。`,
    `权限:execute/system · 约 ${Math.round(ttlMs / 60000)} 分钟内有效`,
    '回复「同意」批准 / 「拒绝」拒绝。',
  ].join('\n');
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
  { tool: 'pariGp', capability: 'execute', domain: 'local' },
  { tool: 'z3Verify', capability: 'execute', domain: 'local' },
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
  // STARTS with a download continues with write/run — same workflow, same one-approval contract).
  const isLocalWorkflow =
    approvedDomain === 'local' &&
    (approvedCapability === 'write' || approvedCapability === 'execute');
  const isDownload = approvedTool === 'downloadFile';
  if (!isLocalWorkflow && !isDownload) return [];
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
