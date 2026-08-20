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

import { writeSkillBundleAtomically, readInstalledSourceTag } from '../installTool.js';
import { fetchFrom } from './router.js';
import { scanSkillBundle } from './scanner.js';
import { gateDecision } from './gate.js';
import { upsertLock, appendAudit, readLock } from './lockStore.js';
import { isMarketplaceSourceTag } from './shared.js';
import type { InstallActor, InstallOutcome, ProvenanceRecord, ScanReport, SkillBundle } from './types.js';

export interface InstallRequest {
  sourceId: string;
  identifier: string;
  /** Override the install name (defaults to the bundle's normalized name). */
  name?: string;
  /** Set true to proceed past an `ask` gate (user/agent confirmed). */
  confirm?: boolean;
  /**
   * Set true to install despite a `block` decision. **Honoured only when `actor === 'user'`.**
   *
   * 'user' is a claim the caller has to earn through an authenticated, out-of-band approval channel.
   * The unauthenticated HTTP endpoint always passes 'api' and rejects override fields outright —
   * which matters because the agent itself can reach that endpoint through shell.
   *
   * The gate's block arm is a regex heuristic over a document that legitimately contains shell and
   * python snippets, so it has false positives — and a hard block with no way through means a user
   * who has read the findings and still wants the skill has to hand-copy files, i.e. the same install
   * with none of the provenance or audit trail. This override keeps that decision inside the system
   * where it gets recorded. It is deliberately unreachable from the agent-facing tool (no schema
   * field, actor is hardcoded to 'agent'), so the model can never talk itself past the gate;
   * `updateSkill` never carries it forward either — a newly dangerous version must be decided again.
   */
  override?: boolean;
  /** Who confirmed, for the audit trail. */
  actor?: InstallActor;
  /** Free-text provenance of the request (origin / caller), recorded in the audit log. */
  auditNote?: string;
  /** ISO timestamp to stamp provenance with (caller supplies; agent-tools has no clock side-effects). */
  now?: string;
}

/**
 * Turn a raw fetch failure into something the reader can act on.
 *
 * The size cap in particular used to surface as a bare `SKILL.md actionTemplate exceeds 65536 bytes`,
 * which reads like a bug in philont rather than a deliberate limit with a knob. Real skills do hit it
 * (anthropics/skills' claude-api SKILL.md is 74 KB), so the message has to name the knob.
 */
function explainFetchFailure(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/actionTemplate exceeds/.test(msg)) {
    return (
      `${msg} — this skill's SKILL.md is larger than philont's per-skill limit. Raise ` +
      `PHILONT_MAX_ACTION_TEMPLATE_SIZE (bytes) if the context budget allows it, or pick a smaller skill.`
    );
  }
  if (/HTTP 404/.test(msg)) {
    return `${msg} — check the identifier: for GitHub use "owner/repo:path/to/SKILL.md", for clawhub use "@publisher/slug".`;
  }
  if (/HTTP 403|rate limit/i.test(msg)) {
    return `${msg} — GitHub rate limit; set PHILONT_GITHUB_TOKEN to raise it.`;
  }
  return `fetch failed: ${msg}`;
}

/** Fetch + scan without installing — powers the inspect endpoint and the pre-install preview. */
export async function inspectBundle(
  sourceId: string,
  identifier: string,
): Promise<{ bundle: SkillBundle; scan: ScanReport; decision: ReturnType<typeof gateDecision> }> {
  const bundle = await fetchFrom(sourceId, identifier);
  const scan = scanSkillBundle(bundle.content, bundle.files);
  const decision = gateDecision(bundle.meta.trust, scan.verdict);
  return { bundle, scan, decision };
}

