/**
 * Every stored reference must resolve to the thing it names.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────────────
 *
 * philont's recurring defect is not "a mechanism is wrong". It is two individually-correct mechanisms
 * disagreeing about how a name is spelled, where one side WRITES an identifier and the other side matches
 * it EXACTLY. The match then misses in silence — no throw, no error, just a feature that quietly does
 * nothing. Known instances:
 *
 *   - a push subscription stored `wechat`, the channel registered `wechat:<accountId>`. Every proactive
 *     message on both messaging channels was dropped for months while startup printed "✅ proactive
 *     findings can reach you".
 *   - a plan-failure playbook stored `source: auto-recovery:<planId>`; the disk hot-reload prune keeps
 *     anything matching `self:%` and deletes the rest as an orphan. So an unrelated file event deleted a
 *     failure lesson the self-learning design says is never auto-retired.
 *   - agent-memory tools are snake_case, agent-tools are camelCase, and the allowlist matches exact names.
 *
 * Each was found by a human pasting a production log into a chat. That is not a detection mechanism, it
 * is luck with a person in the loop, and the detection latency was months.
 *
 * The lesson was written down after the first two — and then the third shipped anyway, because a written
 * lesson is something someone has to REMEMBER to apply. This file is the mechanism that replaces
 * remembering: a startup assertion that every stored reference resolves, so an identifier written by one
 * side and matched by another cannot diverge in silence.
 *
 * ── Design ───────────────────────────────────────────────────────────────────────────────────────────
 *
 * Declarative on purpose. A check is a row: a name, what it references, and a resolver. Adding a new kind
 * of stored reference means adding a row — and a test asserts the registry covers every class we know
 * about, so "we forgot to check the new one" is itself catchable.
 *
 * Reporting is advisory and NEVER blocks startup: a broken reference means a feature is silently dead,
 * which is bad, but refusing to boot over it is worse. Violations are surfaced twice — to the console for
 * whoever is watching, and into the owner-facing health report, because the console is precisely the
 * channel that let the push bug live for months.
 */

export interface IntegrityViolation {
  /** Which check found it. */
  check: string;
  /** The reference that did not resolve, as stored. */
  ref: string;
  /** What it should have resolved to, and what is actually there. */
  detail: string;
  /** What silently stops working because of it — stated in terms of consequence, not of code. */
  consequence: string;
}

export interface IntegrityCheck {
  name: string;
  /** One line describing the invariant, used when the check passes. */
  invariant: string;
  /** Returns the violations; an empty array means the invariant holds. Must never throw. */
  run(): IntegrityViolation[];
}

export interface IntegrityReport {
  checked: number;
  violations: IntegrityViolation[];
  /** Checks that could not run (a store was unavailable) — reported, never silently counted as passing. */
  skipped: Array<{ check: string; reason: string }>;
}

/**
 * Run every check. A check that throws is recorded as SKIPPED, never as passing: an integrity checker
 * that reports "all clear" because it crashed is the same failure it exists to catch.
 */
export function runIntegrityChecks(checks: readonly IntegrityCheck[]): IntegrityReport {
  const violations: IntegrityViolation[] = [];
  const skipped: Array<{ check: string; reason: string }> = [];
  for (const c of checks) {
    try {
      violations.push(...c.run());
    } catch (e) {
      skipped.push({ check: c.name, reason: (e as Error)?.message?.slice(0, 120) ?? String(e).slice(0, 120) });
    }
  }
  return { checked: checks.length - skipped.length, violations, skipped };
}

