/**
 * GLM (Zhipu) provider profile.
 *
 * 2026-10-09: glm5.3-flash-b30t reached over the Anthropic protocol (a neolink gateway) resolved to
 * OpenAICompatProfile, whose wire is EMPTY — no thinking field at all. GLM 4.5+ thinks by default, so
 * every call thought until max_tokens: 31 "thinking consumed the whole 16000-token budget with no
 * text" retries in one day, and the retry "at effort=off" changed nothing on the wire because this
 * profile had nothing to say. One call thought for 32000 tokens on a 61-token prompt.
 *
 * GLM has a thinking TOGGLE and no effort knob:
 *   - Anthropic format: thinking{type:'enabled'} / thinking{type:'disabled'} (no budget_tokens — the
 *     gateway may reject fields it does not know, and max_tokens is the only real cap).
 *   - OpenAI format: top-level thinking{type:'enabled'|'disabled'} (same field the aux path sends).
 * The field is ALWAYS pinned so the endpoint's default-on never decides for us.
 *
 * Effort is folded into the toggle: 'low' means "cheap", and the cheap GLM call is the one that does
 * not think. The adapter's thinking-only retry skips the effort ladder for a profile without an effort
 * knob (supportsEffort=false) and goes straight to thinking off — stepping max→high on a model that
 * cannot tell them apart would just think the doubled budget away again.
 *
 * Env vars (shared): PHILONT_LLM_REASONING_MAX_TOKENS default 32000 — ceiling for high/max effort.
 */

import { BaseProfile, mapEffort, envInt, type ReasoningConfig, type ReasoningWire } from './base.js';

export function isGlmModel(model: string): boolean {
  return (model || '').trim().toLowerCase().includes('glm');
}

/** Thinking is on unless the caller turned it off or asked for the cheap ('low') variant. */
export function glmThinkingEnabled(reasoning: ReasoningConfig | undefined): boolean {
  if (reasoning?.enabled === false) return false;
  return mapEffort(reasoning?.effort) !== 'low';
}

export class GlmProfile extends BaseProfile {
  constructor() {
    super('glm');
  }

  supportsThinking(model: string): boolean {
    return isGlmModel(model);
  }

  supportsEffort(_model: string): boolean {
    return false;
  }

  buildReasoningWire(model: string, reasoning: ReasoningConfig | undefined): ReasoningWire {
    if (!this.supportsThinking(model)) return {};
    const thinking = { type: glmThinkingEnabled(reasoning) ? 'enabled' : 'disabled' };
    return { anthropicParams: { thinking }, openaiExtraBody: { thinking } };
  }

  resolveMaxTokens(model: string, reasoning: ReasoningConfig | undefined, base: number): number {
    if (!this.supportsThinking(model) || !glmThinkingEnabled(reasoning)) return base;
    const effort = mapEffort(reasoning?.effort);
    if (effort === 'high' || effort === 'max') {
      return Math.max(base, envInt('PHILONT_LLM_REASONING_MAX_TOKENS', 32000));
    }
    return base;
  }
}
