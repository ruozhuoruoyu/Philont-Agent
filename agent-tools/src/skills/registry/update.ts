/**
 * Update checking: compare each installed (marketplace-sourced) skill's stored content hash against
 * the latest from its source. `updateSkill` re-runs the full install pipeline (re-scan, re-gate) for one skill.
 */

import { fetchFrom } from './router.js';
import { installFromSource } from './install.js';
import { readLock } from './lockStore.js';
import type { InstallOutcome, UpdateStatus } from './types.js';

/** Check all marketplace-installed skills for available updates. */
export async function checkForUpdates(): Promise<UpdateStatus[]> {
  const lock = readLock();
  const out: UpdateStatus[] = [];
  for (const rec of Object.values(lock)) {
    let latestHash: string | null = null;
    let latestVersion: string | undefined;
    // Compare bundle hashes when both sides have one: a companion script can change while the
    // SKILL.md text stays byte-identical, and that is still a new version of the skill.
    const current = rec.bundleHash ?? rec.contentHash;
    try {
      const bundle = await fetchFrom(rec.sourceId, rec.identifier);
      latestHash = rec.bundleHash && bundle.bundleHash ? bundle.bundleHash : bundle.contentHash;
      latestVersion = bundle.meta.version;
    } catch {
      latestHash = null;
    }
    out.push({
      name: rec.name,
      sourceTag: rec.sourceTag,
      currentHash: current,
      latestHash,
      latestVersion,
      changed: latestHash != null && latestHash !== current,
    });
  }
  return out;
}

/** Re-install one skill from its recorded source (re-scans + re-gates). */
export async function updateSkill(
  name: string,
  opts?: { confirm?: boolean; actor?: 'user' | 'agent'; now?: string },
): Promise<InstallOutcome> {
  const rec = readLock()[name];
  if (!rec) return { status: 'error', name, error: `no provenance for '${name}' (not marketplace-installed)` };
  return installFromSource({
    sourceId: rec.sourceId,
    identifier: rec.identifier,
    name: rec.name,
    confirm: opts?.confirm,
    actor: opts?.actor,
    now: opts?.now,
  });
}
