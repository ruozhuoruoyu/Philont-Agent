/**
 * Cleanup-turn scoping (2026-07-06) — two guards that make "清除 X" mean ONLY "清除 X".
 *
 * Field evidence (three runs in a row): while the user was clearing mycox,
 *   (a) the cleanup turn itself drifted into DOMAIN operations — fetched the guide and POSTed
 *       register (409, burned an invite) because old mycox routines sat in the conversation
 *       context; a cleanup turn only ever needs LOCAL tools (forget_skill / cancel_schedule /
 *       deleteCredential / forgetFact / deleteFile);
 *   (b) the project's scheduled check-in fired MID-CLEAR, found half-deleted state, and started
 *       resurrecting it (re-register with a stale invite, re-capture credentials the user had
 *       just deleted).
 *
 * Guard 1 (cleanupHttpWriteReject): during a cleanup-intent turn, external write http
 * (POST/PUT/PATCH/DELETE) is mechanism-layer rejected with a corrective message. GET stays
 * allowed (harmless, and "check then delete" flows may legitimately read).
 *
 * Guard 2 (matchesCleanupTarget + extractCleanupTargets): at cleanup-turn start, schedules whose
 * name/project/payload mention the cleanup target are soft-paused for a short window so they
 * cannot race the deletion. Pure functions here; the pause itself is wired in chat-handler.
 */

import type { Schedule } from '@agent/memory';

/** Generic words that appear in cleanup phrasing but never name a project/service. */
const TARGET_STOPWORDS = new Set([
  'all', 'and', 'the', 'related', 'relevant', 'every', 'everything', 'please',
  'memory', 'memories', 'skill', 'skills', 'schedule', 'schedules', 'scheduled',
  'reminder', 'reminders', 'credential', 'credentials', 'secret', 'secrets',
  'fact', 'facts', 'note', 'notes', 'task', 'tasks', 'cron', 'plan', 'plans',
  'delete', 'clear', 'cancel', 'stop', 'remove', 'forget', 'disable', 'uninstall',
  'purge', 'wipe',
]);

/**
 * Extract the specific target token(s) a cleanup command names ("清除mycox相关记忆和技能" → ["mycox"]).
 * ASCII word tokens only — CJK cleanup vocabulary (记忆/技能/定时…) never names a service, while
 * project/service names in this codebase are ASCII identifiers. Empty result = untargeted cleanup
 * ("清除所有定时") — schedule pausing then does nothing (cancel_schedule handles the explicit ask).
 */
export function extractCleanupTargets(userMessage: string): string[] {
  const tokens = (userMessage ?? '').match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (TARGET_STOPWORDS.has(lower)) continue;
    if (!out.includes(lower)) out.push(lower);
  }
  return out.slice(0, 4);
}

/** True when a schedule's name / project / payload mentions any cleanup target. */
export function matchesCleanupTarget(s: Schedule, targets: readonly string[]): boolean {
  if (targets.length === 0) return false;
  const hay = `${s.name} ${s.project ?? ''} ${JSON.stringify(s.payload ?? '')}`.toLowerCase();
  return targets.some((t) => hay.includes(t));
}

/**
 * Mechanism-layer reject for external write http during a cleanup-intent turn.
 * Returns a corrective message (do NOT execute) or null (let it run).
 */
export function cleanupHttpWriteReject(
  toolName: string,
  input: Record<string, unknown>,
): { error: string } | null {
  if (toolName !== 'http') return null;
  const method = String(input.method ?? 'GET').toUpperCase();
  if (!/^(POST|PUT|PATCH|DELETE)$/.test(method)) return null;
  return {
    error:
      `[cleanup-scope blocked] This turn is a cleanup command — it operates on LOCAL state only ` +
      `(forget_skill / cancel_schedule / deleteCredential / forgetFact / deleteFile). ` +
      `External ${method} calls (register / post / vote / remote writes) are disabled for this turn: ` +
      `a cleanup must never re-register or write to the service being cleaned. ` +
      `If the user wants a remote action, they will ask in a separate message.`,
  };
}
