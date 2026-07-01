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
}

export interface ForgetSkillQuery {
  /** Exact skill name to delete. Wins over `contains` when both are present. */
  name?: string;
  /** Case-insensitive substring matched across name / description / trigger keywords. */
  contains?: string;
}

/**
 * Select which skills a forget_skill call should delete.
 *
 *  - `onDiskNames`: names of file-backed skills (bundled / installed via installSkill). These are
 *    NEVER selected — they belong to uninstallSkill, and deleting only their DB row would be undone
 *    by the next reload (importSkills re-creates rows from disk). `source` is NOT a reliable
 *    "DB-only" signal (a bundled SKILL.md with no `source:` frontmatter lands as source=NULL), so the
 *    guard is actual disk presence.
 *  - With no `name` and no `contains`, selects nothing (caller should reject the call).
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
  if (!name && !contains) return [];
  return all.filter((s) => {
    if (onDiskNames.has(s.name)) return false; // file-backed → protected (uninstallSkill's domain)
    if (name) return s.name === name;
    const hay = `${s.name} ${s.description} ${(s.triggerKeywords ?? []).join(' ')}`.toLowerCase();
    return hay.includes(contains);
  });
}
