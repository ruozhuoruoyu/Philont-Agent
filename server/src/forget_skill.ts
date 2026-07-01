/**
 * forget_skill — pure selection logic for deleting SELF-LEARNED (DB-only) skills.
 *
 * Split out from chat-handler so the matching + file-backed protection can be unit-tested
 * without the memory singleton or the filesystem. The chat-handler tool wires this pure
 * selector to `memory.skills.listAll()` + the on-disk skill-name set (same loader the
 * reload-prune uses) and then calls `deleteSkill` on each result.
 *
 * Why a separate "self-learned" delete path exists at all: reflection/plan-distilled skills
 * live DB-only (no SKILL.md), so `uninstallSkill` (which removes a directory) cannot reach
 * them. Without this, a "delete the X skills" request left them behind.
 */

export interface ForgettableSkill {
  name: string;
  description: string;
  triggerKeywords?: string[];
  /** Times the skill has been used. Enables the "delete unused / low-use skills" criterion. */
  useCount?: number;
}

export interface ForgetSkillQuery {
  /** Exact skill name to delete. A single target — wins over the other filters. */
  name?: string;
  /** Case-insensitive substring matched across name / description / trigger keywords. */
  contains?: string;
  /**
   * Delete every self-learned skill whose useCount is ≤ this (0 = never used). This is the criterion mode
   * that "删除使用次数为0的技能" needs — without it the model has to enumerate + fire one delete per skill
   * (prod: 26 forget_skill calls, 7 of them failing on file-backed skills). Combines with `contains` (AND).
   */
  maxUseCount?: number;
}

/**
 * Select which skills a forget_skill call should delete.
 *
 *  - `onDiskNames`: names of file-backed skills (bundled / installed via installSkill). These are
 *    NEVER selected — they belong to uninstallSkill, and deleting only their DB row would be undone
 *    by the next reload (importSkills re-creates rows from disk). `source` is NOT a reliable
 *    "DB-only" signal (a bundled SKILL.md with no `source:` frontmatter lands as source=NULL), so the
 *    guard is actual disk presence.
 *  - `name` (exact) is a single-target delete and ignores the other filters.
 *  - `contains` and `maxUseCount` combine as AND when both are given.
 *  - With none of name / contains / maxUseCount set, selects nothing (caller should reject the call).
 *
 * Returns the matching skills (empty if none).
 */
export function selectSkillsToForget<T extends ForgettableSkill>(
  all: readonly T[],
  onDiskNames: ReadonlySet<string>,
  query: ForgetSkillQuery,
): T[] {
  const name = (query.name ?? '').trim();
  const contains = (query.contains ?? '').trim().toLowerCase();
  const hasMaxUse = typeof query.maxUseCount === 'number' && Number.isFinite(query.maxUseCount);
  if (!name && !contains && !hasMaxUse) return [];
  return all.filter((s) => {
    if (onDiskNames.has(s.name)) return false; // file-backed → protected (uninstallSkill's domain)
    if (name) return s.name === name; // exact single target
    if (contains) {
      const hay = `${s.name} ${s.description} ${(s.triggerKeywords ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(contains)) return false;
    }
    if (hasMaxUse && (s.useCount ?? 0) > (query.maxUseCount as number)) return false;
    return true;
  });
}
