/**
 * runParallelSubAgents (H1) — parallel, isolated-context orchestration over the existing
 * mini-agent-loop. See `docs/design/sub_agent_capability.md`. planAndExecute runs sub-tasks
 * SEQUENTIALLY; this fans them out. Each child runs in its OWN mini-agent-loop (a fresh messages stack —
 * a child never sees a sibling's transcript), up to `concurrency` at a time, under a shared token budget.
 *
 * P0 = the fan-out primitive + a deterministic aggregator. NOT wired into any call site yet (zero
 * behavior change). P1 wires call site (1) parallel research/grounding behind a flag.
 */
import {
  runMiniAgentLoop,
  type MiniLoopLLMClient,
  type MiniLoopToolRunResult,
} from '../utils/mini-agent-loop.js';
import type { ToolDefinition } from '@agent/policy';

export interface SubTask {
  id: string;
  systemPrompt: string;
  userMessage: string;
  /** Restrict this child to these tools. Default = no extra restriction beyond the batch blacklist. */
  toolWhitelist?: ReadonlySet<string>;
  maxIters?: number;
}

export interface SubAgentResult {
  id: string;
  status: 'success' | 'failed' | 'skipped';
  finalText: string;
  tokensSpent: number;
  error?: string;
}

export interface ParallelSubAgentOptions {
  llm: MiniLoopLLMClient;
  toolDefs: ToolDefinition[];
  toolRunner: (name: string, input: Record<string, unknown>) => Promise<MiniLoopToolRunResult>;
  /** Max children running at once. Default min(4, tasks). */
  concurrency?: number;
  /** Shared per-batch token ceiling: a child that would START over budget is SKIPPED (not truncated). */
  budgetTokens?: number;
  toolBlacklist?: ReadonlySet<string>;
  abortSignal?: AbortSignal;
}

/**
 * Run each SubTask in its own isolated mini-agent-loop, ≤ `concurrency` at a time, under a shared token
 * budget. NEVER rejects: a thrown/aborted child → status='failed'; a child skipped for budget →
 * status='skipped'. Results are returned in the SAME order as `tasks`.
 */
export async function runParallelSubAgents(
  tasks: ReadonlyArray<SubTask>,
  opts: ParallelSubAgentOptions,
): Promise<SubAgentResult[]> {
  const results: SubAgentResult[] = new Array(tasks.length);
  if (tasks.length === 0) return results;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, tasks.length));
  let next = 0;
  let spent = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const task = tasks[i];
      if (opts.abortSignal?.aborted) {
        results[i] = { id: task.id, status: 'failed', finalText: '', tokensSpent: 0, error: 'aborted' };
        continue;
      }
      if (opts.budgetTokens != null && spent >= opts.budgetTokens) {
        results[i] = {
          id: task.id,
          status: 'skipped',
          finalText: '',
          tokensSpent: 0,
          error: 'batch token budget exhausted',
        };
        continue;
      }
      try {
        const r = await runMiniAgentLoop({
          systemPrompt: task.systemPrompt,
          userMessage: task.userMessage,
          llm: opts.llm,
          toolDefs: opts.toolDefs,
          toolRunner: opts.toolRunner,
          maxIters: task.maxIters,
          toolWhitelist: task.toolWhitelist,
          toolBlacklist: opts.toolBlacklist,
          abortSignal: opts.abortSignal,
        });
        spent += r.llmTokensSpent;
        results[i] = {
          id: task.id,
          status: r.error ? 'failed' : 'success',
          finalText: r.finalText,
          tokensSpent: r.llmTokensSpent,
          error: r.error,
        };
      } catch (e) {
        results[i] = {
          id: task.id,
          status: 'failed',
          finalText: '',
          tokensSpent: 0,
          error: (e as Error)?.message ?? String(e),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

/**
 * Deterministic aggregation (P0): concatenate each SUCCESSFUL child's final text under its id. The
 * orchestrator's small-context LLM synthesis (child summaries only) is P1.
 */
export function aggregateSubAgentResults(results: ReadonlyArray<SubAgentResult>): string {
  const ok = results.filter((r) => r.status === 'success' && r.finalText.trim());
  return ok.map((r) => `### ${r.id}\n${r.finalText.trim()}`).join('\n\n');
}
