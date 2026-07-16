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