export async function installFromSource(req: InstallRequest): Promise<InstallOutcome> {
  let bundle: SkillBundle;
  try {
    bundle = await fetchFrom(req.sourceId, req.identifier);
  } catch (e) {
    return { status: 'error', error: explainFetchFailure(e) };
  }

  const name = req.name ? req.name : bundle.meta.name;
  const scan = scanSkillBundle(bundle.content, bundle.files);
  const decision = gateDecision(bundle.meta.trust, scan.verdict);

  // A user-authored override is the only way past `block`; an agent asking for one is itself an event.
  const overridden = decision === 'block' && req.override === true && req.actor === 'user';
  if (decision === 'block' && !overridden) {
    if (req.override === true) {
      appendAudit({ ts: req.now ?? '', action: 'override_refused', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, actor: req.actor, note: req.auditNote });
    }
    appendAudit({ ts: req.now ?? '', action: 'blocked', name, sourceTag: bundle.meta.sourceTag, verdict: scan.verdict, decision, actor: req.actor, note: req.auditNote });
    return {
      status: 'blocked',
      name,
      sourceTag: bundle.meta.sourceTag,
      verdict: scan.verdict,
      decision,
      report: scan,
      notInstalled: bundle.notInstalled,
    };
  }
  if (decision === 'ask' && !req.confirm) {
    return {
      status: 'ask',
      name,
      sourceTag: bundle.meta.sourceTag,
      verdict: scan.verdict,
      decision,
      report: scan,
      notInstalled: bundle.notInstalled,
    };
  }

  // Build the complete bundle outside the watched skills directory and swap it in as one operation.
  // This also removes companions deleted upstream; overwriting only files present in the new version
  // left obsolete scripts executable indefinitely.
  // May we overwrite what is already there? The lock file is the fast answer but not the only one:
  // readLock() returns {} for a missing OR malformed file by design, so a lost lock used to make every
  // installed skill look like a stranger's directory and turned each update into a hard error advising
  // nothing. The durable record is the `source:` tag we wrote into the skill's own SKILL.md, so fall
  // back to that — an install we can prove we made stays replaceable, and the lock is rewritten below,
  // which repairs it. A directory with no lock row AND no marketplace tag (a self-learned or
  // hand-made skill that happens to share the name) is still refused.
  const previous = readLock()[name];
  const onDiskSource = previous ? null : await readInstalledSourceTag(name);
  const replaceExisting = Boolean(previous) || isMarketplaceSourceTag(onDiskSource);
  const bundleWrite = await writeSkillBundleAtomically(
    name,
    bundle.content,
    bundle.meta.sourceTag,
    bundle.files ?? [],
    replaceExisting,
  );
  if (bundleWrite.error) return { status: 'error', name, error: `installSkill failed: ${bundleWrite.error}` };

  const droppedSample = [...(bundle.notInstalled?.sample ?? []), ...bundleWrite.rejected];
  const droppedTotal = (bundle.notInstalled?.total ?? 0) + bundleWrite.rejected.length;
  const notInstalled = droppedTotal ? { total: droppedTotal, sample: droppedSample.slice(0, 8) } : undefined;

  const installedAt = req.now ?? '';
  const provenance: ProvenanceRecord = {
    name,
    sourceId: req.sourceId,
    identifier: req.identifier,
    sourceTag: bundle.meta.sourceTag,
    trust: bundle.meta.trust,
    contentHash: bundle.contentHash,
    bundleHash: bundle.bundleHash,
    version: bundle.meta.version,
    verdict: scan.verdict,
    decision,
    confirmedBy: decision === 'ask' || overridden ? (req.actor ?? 'user') : null,
    // Records that this skill is on disk *despite* a block verdict — visible in skills.lock.json and
    // in the UI, so an overridden skill never looks like an ordinary clean install afterwards.
    overridden: overridden || undefined,
    installedAt,
    paths: bundleWrite.written,
  };
  upsertLock(provenance);
  appendAudit({
    ts: installedAt,
    action: overridden ? 'override_install' : 'install',
    name,
    sourceTag: bundle.meta.sourceTag,
    verdict: scan.verdict,
    decision,
    actor: req.actor,
    note: req.auditNote,
  });

  return {
    status: 'installed',
    name,
    sourceTag: bundle.meta.sourceTag,
    verdict: scan.verdict,
    decision,
    report: scan,
    provenance,
    overridden: overridden || undefined,
    installedFiles: bundleWrite.written.length,
    // Whatever the budget or a write error left out. Carried to every caller so "installed" never
    // silently means "installed the markdown and none of the scripts it tells you to run".
    notInstalled,
  };
}
