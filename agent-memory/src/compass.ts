/**
 * compass.md — the owner-authored source that orients philont's intrinsic drives (curiosity /
 * competitiveness / conscientiousness) and declares what the self-drive should focus on.
 *
 * Others call this file "soul.md" and use it to give the AGENT a persona. philont's is a "compass": it does
 * not describe the agent's inner self, it records the OWNER's declaration of where their second mind should
 * point. It is the missing top-of-stack input to machinery philont already has — the constitution (identity
 * + values + drive bounds), the trait model, and pursuits.
 *
 * ## Format (deliberately parsed deterministically — no YAML dependency, an auditable grammar)
 *
 *   ---
 *   # Drive dispositions:  <name>: <baseline> [<min>, <max>]
 *   #   baseline = where the trait sits by default; [min,max] = the LEASH — live self-tuning stays inside it.
 *   curiosity: 0.70 [0.45, 0.85]
 *   competitiveness: 0.55 [0.30, 0.70]
 *   conscientiousness: 0.80 [0.65, 0.95]
 *
 *   # Focus:  focus: <stake 1-10> <survey|active> <name>
 *   focus: 9 active philont itself
 *   focus: 7 survey AI agent field & rivals
 *   ---
 *   <free prose: who you are to me, how I want you to think, red lines …>
 *
 * The frontmatter (between the two `---` lines) parses deterministically here. The prose after it is the
 * owner's voice; a later phase may compile it via the aux LLM, but Phase 1 injects it verbatim.
 *
 * Parsing is LENIENT: this is a hand-written file. Unknown lines are ignored, values are clamped, and a
 * malformed file yields whatever could be read plus an empty rest — never a throw.
 */

import { createHash } from 'node:crypto';

export type CompassTrait = 'curiosity' | 'competitiveness' | 'conscientiousness';

export interface CompassDrive {
  /** Default disposition, 0..1. */
  baseline: number;
  /** [min, max] leash: live trait self-tuning is clamped into this. */
  bounds: [number, number];
}

export interface CompassFocus {
  /** 1..10 — how much of the agent's attention this deserves. */
  stake: number;
  /** 'active' = pursue/advance it; 'survey' = track/summarize only (never attempt to "solve"). */
  mode: 'active' | 'survey';
  name: string;
}

export interface CompassConfig {
  drives: Partial<Record<CompassTrait, CompassDrive>>;
  focus: CompassFocus[];
  /** The free-prose sections after the frontmatter (values, working style, red lines). */
  prose: string;
}

const TRAIT_NAMES: readonly CompassTrait[] = ['curiosity', 'competitiveness', 'conscientiousness'];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Parse a compass.md string. Returns null only for empty/whitespace input; otherwise returns a config with
 * whatever could be read (missing sections default to empty). Never throws.
 */
export function parseCompass(text: string | null | undefined): CompassConfig | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  // Split frontmatter (between the first two '---' fence lines) from the prose after it.
  let frontmatter = '';
  let prose = raw;
  const fence = /^---[ \t]*$/m;
  if (fence.test(raw)) {
    const lines = raw.split('\n');
    let open = -1;
    let close = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^---[ \t]*$/.test(lines[i])) {
        if (open === -1) open = i;
        else { close = i; break; }
      }
    }
    if (open !== -1 && close !== -1) {
      frontmatter = lines.slice(open + 1, close).join('\n');
      prose = lines.slice(close + 1).join('\n').trim();
    }
  }

  const drives: Partial<Record<CompassTrait, CompassDrive>> = {};
  const focus: CompassFocus[] = [];

  for (const lineRaw of frontmatter.split('\n')) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;

    // Drive:  name: baseline [min, max]
    const dm = line.match(
      /^(curiosity|competitiveness|conscientiousness)\s*:\s*([0-9]*\.?[0-9]+)\s*\[\s*([0-9]*\.?[0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\]/i,
    );
    if (dm) {
      const name = dm[1].toLowerCase() as CompassTrait;
      const baseline = clamp01(Number(dm[2]));
      let lo = clamp01(Number(dm[3]));
      let hi = clamp01(Number(dm[4]));
      if (lo > hi) [lo, hi] = [hi, lo]; // tolerate reversed bounds
      drives[name] = { baseline: Math.max(lo, Math.min(hi, baseline)), bounds: [lo, hi] };
      continue;
    }

    // Focus:  focus: <stake> <survey|active> <name>
    const fm = line.match(/^focus\s*:\s*([0-9]+)\s+(survey|active)\s+(.+?)\s*$/i);
    if (fm) {
      const stake = Math.max(1, Math.min(10, Number(fm[1])));
      const mode = fm[2].toLowerCase() === 'active' ? 'active' : 'survey';
      const name = fm[3].trim();
      if (name) focus.push({ stake, mode, name });
      continue;
    }
    // Unknown frontmatter line → ignored (lenient).
  }

  return { drives, focus, prose };
}

