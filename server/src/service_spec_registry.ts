/**
 * Service-spec registry (spec_regime.md) — installed service skills carry a machine-readable
 * `spec.json` next to their SKILL.md. This registry indexes them BY HOST so mechanism guards can
 * consult the compiled contract on ANY turn — the plan-loop already guards its own steps, but
 * scheduled/legacy turns talked to the same services unguarded (prod: the check-in routine PUT a
 * `{content:string}` body at the memories endpoint every fire → server 500; the documented shape
 * was {contextActorId, value, memory_type, importance}).
 *
 * Cheap by construction: one directory scan per TTL window, then Map lookups. Scan failures are
 * silent (registry is best-effort; guards simply don't fire).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SpecDoc } from './spec_compile.js';

const SCAN_TTL_MS = 60_000;

interface Installed {
  spec: SpecDoc;
  dir: string;
}

interface RegistryState {
  scannedAt: number;
  byHost: Map<string, Installed>;
}

const states = new Map<string, RegistryState>(); // keyed by skillsRoot

function scan(skillsRoot: string): RegistryState {
  const byHost = new Map<string, Installed>();
  try {
    for (const dir of readdirSync(skillsRoot)) {
      const specPath = join(skillsRoot, dir, 'spec.json');
      try {
        if (!statSync(specPath).isFile()) continue;
        const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SpecDoc;
        if (!Array.isArray(spec?.endpoints) || !Array.isArray(spec?.service?.hosts)) continue;
        for (const h of spec.service.hosts) {
          if (typeof h === 'string' && h) byHost.set(h.toLowerCase(), { spec, dir });
        }
      } catch {
        /* not a service skill / unreadable spec — skip */
      }
    }
  } catch {
    /* skills root missing — empty registry */
  }
  return { scannedAt: Date.now(), byHost };
}

function state(skillsRoot: string): RegistryState {
  let st = states.get(skillsRoot);
  if (!st || Date.now() - st.scannedAt > SCAN_TTL_MS) {
    st = scan(skillsRoot);
    states.set(skillsRoot, st);
  }
  return st;
}

/** Find the installed compiled spec for a host, or null. TTL-cached directory scan. */
export function findSpecForHost(host: string, skillsRoot: string): SpecDoc | null {
  return state(skillsRoot).byHost.get(host.toLowerCase())?.spec ?? null;
}

export interface InstalledServiceSkill {
  spec: SpecDoc;
  skillName: string;
  markdown: string;
}

/**
 * Find an installed service skill whose service slug (host first label) or host appears in the
 * given text (schedule name/project/payload). Used to inject the compiled contract into scheduled
 * turns so routines read documented endpoints/fields instead of re-fetching and improvising.
 */
export function findServiceSkillForText(text: string, skillsRoot: string): InstalledServiceSkill | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  for (const [host, inst] of state(skillsRoot).byHost) {
    const slug = host.split('.')[0];
    if (!slug || (!t.includes(slug) && !t.includes(host))) continue;
    try {
      const markdown = readFileSync(join(skillsRoot, inst.dir, 'SKILL.md'), 'utf8');
      return { spec: inst.spec, skillName: inst.dir, markdown };
    } catch {
      return null;
    }
  }
  return null;
}

/** Test hook: drop the TTL cache so the next lookup rescans. */
export function clearSpecRegistryCache(): void {
  states.clear();
}
