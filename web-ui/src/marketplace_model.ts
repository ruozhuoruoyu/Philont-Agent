export interface InstalledSkillSource {
  source: string | null;
  provenance: unknown | null;
}

/**
 * Marketplace provenance is advisory metadata, not the only record that a skill was downloaded.
 * SkillStore persists the canonical source tag separately, so a missing or malformed lock file must
 * not move a downloaded skill into the "self-learned" section.
 */
export function isDownloadedSkill(skill: InstalledSkillSource): boolean {
  if (skill.provenance) return true;
  return typeof skill.source === 'string' && /^(github:|clawhub:|url:)/.test(skill.source);
}
