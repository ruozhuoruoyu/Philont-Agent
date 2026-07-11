/**
 * Capability manifest — the agent's ground-truth of what it can currently do, GENERATED from live
 * runtime state (feature flags + the registered autonomous-driver set + tool count), never hand-written.
 *
 * Why generated, not authored: the failure this fixes (prod 2026-07-11) was the agent evaluating a
 * STALE version of itself — asked to assess its "continuous-learning" upgrade, it reported skill
 * self-repair / versioning / trajectory storage as ❌ MISSING, days after those very features shipped and
 * were enabled. A hand-written capability blurb (in the system prompt OR a soul.md) would have drifted the
 * exact same way, because the root cause was human maintenance forgetting to update it. Reading the real
 * flags/registry each turn is accurate by construction: a newly shipped, enabled capability shows up with
 * no one remembering to edit anything.
 *
 * Division of labour (see the 2026-07-11 discussion): stable, curated, owner-ratified identity/values live
 * in the constitution; the volatile, release-coupled "what can I do right now" inventory lives HERE and is
 * derived, not stored. `renderCapabilityManifest` is the compact per-turn injection; `renderCapabilityDetail`
 * backs the `self_capabilities` read-only tool for on-demand depth.
 *
 * Pure: both renderers take a fully-resolved `CapabilityState` and return a string. The caller
 * (chat-handler) assembles the state from the actual runtime readers.
 */

export interface CapabilityState {
  /** H3: a callable recipe that fails its own reuse check is diagnosed from its real failed runs and rewritten. */
  skillSelfRepair: boolean;
  /** A recipe that stops working is demoted to advisory automatically on reuse. */
  recipeReuseVerify: boolean;
  /** reviseRecipe snapshots the prior version into revision_history — true whenever the schema supports it. */
  skillVersioning: boolean;
  /** obs.* self-observations aggregated from the action/drive ledger. */
  selfObservations: boolean;
  /** Personality traits derived from the agent's own history, not frozen constants. */
  liveTraits: boolean;
  /** The agent may PROPOSE constitution amendments (owner ratifies). */
  constitutionProposals: boolean;
  /** deep_explore multi-round reasoning engine available. */
  deepExplore: boolean;
  /** Idle-time autonomous initiative loop running. */
  autonomousLoop: boolean;
  /** Every turn anchored to a real execution ledger (honesty gates compare claims against it). */
  executionLedger: boolean;
  /** The autonomous drivers actually registered this process (autonomousDriverNames). */
  autonomousDrivers: readonly string[];
  /** Total tools available to the agent this process. */
  toolCount: number;
}

function onOff(b: boolean): string {
  return b ? 'ON' : 'off';
}

/**
 * Compact block injected into the identity prompt every turn. A few lines; leads with the self-learning
 * stack (the axis a stale self-model gets wrong) and ends with the standing instruction to consult THIS
 * rather than a remembered older self.
 */
export function renderCapabilityManifest(s: CapabilityState): string {
  const lines: string[] = [];
  lines.push('## What you can do right now (live runtime state — consult this; do NOT answer from a remembered older version of yourself)');
  lines.push(
    `- Self-learning stack: skill self-repair ${onOff(s.skillSelfRepair)} · recipe reuse-verification ${onOff(s.recipeReuseVerify)} · skill versioning ${onOff(s.skillVersioning)} (reviseRecipe keeps a revision history) · self-observations ${onOff(s.selfObservations)} · live traits ${onOff(s.liveTraits)}.`,
  );
  lines.push(
    `- Reasoning & autonomy: deep_explore ${onOff(s.deepExplore)} · autonomous idle loop ${onOff(s.autonomousLoop)} · constitution proposals ${onOff(s.constitutionProposals)} · execution-ledger honesty anchor ${onOff(s.executionLedger)}.`,
  );
  if (s.autonomousDrivers.length) {
    lines.push(`- Autonomous drivers running: ${s.autonomousDrivers.join(', ')}.`);
  }
  lines.push(
    `- When asked what you can do (or to self-evaluate your capabilities), state THIS. For deeper detail call the \`self_capabilities\` tool; do not guess or rely on prior training.`,
  );
  return lines.join('\n');
}

/**
 * Fuller rendering for the `self_capabilities` read-only tool — same facts, plus tool count and an explicit
 * note on what each self-learning capability actually does, for when the agent needs to reason about them.
 */
export function renderCapabilityDetail(s: CapabilityState): string {
  const lines: string[] = [];
  lines.push('# philont — current capabilities (generated from live runtime state)');
  lines.push('');
  lines.push('## Self-learning');
  lines.push(`- Skill self-repair: ${onOff(s.skillSelfRepair)} — a callable recipe (verified skill) that fails its own reuse check is diagnosed from its real failed runs in the execution ledger and rewritten; the old version is kept and the recipe re-earns trust. A recipe that resists 3 repairs is retired.`);
  lines.push(`- Recipe reuse-verification: ${onOff(s.recipeReuseVerify)} — a recipe that stops working on reuse is demoted to advisory automatically (this is what triggers self-repair).`);
  lines.push(`- Skill versioning: ${onOff(s.skillVersioning)} — reviseRecipe snapshots the prior (steps, verification) into revision_history, so "did the rewrite help" is measurable and old versions are not lost.`);
  lines.push(`- Self-observations: ${onOff(s.selfObservations)} — behavioural tendencies aggregated from the action/drive ledger into obs.* self facts (evidence-backed).`);
  lines.push(`- Live traits: ${onOff(s.liveTraits)} — competitiveness/curiosity derived from your own track record, tuning goal-loop thresholds; not frozen constants.`);
  lines.push('');
  lines.push('## Reasoning, autonomy & integrity');
  lines.push(`- deep_explore: ${onOff(s.deepExplore)} — persistent multi-round reasoning tree (decompose → verify → backtrack), resumable across turns/days.`);
  lines.push(`- Autonomous idle loop: ${onOff(s.autonomousLoop)} — drivers propose and run initiatives while idle, under strict budgets.`);
  lines.push(`- Constitution proposals: ${onOff(s.constitutionProposals)} — you may PROPOSE identity amendments with evidence; only the owner ratifies. Red lines are never amendable.`);
  lines.push(`- Execution-ledger honesty anchor: ${onOff(s.executionLedger)} — every turn is checked against the real record of what tools ran; a claim that diverges from it is blocked and regenerated honestly.`);
  lines.push('');
  lines.push(`## Drivers & tools`);
  lines.push(`- Autonomous drivers registered: ${s.autonomousDrivers.length ? s.autonomousDrivers.join(', ') : '(none)'}.`);
  lines.push(`- Tools available: ${s.toolCount}.`);
  lines.push('');
  lines.push('These are read from live process state, not memory — they are the current truth. When self-assessing, do not report capabilities you no longer / now do have based on older knowledge.');
  return lines.join('\n');
}

/**
 * Kill switch for the per-turn injection (the tool stays available regardless).
 * PHILONT_CAPABILITY_MANIFEST=0/off/false/no disables the always-on block; default on.
 */
export function capabilityManifestInjectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.PHILONT_CAPABILITY_MANIFEST ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
