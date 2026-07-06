/**
 * K8 driver drive-config bridge (WS2, docs/design/selfhood_closure.md).
 *
 * SessionDriveReflector tunes `params.cooldownMs` on memory_drive_configs rows, but until WS2
 * nothing ever read those params back — the self-tuning loop wrote to a dead end. This module
 * closes the circle for the three K8 autonomous drivers:
 *
 *   1. ensureK8DriveConfigs()  — seed one config row per driver kind at bootstrap (idempotent).
 *   2. k8DriveOutcomeInput()   — convert a settled initiative into a drive_outcomes row, so the
 *                                reflector has something to score (scoreOutcome reads memoryDelta
 *                                + subsequentToolCalls).
 *   3. readK8DriverCooldowns() — read the (possibly tuned) cooldownMs per driver name, consumed
 *                                by the loop's per-driver propose throttle each tick.
 *
 * Seed cooldowns are 60s — no practical throttle at the default 5-min tick, so behavior is
 * unchanged until the reflector EARNS a change: sustained ineffective initiatives double the
 * cooldown (60s → …until it exceeds the tick and real skipping starts), sustained effective
 * ones halve it back (floor 1s, reflector-side).
 */

import type { Initiative, InitiativeRunResult } from './types.js';
import type { DriveConfigStore } from '../drive_config.js';
import type { DriveOutcomeInput } from '../types.js';

export const K8_DRIVER_NAMES = ['gap', 'curiosity', 'pursuit'] as const;
export type K8DriverName = (typeof K8_DRIVER_NAMES)[number];

export function k8DriveConfigId(driver: K8DriverName): string {
  return `k8-${driver}`;
}

/** 60s: a live knob with zero default effect at the 5-min tick. */
export const DEFAULT_K8_COOLDOWN_MS = 60_000;

/** Seed missing k8-* config rows. Idempotent; existing rows (and their tuned params) are untouched. */
export function ensureK8DriveConfigs(
  configs: DriveConfigStore,
  rootPursuitId: string,
): void {
  for (const driver of K8_DRIVER_NAMES) {
    const id = k8DriveConfigId(driver);
    if (configs.get(id) !== null) continue;
    configs.create({
      id,
      kind: driver,
      status: 'active',
      // The K8 drivers are compiled code — trigger/action live in the driver classes, not in
      // declarative JSON. The row exists to carry tunable params + effectiveness stats.
      triggerExpr: { compiled: `autonomous/${driver}_driver` },
      actionTemplate: { compiled: true },
      params: { cooldownMs: DEFAULT_K8_COOLDOWN_MS },
      rootPursuitId,
    });
  }
}

/** Read the current per-driver cooldowns (reflector-tuned or seeded). Missing row = no throttle. */
export function readK8DriverCooldowns(
  configs: DriveConfigStore,
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const driver of K8_DRIVER_NAMES) {
    const cfg = configs.get(k8DriveConfigId(driver));
    const v = cfg?.params?.cooldownMs;
    out[driver] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  }
  return out;
}

/**
 * Build the drive_outcomes row for a settled K8 initiative, or null for drivers outside the K8
 * set. scoreOutcome then reads: factIds written (+0.3), pursuit markers (+0.5), all-success tool
 * calls (+0.2), majority-failed calls (-0.4) — so done-with-evidence scores positive and failed
 * scores negative, which is exactly the signal cooldown tuning needs.
 */
export function k8DriveOutcomeInput(
  initiative: Initiative,
  result: InitiativeRunResult,
  rootPursuitId: string,
): DriveOutcomeInput | null {
  if (!(K8_DRIVER_NAMES as readonly string[]).includes(initiative.driver)) return null;
  const pursuitMatch = /^pursuit:([^:]+)/.exec(initiative.targetRef);
  const toolCalls = Math.max(0, Math.min(20, result.toolCallsSpent | 0));
  return {
    driveId: k8DriveConfigId(initiative.driver as K8DriverName),
    triggerSnapshot: { kind: initiative.kind, targetRef: initiative.targetRef },
    injectedAction: { initiativeId: initiative.id },
    subsequentToolCalls: Array.from({ length: toolCalls }, () => ({
      ok: result.status === 'done',
    })),
    memoryDelta: {
      factIds: result.outcomeRefs?.facts ?? [],
      noteIds: result.outcomeRefs?.notes ?? [],
    },
    servedPursuitId: pursuitMatch ? pursuitMatch[1] : null,
    rootPursuitId,
  };
}