/** Console rendering. One line when clean; one line per violation otherwise, each naming the consequence. */
export function renderIntegrityReport(r: IntegrityReport): string[] {
  const lines: string[] = [];
  if (r.violations.length === 0 && r.skipped.length === 0) {
    lines.push(`[integrity] ${r.checked}/${r.checked} reference checks pass`);
    return lines;
  }
  lines.push(
    `[integrity] ${r.checked - 0} check(s) ran, ${r.violations.length} broken reference(s)` +
      (r.skipped.length ? `, ${r.skipped.length} could not run` : ''),
  );
  for (const v of r.violations) {
    lines.push(`[integrity] ⛔ ${v.check}: "${v.ref}" — ${v.detail} → ${v.consequence}`);
  }
  for (const s of r.skipped) {
    lines.push(`[integrity] ⚠ ${s.check} could not run (${s.reason}) — treated as UNKNOWN, not as passing`);
  }
  return lines;
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────

export interface IntegrityDeps {
  /** Active push subscriptions, as stored. */
  listSubscriptions: () => Array<{ channel: string; peer: string }>;
  /** Resolve a subscription's channel name the way the dispatcher does. */
  resolvePushChannel: (channel: string) => unknown | null;
  /** Why a channel name did not resolve. */
  describePushChannelMiss: (channel: string) => string;
  /** Skills carrying a non-null source, i.e. everything the disk prune considers deletable. */
  listExternalSkills: () => Array<{ name: string; source?: string | null }>;
  /** Names of skills that actually exist on disk. */
  listDiskSkillNames: () => string[];
  /** Compass-seeded pursuits, and the focus names the compass currently declares. */
  listCompassPursuits?: () => Array<{ id: string; title: string }>;
  compassFocusIds?: () => string[];
}

/**
 * A subscription whose channel does not resolve is a promise to message someone that cannot be kept.
 */
export function pushSubscriptionCheck(d: IntegrityDeps): IntegrityCheck {
  return {
    name: 'push-subscription→channel',
    invariant: 'every active push subscription resolves to a registered channel',
    run: () =>
      d
        .listSubscriptions()
        .filter((s) => !d.resolvePushChannel(s.channel))
        .map((s) => ({
          check: 'push-subscription→channel',
          ref: `${s.channel}:${s.peer}`,
          detail: d.describePushChannelMiss(s.channel),
          consequence: 'every proactive message to this peer is silently dropped',
        })),
  };
}

/**
 * A DB-only skill carrying a source is indistinguishable, to the disk prune, from a skill whose directory
 * the user deleted — so it is deleted on the next unrelated file event. The prune's own safety note says
 * "reflection-generated (source IS NULL) skills never appear here"; anything with a source that is not a
 * disk skill falsifies that note.
 */
export function skillSourceCheck(d: IntegrityDeps): IntegrityCheck {
  return {
    name: 'db-skill→disk',
    invariant: 'every skill the disk prune can delete actually exists on disk',
    run: () => {
      const onDisk = new Set(d.listDiskSkillNames());
      return d
        .listExternalSkills()
        .filter((s) => !onDisk.has(s.name))
        .map((s) => ({
          check: 'db-skill→disk',
          ref: s.name,
          detail: `source="${s.source ?? '?'}" makes it prunable, but no directory of that name exists on disk`,
          consequence: 'the next unrelated skill-directory file event deletes it',
        }));
    },
  };
}

/**
 * A compass-seeded pursuit whose focus the owner has edited out should have been archived by
 * reconcileCompassPursuits. One that survives is the owner's deleted intent still steering the agent.
 */
export function compassPursuitCheck(d: IntegrityDeps): IntegrityCheck {
  return {
    name: 'compass-pursuit→compass',
    invariant: 'every compass-seeded pursuit corresponds to a focus area the compass still declares',
    run: () => {
      if (!d.listCompassPursuits || !d.compassFocusIds) return [];
      const declared = new Set(d.compassFocusIds());
      return d
        .listCompassPursuits()
        .filter((p) => !declared.has(p.id))
        .map((p) => ({
          check: 'compass-pursuit→compass',
          ref: p.id,
          detail: `pursuit "${p.title}" was seeded from a focus area the compass no longer declares`,
          consequence: 'the agent keeps pursuing something you removed from your compass',
        }));
    },
  };
}

export function buildIntegrityChecks(d: IntegrityDeps): IntegrityCheck[] {
  return [pushSubscriptionCheck(d), skillSourceCheck(d), compassPursuitCheck(d)];
}

/** Every reference class this file knows how to check. A test pins that buildIntegrityChecks covers all. */
export const KNOWN_REFERENCE_CLASSES = [
  'push-subscription→channel',
  'db-skill→disk',
  'compass-pursuit→compass',
] as const;
