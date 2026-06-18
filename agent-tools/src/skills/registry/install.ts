/**
 * Install pipeline: fetch → scan → trust×verdict gate → write (via the existing installSkill primitive)
 * → provenance + audit.
 *
 * Reuses installSkillTool.execute() for the actual file write so name validation, frontmatter injection,
 * and the .philont/skills/ landing path are identical to every other install path. The scan runs on the
 * in-memory content (no physical quarantine dir needed: content never reaches the loader's scan dirs
 * until the gate passes and installSkillTool writes it).
 *
 * DB sync (SkillStore reload) is the caller's responsibility — the server wraps installSkillTool with
 * reloadSkillsFromDisk; agent-tools stays free of an agent-memory dependency.
 */

import { join } from 'node:path';
import { installSkillTool } from '../installTool.js';
import { fetchFrom } from './router.js';
import { scanSkillContent } from './scanner.js';
import { gateDecision } from './gate.js';
import { upsertLock, appendAudit } from './lockStore.js';
import type { InstallOutcome, ProvenanceRecord, ScanReport, SkillBundle } from './types.js';

export interface InstallRequest {
  sourceId: string;
  identifier: string;
  /** Override the install name (defaults to the bundle's normalized name). */
  name?: string;
  /** Set true to proceed past an `ask` gate (user/agent confirmed). */
  confirm?: boolean;
  /** Who confirmed, for the audit trail. */
  actor?: 'user' | 'agent';
  /** ISO timestamp to stamp provenance with (caller supplies; agent-tools has no clock side-effects). */
  now?: string;
}

/** Fetch + scan without installing — powers the inspect endpoint and the pre-install preview. */
export async function inspectBundle(
  sourceId: string,
  identifier: string,
): Promise<{ bundle: SkillBundle; scan: ScanReport; decision: ReturnType<typeof gateDecision> }> {
  const bundle = await fetchFrom(sourceId, identifier);
  const scan = scanSkillContent(bundle.content);
  const decision = gateDecision(bundle.meta.trust, scan.verdict);
  return { bundle, scan, decision };
}

export async function installFromSource(req: InstallRequest): Promise<InstallOutcome> {
  let bundle: SkillBundle;
  try {
    bundle = await fetchFrom(req.sourceId, req.identifier);
  } catch (e) {
    return { status: 'error', error: `fetch failed: ${(e as Error).message}` };
  }

  const name = req.name ? req.name : bundle.meta.name;
  const scan = scanSkillContent(bundle.content);
  const decision = gateDecision(bundle.meta.trust, scan.verdict);

  if (decision === 'block') {
    appendAudit({ ts: req.now ?? '', action: 'blocked', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, actor: req.actor });
    return { status: 'blocked', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, report: scan };
  }
  if (decision === 'ask' && !req.confirm) {
    return { status: 'ask', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, report: scan };
  }

  // write via the shared primitive (validates name, injects name+source frontmatter, lands in .philont/skills/)
  const res = await installSkillTool.execute({ name, content: bundle.content, source: bundle.meta.sourceTag });
  if (!res.success) {
    return { status: 'error', name, error: res.error ?? 'installSkill failed' };
  }

  const installedAt = req.now ?? '';
  const provenance: ProvenanceRecord = {
    name,
    sourceId: req.sourceId,
    identifier: req.identifier,
    sourceTag: bundle.meta.sourceTag,
    trust: bundle.meta.trust,
    contentHash: bundle.contentHash,
    version: bundle.meta.version,
    verdict: scan.verdict,
    decision,
    confirmedBy: decision === 'ask' ? (req.actor ?? 'user') : null,
    installedAt,
    paths: [join(process.cwd(), '.philont', 'skills', name, 'SKILL.md')],
  };
  upsertLock(provenance);
  appendAudit({ ts: installedAt, action: 'install', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, actor: req.actor });

  return { status: 'installed', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, report: scan, provenance };
}
