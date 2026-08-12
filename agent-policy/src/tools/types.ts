/**
 * Tool system type definitions
 */

import type { Capability, Domain } from '../matrix.js';

/** Tool execution result */
export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  duration?: number; // milliseconds
  /**
   * Machine-readable detail alongside the human-readable `output`, for the cases where a caller has
   * to branch on WHAT happened rather than parse a sentence about it.
   *
   * Added when planAndExecute needed to say "this plan stopped for want of an approval, here is the
   * step it stopped at, and it can be resumed" — a distinction the parent turn must act on and which
   * has no honest encoding in prose. Prose is what the model reads; this is what the mechanism reads.
   */
  data?: Record<string, unknown>;
}

/** Tool definition */
export interface Tool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema (parameter definition) */
  schema: Record<string, unknown>;
  /** Static capability classification (default value) */
  capability: Capability;
  /** Static domain classification (default value) */
  domain: Domain;
  /**
   * Dynamic classification (optional)
   *
   * When implemented, ToolRegistry.classify() calls this first and returns a concrete
   * classification based on the parameters. For example, an http tool: GET→read, POST→write.
   */
  classify?: (params: Record<string, unknown>) => { capability: Capability; domain: Domain };
  /** Execution function */
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}
