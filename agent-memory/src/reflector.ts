/**
 * SessionReflector: skill reflection extraction after session ends
 *
 * Difference from SessionExtractor:
 *   - SessionExtractor: extracts **facts** (user.name = "John Doe")
 *   - SessionReflector: extracts **skills** ("deployment workflow" → recipe)
 *
 * Flow:
 *   1. Read Layer 0.5 action log (tool call history for this session)
 *   2. Call LLM once:
 *      "Look at this session — are there any reusable action patterns?"
 *   3. LLM returns skill list (JSON)
 *   4. Write to memory_skills (create or update)
 *
 * Design principles:
 *   - Quality first: extract fewer, don't generate noisy skills
 *   - Reversible: every skill has a name, user can delete/edit
 *   - No side effects: reflection failure does not affect fact extraction
 */

import type { SkillStore } from './skills.js';
import type { ActionLog } from './actions.js';
import type { RawStore } from './raw.js';
import type { ExtractorLlmClient } from './extractor.js';
import type { Action, RawMessage, ReflectResult, Skill } from './types.js';
import type { MemoryAuditHook } from './audit.js';
import type { MetricsStore } from './metrics.js';
import { countSameRootCauseFailures } from './failure_signatures.js';
import { recipeReuseMaturityMove } from './skill_recipes.js';
import { recordRecipeDecayObservation } from './self_observation.js';
import type { MemoryStore } from './store.js';

// ── LLM-returned skill spec ─────────────────────────────────────────────────

interface ReflectedSkill {
  name: string;
  description: string;
  trigger_keywords: string[];
  action_template: string;
  kind?: 'positive' | 'negative';
}

// ── Prompt ─────────────────────────────────────────────────────────────

const REFLECT_INSTRUCTIONS = `You are a skill-reflection assistant. Your task is to analyze the **user-assistant conversation + tool call history** below and identify two types of distillable patterns:

1. **Positive skills (kind='positive')** — reusable action templates for achieving goals
2. **Anti-patterns / lessons (kind='negative')** — behaviors the user corrected; avoid them when a similar situation arises next time

---

## Positive skills (kind='positive')

**What is it?**
- A set of action steps that accomplish a specific goal
- Something that can be re-executed in the future when a similar goal arises
- Examples: "Deploy a Rust project", "Debug TypeScript compilation errors", "Check git status and push"

**What is it not?** (do NOT extract)
- One-off small talk or Q&A
- Just reading a file or replying with a single message
- Arbitrary operations with no clear goal

---

## Anti-patterns / lessons (kind='negative')

**Recognition signals**: scan **adjacent message pairs** in the conversation—
- Assistant said X / executed X
- User immediately corrected: "that's wrong / it should be / don't do that again / next time / no / mistake / that's not what I asked..."

Only extract when it can be **generalized into "what to do next time in a similar situation"**; one-off specific corrections (wrong name, wrong path) should not be recorded.

**The action_template for anti-patterns must strictly follow this three-section markdown structure** (exact heading text required for programmatic parsing):

\`\`\`markdown
## Trigger
<what situation / user statement makes you prone to this mistake>

## Avoid
<specific wrong behavior: what not to do>

## Instead
<correct behavior: what to do instead; may specify tools or steps to use>
\`\`\`

Example (user said "have the report ready tomorrow", but assistant immediately produced the report):

\`\`\`markdown
## Trigger
User uses relative time words like "tomorrow / day after tomorrow / next week X" to assign tasks

## Avoid
Immediately produce the complete output in the current conversation

## Instead
Call schedule_reminder or create_calendar_event to schedule for the user-specified time; current response only needs to confirm the schedule
\`\`\`

---

## Output format

Return a strict JSON array, each element containing:
\`\`\`json
[
  {
    "name": "skill-slug-kebab-case",
    "description": "one sentence describing what it does and when to use it (negative descriptions should highlight 'avoid X')",
    "trigger_keywords": ["keyword1", "keyword2"],
    "action_template": "...",
    "kind": "positive"
  }
]
\`\`\`

**Important rules**:
- name must be a kebab-case slug (lowercase letters, digits, hyphens only); negative names should start with \`avoid-\`
- If there are no distillable patterns, return empty array []
- kind defaults to 'positive' if omitted
- negative action_template must strictly contain \`## Trigger\`, \`## Avoid\`, \`## Instead\` sections
- Do not output any text outside the JSON

**Conversation + action history**:
`;

