/**
 * Skill loader
 */

export { parseSkillFile, loadSkills, watchSkillDir, MAX_ACTION_TEMPLATE_SIZE } from './loader.js';
export type { ParsedSkill } from './loader.js';
export { installSkillTool, uninstallSkillTool } from './installTool.js';
export { searchSkillsTool, installSkillFromRegistryTool } from './registryTools.js';
// Skill marketplace registry (aggregator client + safety gate)
export * from './registry/index.js';