/**
 * Clamp a live-tuned trait profile into the owner's compass bounds. The owner sets the leash; the agent's
 * behavior-derived traits move freely INSIDE it but can never cross it. A trait with no compass entry is
 * left untouched.
 */
export function clampTraitsToCompass(
  traits: Record<CompassTrait, number>,
  compass: CompassConfig | null,
): Record<CompassTrait, number> {
  if (!compass) return traits;
  const out = { ...traits };
  for (const t of TRAIT_NAMES) {
    const d = compass.drives[t];
    if (d) out[t] = Math.max(d.bounds[0], Math.min(d.bounds[1], out[t]));
  }
  return out;
}

/**
 * The compass baseline profile — used as the DEFAULT when live tuning is off or has no data yet. Falls back
 * to 0.5 for any trait the compass does not set.
 */
export function compassBaselineTraits(compass: CompassConfig | null): Record<CompassTrait, number> {
  const at = (t: CompassTrait) => compass?.drives[t]?.baseline ?? 0.5;
  return { curiosity: at('curiosity'), competitiveness: at('competitiveness'), conscientiousness: at('conscientiousness') };
}

/**
 * Render the compass as a compact block for injection into a system prompt (the interactive model AND the
 * autonomous executor). This is how the owner's declared focus reaches the drivers — Phase 1's anchor before
 * focus areas are also seeded as pursuit rows.
 */
export function renderCompassForPrompt(compass: CompassConfig | null): string {
  if (!compass) return '';
  const lines: string[] = [];
  if (compass.prose.trim()) lines.push(compass.prose.trim());
  if (compass.focus.length > 0) {
    lines.push('');
    lines.push('## What I have told you to focus on (my compass)');
    for (const f of compass.focus) {
      const tag = f.mode === 'active' ? 'pursue' : 'survey only — track, do not try to solve';
      lines.push(`- [stake ${f.stake}/10 · ${tag}] ${f.name}`);
    }
  }
  return lines.join('\n');
}

// ── Focus → pursuits (Phase 1b) ─────────────────────────────────────────────────────────────────
//
// The compass focus areas become pursuit rows so BOTH self-drive channels anchor to them: the in-turn
// drives (which read active pursuits every user turn → proactive DURING work) and the background autonomous
// loop (curiosity/pursuit drivers → work between turns). Without this the drivers have nothing of the
// owner's to draw on (prod: in-turn "0 fired", background wandered on free curiosity).

/** A pursuit the compass wants to exist. id is deterministic (compass:<slug>) for idempotency. */
export interface DesiredCompassPursuit {
  id: string;
  title: string;
  intent: string;
  stakeWeight: number;
  mode: 'active' | 'survey';
  /** The opening question the pursuit is created with — without one no driver can advance it. */
  openingQuestion: string;
}

/** Minimal shape of an existing pursuit needed to reconcile (decouples this from the full Pursuit type). */
export interface ExistingPursuitLite {
  id: string;
  origin: string;
  stakeWeight: number;
}