function buildReflectPrompt(dialogue: string, actions: Action[]): string {
  let actionsText = '';
  if (actions.length > 0) {
    actionsText =
      '\n\n[Tool call history]\n' +
      actions
        .map((a, i) => {
          const success = a.success ? '✓' : '✗';
          const params = JSON.stringify(a.params).slice(0, 200);
          const result = (a.result ?? '').slice(0, 200);
          return `${i + 1}. ${success} ${a.toolName}(${params}) → ${result}`;
        })
        .join('\n');
  }

  return REFLECT_INSTRUCTIONS + dialogue + actionsText + '\n\nOutput (strict JSON array):';
}

// ── Parse output ───────────────────────────────────────────────────────────

function parseSkills(text: string): ReflectedSkill[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
  }

  const match = cleaned.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSkillSpec);
  } catch {
    return [];
  }
}

function isValidSkillSpec(x: unknown): x is ReflectedSkill {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (
    !(
      typeof r.name === 'string' &&
      /^[a-z0-9-]+$/.test(r.name) &&
      typeof r.description === 'string' &&
      Array.isArray(r.trigger_keywords) &&
      r.trigger_keywords.every((k: unknown) => typeof k === 'string') &&
      typeof r.action_template === 'string'
    )
  ) {
    return false;
  }
  // kind omitted → defaults to positive; explicit 'negative' must follow the three-section structure
  if (r.kind !== undefined && r.kind !== 'positive' && r.kind !== 'negative') {
    return false;
  }
  if (r.kind === 'negative') {
    const tpl = r.action_template as string;
    if (!(tpl.includes('## Trigger') && tpl.includes('## Avoid') && tpl.includes('## Instead'))) {
      return false;
    }
  }
  return true;
}

// ── SessionReflector ────────────────────────────────────────────────────

export interface SessionReflectorOptions {
  /** Optional: self-domain write audit hook (records one Internal origin event per createSkill/updateSkill call) */
  auditHook?: MemoryAuditHook;
  /** 2026-06-22: optional instrumentation counters (idle skill extraction ran vs doom-loop suppressed). */
  metrics?: MetricsStore;
  /** WS5 (selfhood_closure): facts store; enables obs.recipe-decay observations on recipe demotion. */
  facts?: MemoryStore;
}

export class SessionReflector {
  private readonly auditHook: MemoryAuditHook | undefined;
  private readonly metrics: MetricsStore | undefined;
  /** WS5: facts store for recipe-decay self-observations (optional; reuse verification still demotes without it). */
  private readonly factsForRecipes: MemoryStore | undefined;

  constructor(
    private readonly llm: ExtractorLlmClient,
    private readonly skills: SkillStore,
    private readonly actions: ActionLog,
    private readonly raw: RawStore,
    options: SessionReflectorOptions = {},
  ) {
    this.auditHook = options.auditHook;
    this.metrics = options.metrics;
    this.factsForRecipes = options.facts;
  }

  /**
   * Extract skills by reflection from a session (legacy API, by sessionId)
   */
  async reflectFromSession(sessionId: string): Promise<ReflectResult> {
    const messages = this.raw.getMessages(sessionId);
    const actions = this.actions.getBySession(sessionId);
    return this.reflectFromMessages(messages, actions, sessionId);
  }

  /**
   * K0: reflect over a time range (global timeline version).
   */
  async reflectFromTimeRange(
    fromTs: number,
    toTs: number,
  ): Promise<ReflectResult> {
    const messages = this.raw.queryTimeline({
      fromTs,
      untilTs: toTs,
      order: 'asc',
      limit: 5_000,
    });
    const actions = this.actions.getByRange(fromTs, toTs);
    return this.reflectFromMessages(messages, actions, `range:${fromTs}-${toTs}`);
  }

