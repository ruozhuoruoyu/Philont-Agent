/**
 * Skill marketplace registry — barrel.
 *
 * Aggregator client over external skill sources (git/url + clawhub in v1) with a content safety scan
 * + trust×verdict install gate. No hosted backend. See ./types.ts for the design overview.
 */

export type {
  TrustLevel,
  Verdict,
  GateDecision,
  InstallActor,
  SkillMeta,
  SkillBundle,
  CompanionFile,
  SkillSource,
  ScanHit,
  ScanReport,
  NotInstalledReport,
  ProvenanceRecord,
  InstallOutcome,
  UpdateStatus,
} from './types.js';

export { scanSkillContent, scanSkillBundle } from './scanner.js';
export { applyBundleBudget, isInstallableCompanion, MAX_BUNDLE_FILES, MAX_BUNDLE_BYTES } from './bundle.js';
export { gateDecision } from './gate.js';
export { readLock, getProvenance, upsertLock, removeLock, appendAudit } from './lockStore.js';
export { SOURCES, searchAll, resolveSource, fetchFrom, inspectFrom } from './router.js';
export type { SearchResult } from './router.js';
export { installFromSource, inspectBundle } from './install.js';
export type { InstallRequest } from './install.js';
export { checkForUpdates, updateSkill } from './update.js';