export interface CompassPursuitReconcile {
  create: DesiredCompassPursuit[];
  updateStake: Array<{ id: string; stakeWeight: number }>;
  archive: string[];
}

/**
 * Deterministic, VALID pursuit id for a compass focus area. The pursuit id grammar is
 * ^[a-z0-9][a-z0-9_-]{0,63}$ (no ':' , no non-ascii), so a Chinese focus name cannot go in raw. Form:
 * `compass-<ascii-slug>-<hash8>` — the ascii slug aids readability when the name is latin, and the hash of
 * the FULL name guarantees a unique, stable id for any name (idempotency: same name → same id). Exported so
 * the reconcile and its tests share one source of truth.
 */
export function compassPursuitId(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const h = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return ascii ? `compass-${ascii}-${h}` : `compass-${h}`;
}

/**
 * The opening question a freshly declared focus starts life with.
 *
 * Without one the pursuit is inert: PursuitDriver can only advance a pursuit that has an open question or
 * resolutionCriteria, and it says so itself — "the pursuit first needs an LLM-side goal definition; that is
 * the reflector's job". For a compass focus nothing ever did that job, so the owner's declared direction sat
 * in the table forever while every autonomous tick went to free curiosity instead (prod 2026-07-21).
 *
 * The question is deliberately about ORIENTATION, not about a solution: it asks what the current state is and
 * what would move it, which is answerable by research for any focus area and does not put a goal in the
 * owner's mouth. Survey-mode focus areas get a strictly observational phrasing, mirroring focusIntent.
 */
export function focusOpeningQuestion(f: CompassFocus): string {
  return f.mode === 'active'
    ? `What is the current state of "${f.name}", and what concrete next step would actually advance it?`
    : `What has recently and verifiably happened in "${f.name}"? Track and summarize only — do not attempt to solve it.`;
}

function focusIntent(f: CompassFocus): string {
  return f.mode === 'active'
    ? `A focus area my owner declared in their compass. Advance it: make real, verifiable progress and report what moved.`
    : `A focus area my owner declared in their compass, SURVEY-ONLY: track and summarize recent, real ` +
        `developments — do NOT attempt to solve, prove, or "crack" it (that guards against doomed attacks).`;
}

/**
 * Compute the idempotent reconcile between the compass focus and the currently-seeded compass pursuits.
 * Pure + unit-testable; the caller applies it against the PursuitStore.
 *   - create:  focus areas with no pursuit yet
 *   - updateStake: existing compass pursuit whose stake drifted from the compass
 *   - archive: compass-origin pursuits whose focus was removed from the compass (owner edited it out)
 */
export function reconcileCompassPursuits(
  compass: CompassConfig | null,
  existing: ReadonlyArray<ExistingPursuitLite>,
): CompassPursuitReconcile {
  const desired = new Map<string, DesiredCompassPursuit>();
  for (const f of compass?.focus ?? []) {
    const id = compassPursuitId(f.name);
    // On a slug collision the last focus wins (rare; keeps the map 1:1 with ids).
    desired.set(id, {
      id,
      title: f.name,
      intent: focusIntent(f),
      stakeWeight: f.stake,
      mode: f.mode,
      openingQuestion: focusOpeningQuestion(f),
    });
  }
  const existingCompass = existing.filter((p) => p.origin === 'compass');
  const existingIds = new Set(existingCompass.map((p) => p.id));

  const create: DesiredCompassPursuit[] = [];
  const updateStake: Array<{ id: string; stakeWeight: number }> = [];
  for (const d of desired.values()) {
    const cur = existingCompass.find((p) => p.id === d.id);
    if (!cur) create.push(d);
    else if (cur.stakeWeight !== d.stakeWeight) updateStake.push({ id: d.id, stakeWeight: d.stakeWeight });
  }
  const archive = existingCompass.filter((p) => !desired.has(p.id)).map((p) => p.id);

  return { create, updateStake, archive };
}