  /** Shared core */
  private async reflectFromMessages(
    messages: RawMessage[],
    actions: Action[],
    tag: string,
  ): Promise<ReflectResult> {
    // No conversation or no actions → no skills to extract
    if (messages.length === 0) {
      return {
        skillsCreated: 0,
        skillsUpdated: 0,
        llmCostTokens: 0,
        skills: [],
      };
    }

    // Phase 18 source gate (2026-06-16): a DOOM-LOOP window (failure-dominated, or repeatedly hitting the same
    // wall) has no reusable workflow to teach — distilling it just churns the draft store (create-then-prune;
    // prod: "pruned 11 / 2 new" every idle cycle) and burns LLM tokens on the extractor call. Suppress
    // extraction for such windows. Same honesty principle as the ViabilityGate: don't manufacture outputs
    // (here, "skills") when there was no genuine progress. Negative "avoid X" lessons are already captured as
    // routing_rules by turn-close reflection, so nothing of value is lost.
    const failed = actions.filter((a) => !a.success);
    const failureDominated = actions.length >= 5 && failed.length / actions.length >= 0.6;
    const sameRoot = countSameRootCauseFailures(failed);
    if (failureDominated || sameRoot >= 4) {
      console.log(
        `[reflector] doom-loop window (fails=${failed.length}/${actions.length}, sameRoot=${sameRoot}) → skill extraction suppressed`,
      );
      this.metrics?.increment('idle_reflect.suppressed'); // instrumentation
      return { skillsCreated: 0, skillsUpdated: 0, llmCostTokens: 0, skills: [] };
    }
    this.metrics?.increment('idle_reflect.ran'); // instrumentation: extraction actually proceeded

    // Build dialogue text
    const dialogue = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role}] ${m.content}`)
      .join('\n');

    // Keep the semantic hint bounded. Creation is still guarded below by a mechanism-side similarity
    // check over the complete non-deprecated store; prompt size must not grow without bound.
    //
    // The mechanism-side guard is word overlap, so it catches a rewording but NOT a synonym built
    // from different vocabulary (`fix-omega-nat-sub` vs `check-lean-nat-subtraction` scores 0 there),
    // and its tokenizer drops single CJK characters, so a Chinese-named skill is invisible to it.
    // Those cases are caught only by the model SEEING the existing name — which is exactly what the
    // tail past this limit loses. Say so when it starts happening instead of regressing silently.
    const existingSkills = this.skills.listAll(CATALOG_HINT_LIMIT);
    if (existingSkills.length >= CATALOG_HINT_LIMIT) {
      console.warn(
        `[reflector] skill catalog hint truncated at ${CATALOG_HINT_LIMIT} of ${this.skills.count()} — ` +
          `skills past the cut can only be deduplicated by word overlap, which is how synonym minting started before`,
      );
    }
    const existingCatalog = existingSkills.length > 0
      ? `\n\n## Existing skill catalog (semantic deduplication)\n` +
        `If a proposed rule is semantically equivalent to one below, return the EXISTING exact name ` +
        `so it is updated instead of minting a synonym. Different wording is not a new skill.\n` +
        existingSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
      : '';
    const prompt = buildReflectPrompt(dialogue, actions) + existingCatalog;
    const { text, tokensUsed } = await this.llm.complete(prompt);

    const specs = parseSkills(text);
    const created: Skill[] = [];
    let updated = 0;

    // Creation-side bound on the untested pool. The store's own design metric is "creation rate <=
    // measurement rate", and while that is violated, minting is not free: the cap has to evict a draft to
    // make room, and once the declined pool is empty the only thing left to evict is another hypothesis
    // nobody has tried either. Refusing to mint is strictly better than trading one untried draft for
    // another. Updates and merges into EXISTING skills are unaffected — those add evidence, not volume.
    let untested = this.skills.untestedDraftCount();
    let mintingBlocked = untested >= MAX_DRAFT_SKILLS;
    if (mintingBlocked && specs.length > 0) {
      // Try to break the deadlock: prune declined drafts first (the idle tick may not have run since
      // the last reflection, so pruneDraftsToCap at line ~393 may be stale).
      const pruned = this.skills.pruneDraftsToCap(MAX_DRAFT_SKILLS);
      if (pruned > 0) {
        untested = this.skills.untestedDraftCount();
        mintingBlocked = untested >= MAX_DRAFT_SKILLS;
      }
      // Capacity pressure is not negative evidence. If the failed pool is empty, keep the existing
      // untested hypotheses and pause minting instead of rotating one untried draft into another.
    }
    if (mintingBlocked && specs.length > 0) {
      console.log(
        `[reflector] not minting ${specs.length} new draft(s): ${untested} untested draft(s) already at cap ${MAX_DRAFT_SKILLS} — ` +
        `the bottleneck is offering them, not generating more (existing skills are still updated)`,
      );
    }

    for (const spec of specs) {
      const kind: 'positive' | 'negative' = spec.kind === 'negative' ? 'negative' : 'positive';
      try {
        const existing = this.skills.getByName(spec.name);
        if (existing) {
          // Already exists: merge description and template (new wins), preserve use_count
          const skill = this.skills.updateSkill(spec.name, {
            description: spec.description,
            triggerKeywords: spec.trigger_keywords,
            actionTemplate: spec.action_template,
            kind,
          });
          if (skill) {
            updated++;
            this.auditHook?.append('self_domain_write', {
              source: 'reflector',
              origin: 'Internal',
              toolName: 'update_skill',
              sessionId: tag,
              skillId: skill.id,
              skillName: skill.name,
              kind,
            });
          }
        } else {
          // 2026-06-08: similarity dedup. The idle reflector previously only checked EXACT name, so
          // it minted near-duplicate skills every cycle (e.g. avoid-pari-syntax vs avoid-pari-gp-syntax)
          // → unbounded skill bloat. If a sufficiently-similar positive skill already exists, MERGE
          // into it instead (mirrors applyReflection's MECE check). pruneDraftsToCap caps the rest.
          // The description is part of the target text (a rename keeps the meaning, not the name);
          // the threshold stays at the store default. Measured at 0.35, `lean-linarith-needs-cast`
          // merges into `lean-omega-needs-positivity` at j=0.42 — and a merge OVERWRITES the older
          // skill's action template, so a false merge silently destroys a learned rule.
          const dup = kind === 'positive'
            ? this.skills.findDuplicateCandidates(spec.name, spec.description)[0]
            : undefined;
          if (dup) {
            const skill = this.skills.updateSkill(dup.skill.name, {
              description: spec.description,
              triggerKeywords: spec.trigger_keywords,
              actionTemplate: spec.action_template,
            });
            if (skill) {
              updated++;
              this.auditHook?.append('self_domain_write', {
                source: 'reflector',
                origin: 'Internal',
                toolName: 'update_skill',
                sessionId: tag,
                skillId: skill.id,
                skillName: skill.name,
                kind,
                note: `merged near-duplicate "${spec.name}" → "${dup.skill.name}" (jaccard ${dup.jaccard.toFixed(2)})`,
              });
            }
          } else if (mintingBlocked) {
            // Nothing to do: the hypothesis is dropped rather than displacing an untried one.
          } else {
            const skill = this.skills.createSkill({
              name: spec.name,
              description: spec.description,
              triggerKeywords: spec.trigger_keywords,
              actionTemplate: spec.action_template,
              kind,
            });
            created.push(skill);
            this.auditHook?.append('self_domain_write', {
              source: 'reflector',
              origin: 'Internal',
              toolName: 'create_skill',
              sessionId: tag,
              skillId: skill.id,
              skillName: skill.name,
              kind,
            });
          }
        }
      } catch {
        // Skip invalid skills
      }
    }

    // Feedback loop: scan linked_skill actions in this range, feed success/failure back to SkillStore.
    // WS5: with a facts store present, callable recipes additionally run reuse verification
    // (fail in scope -> demoted to advisory + obs.recipe-decay observation).
    recordLinkedSkillOutcomes(actions, this.skills, { facts: this.factsForRecipes });

    // 2026-06-08: cap draft skills so the reflector can't grow the store unboundedly (it mints new
    // drafts every idle cycle). Evicts the lowest-scored unused drafts; curated/promoted skills
    // (confirmed/stable/playbook) and disk-loaded skills are never touched.
    const prunedDrafts = this.skills.pruneDraftsToCap(MAX_DRAFT_SKILLS);
    if (prunedDrafts > 0) {
      console.log(`[reflector] pruned ${prunedDrafts} low-value draft skill(s) (cap ${MAX_DRAFT_SKILLS})`);
    }

    return {
      skillsCreated: created.length,
      skillsUpdated: updated,
      llmCostTokens: tokensUsed,
      skills: created,
    };
  }
}

/** How many existing skills the dedup hint may name. Bounds the prompt; see the warning at its use. */
const CATALOG_HINT_LIMIT = 200;

/** Max retained `draft` skills (reflection churn cap). env PHILONT_MAX_DRAFT_SKILLS, default 40, min 5. */
const MAX_DRAFT_SKILLS = (() => {
  const n = Number(process.env.PHILONT_MAX_DRAFT_SKILLS);
  return Number.isInteger(n) && n >= 5 ? n : 40;
})();

/**
 * Feed the success/failure signals of linked_skill actions in this session back to SkillStore.
 *
 * Strategy: if any action for the same skill in the same session fails, record the whole thing as failure;
 * otherwise record each successful action individually as success (preserve the high-frequency-use signal).
 *
 * This strategy is slightly conservative — better to record "partial failure" as failure than to underestimate the problem.
 */
export function recordLinkedSkillOutcomes(
  actions: Action[],
  skills: SkillStore,
  opts: {
    /**
     * WS5 (selfhood_closure): when provided, a CALLABLE recipe (verification + tool policy) that
     * fails its own scope on reuse is demoted straight to 'playbook' (advisory, no use_skill) and
     * an obs.recipe-decay self-observation is written — "a recipe that stops working is caught by
     * its own verification, not a human".
     */
    facts?: MemoryStore;
  } = {},
): { successes: number; failures: number; recipesDemoted: number } {
  const bySkill = new Map<string, Action[]>();
  for (const a of actions) {
    if (!a.linkedSkill) continue;
    const list = bySkill.get(a.linkedSkill) ?? [];
    list.push(a);
    bySkill.set(a.linkedSkill, list);
  }

  let successes = 0;
  let failures = 0;
  let recipesDemoted = 0;
  const reuseVerifyEnabled = (() => {
    const v = (process.env.PHILONT_RECIPE_REUSE_VERIFY ?? '').trim().toLowerCase();
    return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
  })();

  for (const [skillName, acts] of bySkill) {
    const skill = skills.getByName(skillName);
    const isRecipe =
      reuseVerifyEnabled &&
      skill != null &&
      skill.verification != null &&
      (skill.toolPolicy?.length ?? 0) > 0;

    // For a recipe, verification scope = the actions using its declared tool policy; a stray
    // unrelated failure in the same turn must not kill the recipe. No in-scope actions → the
    // reuse never exercised the recipe; fall back to the legacy all-actions strategy.
    const scoped = isRecipe
      ? acts.filter((a) => (skill!.toolPolicy as string[]).includes(a.toolName))
      : acts;
    const judged = scoped.length > 0 ? scoped : acts;
    const anyFail = judged.some((a) => !a.success);

    if (anyFail) {
      const failAction = judged.find((a) => !a.success)!;
      skills.recordSkillOutcome(skillName, false, failAction.timestamp);
      failures++;
      if (isRecipe && recipeReuseMaturityMove(false) === 'demote_revise') {
        skills.setMaturity(skillName, 'playbook');
        recipesDemoted++;
        if (opts.facts) {
          try {
            recordRecipeDecayObservation(opts.facts, skillName, skill!.id);
          } catch {
            // Observation is best-effort; the demotion itself already happened.
          }
        }
      }
    } else {
      // Record each successful action separately, preserving the "high-frequency use" signal
      for (const a of acts) {
        skills.recordSkillOutcome(skillName, true, a.timestamp);
        successes++;
      }
    }
  }
  return { successes, failures, recipesDemoted };
}
