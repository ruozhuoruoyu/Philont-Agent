/**
 * chat.send handler - tool call loop + dynamic authorization (non-blocking)
 *
 * Authorization flow:
 *   1. Insufficient permissions → save paused state, send auth_request, return
 *   2. Next user message → detect pendingAuth → classify intent → continue or reject
 */

import {
  AuditLog,
  createReadOnlyMatrix, createSandboxMatrix, checkPermission,
  createToolChecker,
  GrantStore,
  SecretStore,
  createDefaultChain,
  createPathAclValidator,
  createDangerousCommandValidator,
  DEFAULT_DANGEROUS_PATTERNS,
  findDangerousPattern,
  type ToolCheckInput,
} from '@agent/policy';
import type { ToolDefinition, ToolResult } from '@agent/policy';
import type { ReasoningNode, ReasoningSession, InitiativeStore } from '@agent/memory';
import {
  createToolset,
  loadSkills,
  watchSkillDir,
  installSkillTool,
  uninstallSkillTool,
  installSkillFromRegistryTool,
  removeLock,
  createPlanAndExecuteTool,
  SUBLOOP_AUTH_DENIED,
  type PlanExecCheckpoint,
  createCredentialTools,
  hostEnvPromptLine,
  matchBarriers,
  type BarrierMatch,
  type MiniLoopLLMClient,
  type MiniLoopLLMResponse,
  type MiniLoopMessage,
  type ReasoningConfig,
} from '@agent/tools';
import {
  openMemoryDb,
  resolveDefaultMemoryPath,
  migrateLegacyMemoryDb,
  SessionExtractor,
  SessionReflector,
  SessionPursuitExtractor,
  SessionDriveReflector,
  SelfReflector,
  Compactor,
  importSkills,
  startScheduler,
  createMemoryTools,
  createPushTools,
  createResearchTools,
  researchGrantAudience,
  createTaskModeTools,
  createPlanTools,
  InMemoryTaskModeStore,
  loadConstitution,
  BOOTSTRAP_ROOT_PURSUIT_ID,
  DEFAULT_CONSTITUTION_VALUES,
  DEFAULT_IDENTITY_SELF_DESCRIPTION,
  DEFAULT_CONSTITUTION_RED_LINES,
  parseCompass,
  renderCompassForPrompt,
  reconcileCompassPursuits,
  compassPursuitId,
  type CompassConfig,
  TsDriveRuntime,
  TsTaskCommitmentDrive,
  startAutonomousLoop,
  StandardExecutor,
  DEFAULT_TOOL_WHITELIST,
  GapDriver,
  CuriosityDriver,
  DEFAULT_CURIOSITY_CONFIG,
  PursuitDriver,
  DEFAULT_PURSUIT_CONFIG,
  collectK7BridgeInitiatives,
  pursuitProgressWriter,
  SkillRepairDriver,
  skillRevisionWriter,
  isRepairCandidate,
  ensureK8DriveConfigs,
  readK8DriverCooldowns,
  k8DriveOutcomeInput,
  runSelfObservations,
  listSelfObservations,
  proposeValueAnnotationsFromObservations,
  ConstitutionProposalStore,
  approveAndApply,
  renderProposalCard,
  parsePursuitTargetRef,
  DEFAULT_RESEARCH_GRANT_TTL_MS,
  FetchedResourceStore,
  runMetaConfigObserver,
  runBugDetector,
  countSameRootCauseFailures,
  groupFailures,
  isResearchTool,
  hasResearchCallInTurn,
  buildResearchReminder,
  type AutonomousLoopHandle,
  type ToolRunner,
  type ToolRunResult,
  type InterruptSink,
  type HonestyEvaluation,
  verifySelfSummaryIntegrity,
  evaluateEmptyConclusion,
  evaluateOutputFormat,
  type ExtractorLlmClient,
  type Fact,
  type FiredDrive,
  type RecentMessage,
  type Schedule,
  type TsToolCallSummary,
} from '@agent/memory';
import type { Tool } from '@agent/policy';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname as pathDirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

// __dirname does not exist under ESM; manually reconstruct the directory of this module for bundled-skill path resolution.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
import { createLLMAdapter, ContextTooLargeError, type NativeMessage, type LLMResponse } from './llm-adapter.js';
import { registerMainLLM, renderQuestion, parseQuestionAnswer, callAuxLLM, isAuxLLMConfigured, type AuxLLMRequest } from '@agent/tools';
import { loadMcpConfig, McpSupervisor, type McpServerStatus } from '@agent/mcp';
import {
  truncateToolResultContent,
  evictOldToolResults,
  evictForEmergency,
  estimateTotalTokens,
  DEFAULTS as BUDGET,
} from './message-budget.js';
import {
  GLOBAL_TIMELINE_SESSION_ID,
  TimelineRetriever,
  startIdleConsolidator,
  signalState,
  computeServiceDormancy,
  InterruptMapper,
  detectTimeRetrospectiveQuery,
} from '@agent/memory';
import {
  assessEvidenceLevel,
  evaluateHonesty,
  detectHalfFinishedTurn,
  findCompletionClaim,
  findRunPromise,
  findActionAnnouncement,
  isStrictFormalVerificationCommand,
  turnDidExecute,
  renderSkillOffer,
} from '@agent/memory';
import { honestySessionStore } from './honesty_session_state.js';
import { classifyAuthIntent } from './auth_intent.js';
import { classifyExploreControlReply, resolveExploreTarget } from './explore_control.js';
import { judgeRun, type JudgeToolRecord } from './learning_judge.js';
import {
  extractScheduleIdFromSession,
  utcDateString,
  summarizeTurnTrace,
  renderScheduleOutcomesSection,
  type ToolCallTrace,
} from '@agent/memory';
import { extractFailureSignature } from '@agent/memory';
import { detectRecurringUserPatterns } from '@agent/memory';
import { reconcilePredictiveWakeups } from '@agent/memory';
import {
  buildUserPatternObservationSection,
  detectPatternConfirmation,
  listPendingPatterns,
  markPatternStatus,
  savePatternCandidate,
} from './user_pattern_inject.js';
// 2026-05-29 soft-disable Rust: interrupt broadcast pipe replaced with pure-TS stand-in (see interrupt_channel.ts).
// Production no longer has a runtime dependency on @agent/node; Rust kernel is kept in the repo for future untrusted-sandbox use.
import { interruptChannelJs, type JsInterruptController } from './interrupt_channel.js';
import { InterruptDrainer } from './interrupt_drainer.js';
import { runInTurnContext, currentSessionId, currentTurnStatus } from './channels/turn_context.js';
import {
  autoClassify as autoClassifyTaskMode,
  quickSignatureHash as quickTaskSignatureHash,
  slowSessionAtTaskBoundary,
} from './task_mode_classifier.js';
import {
  INTERNAL_CORRECTION_FOOTER,
  INTERNAL_CORRECTION_FOOTER_NL,
  isInternalDirective,
  markInternalDirective,
} from './internal_correction.js';
import {
  classifyIntent,
  planRouteWantsSlow,
  directRouteWantsFast,
  buildDeepExploreNudge,
  classifyExploreAskReply,
  deepExploreForceStartEnabled,
  shouldForceDeepExploreStart,
  buildForceStartInput,
  messageIsSelfContainedGoal,
  deepExploreRouteTier,
  buildDeepExploreAskText,
  isSelfReferentialMetaQuestion,
  type IntentDecision,
} from './intent_router.js';
import { looksLikeCleanupIntent } from './intent_router.js';
import {
  extractCleanupTargets,
  matchesCleanupTarget,
  cleanupHttpWriteReject,
} from './cleanup_scope.js';
import { replyWithMediaTool } from './tools/reply_with_media.js';
import { setConscienceLlm } from './conscience_gate.js';
import {
  recordControllerFire,
  setControllerMetrics,
  logRegisteredControllers,
} from './controller_registry.js';
import { writeServiceSkill } from './service_skill.js';
import { findSpecForHost, findServiceSkillForText, specHostDriftGuard } from './service_spec_registry.js';
import { specBodyGuardReject, specRequestGuard, specCompileEnabled } from './spec_compile.js';
import { createAutoAdvanceLoop } from './deep_explore_autoadvance.js';
import { createFollowUpLoop } from './deep_explore_followup.js';
import { semanticToolPhrase, semanticToolFailPhrase, summarizingPhrase, type PhraseLang } from './channel_phrases.js';
import { wrapSkillToolWithReload } from './skill_install_wrapper.js';
import { recallRelevanceEnabled, selectRelevantSkills, selectRelevantSkillsDetailed } from './skill_recall.js';
import { recentAttachments } from './channels/recent_attachments.js';
import { persistToolResultIfFetched, parseWebFetchOutput } from './fetched_resources_hook.js';
import { planLoopEnabled, runPlanExecuteLoop } from './plan_execute_loop.js';
import {
  detectUnclosedQuestion,
  isConversationOpener,
  findLastAssistantText,
  findLastUserText,
  renderBindingContext,
  renderAskGuardRejection,
} from './short_answer_binding.js';
import { buildRoutingInjection } from './routing_inject.js';
import { renderLearningStats } from './learning_stats.js';
import {
  buildFailureRecoveryInjection,
  detectUserDissatisfaction,
} from './failure_recovery_inject.js';
import {
  isPendingAuthExpired,
  PENDING_AUTH_TTL_MS,
  WORKFLOW_GRANT_TTL_MS,
} from './auth-continuation.js';
import {
  detectInTurnFailurePattern,
  isMechanicalFailure,
  buildMechanicalFixReminder,
  authoringCheatsheet,
  classifyRepairTransition,
  type InTurnToolRecord,
} from './in_turn_reflection.js';
import {
  attemptMechanicalRepair,
  classifyRecurrence,
  mechanicalRepairEnabled,
  recurrenceMetricKey,
  repairLedgerRows,
  renderRepairNotice,
} from './mechanical_repair.js';
import { scheduledTurnMadeProgress } from './schedule_progress.js';
import { maybeRunReflection } from './reflection_runner.js';
import { selectSkillsByAux } from './skill_relevance_llm.js';
import { distillMechanicalFix, learnedCheatsheet } from './mechanical_fix_learning.js';
import {
  buildAutonomousProgressInjection,
  buildK7BridgeReviewSection,
  buildResearchPendingGrantSection,
  buildReasoningProgressSection,
} from './autonomous_progress_inject.js';
import { computeFrontier, createDeepExploreTool } from './deep_explore.js';
import { selectSkillsToForget } from './forget_skill.js';
import {
  classifyGrantReply,
  renderResearchGrantPrompt,
  reconstructDmSessionId,
  decideResearchGrantAction,
  localWorkflowGrants,
  type PendingResearchGrant,
} from './research_grant.js';
import { PushDispatcher } from './push/dispatcher.js';
import { serviceDriverTick } from './push/service_driver.js';
import {
  maybeAutoSubscribe,
  classifyPushControlReply,
  parseDmPeerFromSessionId,
} from './push/auto_subscribe.js';
import { currentTraitProfile, traitsLiveEnabled } from './trait_profile.js';
import {
  buildSelfhoodStatus,
  renderSelfhoodStatusText,
  isAutonomyStatusCommand,
  classifyProposalReply,
} from './autonomy_status.js';
import { recordAutonomyReach, autonomyReachSummary, renderAutonomyReach } from './autonomy_reach.js';
import {
  computeHealthRatios,
  renderHealthReport,
  shouldSendHealthReport,
  recordJudgeVerdict,
  dayCount,
  shouldSkipHealthSend,
  nextHealthSendStamp,
  HEALTH_SEND_MAX_ATTEMPTS_PER_DAY,
  type HealthSendStamp,
} from './health_report.js';
import {
  buildIntegrityChecks,
  runIntegrityChecks,
  renderIntegrityReport,
  type IntegrityReport,
} from './referential_integrity.js';
import { findPushChannel, describePushChannelMiss } from './push/channel.js';
import {
  renderCapabilityManifest,
  renderCapabilityDetail,
  capabilityManifestInjectEnabled,
  type CapabilityState,
} from './capability_manifest.js';

/** WS4 (selfhood_closure) kill switch: PHILONT_SELF_OBSERVATIONS=0/off/false/no disables. */
function selfObservationsEnabled(): boolean {
  const v = (process.env.PHILONT_SELF_OBSERVATIONS ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Auth-exempt tool calls (2026-07-09): deep_explore MANAGEMENT actions are read-only or stop/close
 * the agent's own reasoning session — no external side effect, no new spend. Requiring an "ok" to
 * CLOSE a session was pure friction (prod: 关闭会话 → auth_pending → ok). Spending actions
 * (start/continue/discover) and auto_on (enables background spend) keep the normal auth path.
 */
const DEEP_EXPLORE_MGMT_ACTIONS = new Set(['list', 'status', 'finalize', 'abandon', 'auto_off']);
function isAuthExemptManagementCall(call: { name: string; input: unknown }): boolean {
  if (call.name !== 'deep_explore') return false;
  const action = (call.input as { action?: unknown } | null)?.action;
  return typeof action === 'string' && DEEP_EXPLORE_MGMT_ACTIONS.has(action);
}

/** WS6: sessions already checked for first-contact push auto-subscribe (one store read per session). */
const autoSubscribeCheckedSessions = new Set<string>();

/** Ask-tier deep_explore routing (2026-07-09): the pending question per session — the goal we
 *  offered to deep-explore, awaiting the owner's 进/直接 reply. TTL'd; one entry per session. */
const pendingExploreAsk = new Map<string, { goal: string; decision: IntentDecision; ts: number; decisionId?: string }>();
const EXPLORE_ASK_TTL_MS = 10 * 60_000;

/**
 * Intent decision carried across a pending-auth RESUME (prod bug 2026-07-12).
 *
 * The intent router is gated on `!pending` — correctly, since re-classifying the bare "ok" that answers
 * an auth card would yield a garbage `direct` route. But that left signalBus.intentDecision NULL on the
 * resumed turn, and shouldForceDeepExploreStart bails on `!opts.decision` — so force-start could never
 * fire on a resume. The trap: any deep_explore-routed task whose model reaches for an EXECUTE tool first
 * (pariGp / shell / writeFile — i.e. exactly what a math task does) hits the auth card BEFORE ever
 * emitting the flat text response that force-start evaluates on. Observed: "我希望你能独立提出一个新的
 * 数学猜想" routed deep_explore conf=0.95, grabbed pariGp, auth-prompted, and on resume the route was
 * gone → the whole 6-minute turn ran flat pariGp/shell with no engine, then fabricated a "Conjecture 1
 * disproved" claim that the honesty gate had to catch.
 *
 * Fix: stash the ORIGINAL message's decision/goal/depth-signal when the router runs, and restore it on
 * the resume instead of re-classifying "ok". Mirrors how pendingExploreAsk carries state across the
 * ask-tier reply. TTL matches the auth grant window (30 min) — a stale approval is not this turn's route.
 */
const carriedIntent = new Map<
  string,
  { decision: IntentDecision | null; selfReferentialMeta: boolean; goal: string; ts: number }
>();
const INTENT_CARRY_TTL_MS = 30 * 60_000;
import {
  resolveAutonomousBudgetCaps,
  describeBudgetCapsOverrides,
} from './autonomous_budget_env.js';
import {
  sanitizeToolInput,
  sanitizeAssistantMessageBlocks,
  validateRequiredToolInput,
} from './sanitize_tool_input.js';
import { renderDeterministicMaxIterSummary } from './max_iter_summary.js';
import { deleteContinuation, loadContinuations, saveContinuation } from './continuation_store.js';
import { summarizeToolInputForLog } from './tool_log_summary.js';
import {
  PendingDecisionBook,
  routeReply,
  needsVerdict,
  renderAmbiguityPrompt,
  renderNeedsAddressPrompt,
  renderVerdictPrompt,
  renderPendingTail,
  type PendingDecision,
} from './pending_decisions.js';
import { safeSessionId } from './safe_session_id.js';
import {
  computeViability,
  viabilityActuatorRelevant,
  buildViabilityDirective,
  isStopVerdict,
  CONTINUATION_PITCH_RE,
  VIABILITY_ACCEPT_RE,
  VIABILITY_CONTINUE_RE,
  decideTurnAnchors,
} from './viability_gate.js';
import {
  evaluateClaimGrounding,
  isGroundingFire,
  type ClaimGroundingFinding,
} from './claim_grounding.js';
import { detectHandRolledParser, buildSkillReflexNudge } from './skill_reflex.js';
import {
  resolveResponseLanguage,
  resolvePhraseLang,
  buildLanguageDirective,
  observeUserLanguage,
  setUserLocaleProvider,
  currentPhraseLang,
} from './response_language.js';

const llm = createLLMAdapter();

// Register the main model caller as the auxiliary LLM client for @agent/tools.
// When AUX_LLM_BASE_URL/AUX_LLM_API_KEY/AUX_LLM_MODEL env vars are not configured,
// callAuxLLM inside agent-tools (WebFetch distillation, other features) falls back here.
//
// Note: LLMAdapter.send does not distinguish system/user roles; it prepends the system content to the user content.
// For cases requiring a dedicated system slot, configure AUX_LLM_* to call a small model directly.
registerMainLLM(async (req: AuxLLMRequest) => {
  const userContent = req.system ? `${req.system}\n\n${req.user}` : req.user;
  const messages: NativeMessage[] = [{ role: 'user', content: userContent }];
  const resp = await llm.send(messages);
  if (resp.type === 'text') return resp.content;
  // Aux LLM calls do not pass tools; tool calls should never appear in theory.
  // If they do, treat stop reason as empty so callAuxLLM throws invalid_response and the caller decides how to degrade.
  return '';
});

// 2026-05-13: print aux LLM config state at startup to make it easy to diagnose whether Phase 9.2 is truly active
// (mycox production user complained "set the env but didn't see [plan-aux] log" → usually env was set in the
// shell but not inherited by the server process, or base_url was mistyped).
// aux LLM startup config is still usable for callAuxLLM (webFetch distillation, etc.), but the plan protocol path
// was entirely removed in M2 (2026-05-15). PHILONT_PLAN_AUX_LLM env is deprecated.
const _auxConfigured = isAuxLLMConfigured();
console.log(
  `[plan-aux] config: env_aux=${_auxConfigured ? `on (model=${process.env.AUX_LLM_MODEL})` : 'off (fallback to main LLM)'} (plan protocol no longer depends on aux; removed in M2)`,
);

/**
 * Format a tool execution result into a tool_result text the LLM can clearly read.
 *
 * Key invariant: the LLM must be able to tell immediately from the content prefix whether the tool succeeded or failed.
 * The old version used only a weak `Error: ${e}` prefix, and e.stderr was often empty, causing failures to look like
 * successes. The new version enforces ✓ / ⚠ visually distinct prefixes; failures always include the reason.
 */
function formatToolResultContent(result: { success: boolean; output?: string; error?: string }): string {
  if (result.success) {
    const body = result.output ?? '';
    return body.length > 0 ? `✓ TOOL OK\n${body}` : '✓ TOOL OK\n(no output)';
  }
  const why = result.error?.trim() || '(no error message)';
  const stdoutTail = result.output?.trim();
  const tail = stdoutTail ? `\nSTDOUT (partial):\n${stdoutTail}` : '';
  return `⚠ TOOL FAILED — ${why}${tail}`;
}

/**
 * Pre-invocation line formatter used by onDelta.
 *
 * Previously only emitted `[calling: shell]`; seeing 10 identical lines users had no way to tell if the LLM was retrying the same command.
 * Now extracts key parameters by tool type into a single line for real-time user inspection:
 *   - shell: `[shell] $ <first 200 chars of command>`
 *   - writeFile / patch / readFile / glob / grep: extracts path / pattern
 *   - others: `[<name>] <first 150 chars of input JSON>`
 *
 * Length limit is built in to prevent large inputs (e.g. writing a large text file) from flooding the frontend.
 */
function summarizeToolInvocation(name: string, input: Record<string, unknown>): string {
  const trim1 = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n) + '…' : s;

  if (name === 'shell' && typeof input.command === 'string') {
    const oneLine = input.command.replace(/\s*\n\s*/g, ' ↵ ');
    return `[shell] $ ${trim1(oneLine, 220)}`;
  }
  if ((name === 'writeFile' || name === 'patch' || name === 'jsonPatch') &&
      typeof input.path === 'string') {
    return `[${name}] ${input.path}`;
  }
  if (name === 'readFile' && typeof input.path === 'string') {
    return `[readFile] ${input.path}`;
  }
  if (name === 'glob' && typeof input.pattern === 'string') {
    return `[glob] ${input.pattern}`;
  }
  if (name === 'grep' && typeof input.pattern === 'string') {
    const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `[grep] /${trim1(input.pattern, 80)}/${path}`;
  }
  if (name === 'webFetch' && typeof input.url === 'string') {
    return `[webFetch] ${trim1(input.url, 160)}`;
  }
  if (name === 'webSearch' && typeof input.query === 'string') {
    return `[webSearch] ${trim1(input.query, 120)}`;
  }
  if ((name === 'downloadFile') && typeof input.url === 'string') {
    const dst = typeof input.path === 'string' ? ` → ${input.path}` : '';
    return `[downloadFile] ${trim1(input.url, 120)}${dst}`;
  }
  if (name === 'process' && typeof input.action === 'string') {
    const tgt = typeof input.target === 'string' ? ` ${input.target}` : '';
    return `[process] ${input.action}${tgt}`;
  }
  // Generic fallback: tool name + first 150 chars of input JSON
  let inputStr = '';
  try {
    inputStr = JSON.stringify(input);
  } catch {
    inputStr = '<unserializable>';
  }
  return `[${name}] ${trim1(inputStr, 150)}`;
}

/**
 * Post-invocation one-line result summary used by onDelta.
 *   - Success: `  ✓ <first N chars of output, newlines replaced with ↵>` (empty output → just `  ✓`)
 *   - Failure: `  ⚠ <first N chars of error>`
 * 200-char limit — much shorter than what the LLM receives; enough to judge success/failure/current action.
 */
function summarizeToolResult(result: { success: boolean; output?: string; error?: string }): string {
  const trim1 = (s: string, n: number): string =>
    s.length > n ? s.slice(0, n) + '…' : s;
  const oneLine = (s: string): string => s.trim().replace(/\s*\n\s*/g, ' ↵ ');

  if (result.success) {
    const body = oneLine(result.output ?? '');
    return body ? `  ✓ ${trim1(body, 200)}` : '  ✓';
  }
  const why = oneLine(result.error ?? '(no error)');
  return `  ⚠ ${trim1(why, 200)}`;
}

/**
 * Collect all tool_results from the tail of messages in reverse order for the current turn, **including tool name + content**.
 * "Current turn" boundary = the most recent user message with string content (the original user input,
 * not the tool_result array form).
 *
 * Algorithm: first scan all messages in the current turn to build a tool_use_id → toolName map,
 *       then output (toolName, content) in chronological order. When tool_use_id cannot be matched,
 *       toolName is left empty (affects verify determination but not success/failure counting).
 *
 * Used by HonestyGate: success/failure markers via ✓/⚠ prefixes, verify-before-claim via toolName.
 *
 * Exported for testing only.
 */
/**
 * Push a mid-turn gate directive. The mark is what keeps the NEXT gate in this turn from reading an
 * empty tool ledger — see INTERNAL_DIRECTIVE_MARK. Every gate that regenerates must use this rather than
 * pushing a bare user message.
 */
function pushGateDirective(messages: NativeMessage[], content: string): void {
  messages.push({ role: 'user', content: markInternalDirective(content) });
}

export function extractRecentToolResults(
  messages: NativeMessage[],
): Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }> {
  // Find the start of the current turn (scan backwards from tail for the most recent string-content user
  // message). OUR OWN mid-turn directives are skipped: they go in the user slot because that is the only
  // slot a mid-turn instruction fits, and treating one as the boundary empties the ledger for every gate
  // that runs after it. See INTERNAL_DIRECTIVE_MARK for the production trace.
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && !isInternalDirective(m.content)) {
      turnStart = i + 1; // current turn starts immediately after this user message
      break;
    }
  }

  // Scan current-turn messages to build id→{name, input} map (P0.3: include input as well,
  //   so HonestyGate can identify shell write commands)
  const idToToolInfo = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && (block as any).type === 'tool_use') {
        const id = (block as any).id;
        const name = (block as any).name;
        const input = (block as any).input;
        if (typeof id === 'string' && typeof name === 'string') {
          idToToolInfo.set(id, {
            name,
            input: (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
          });
        }
      }
    }
  }

  // Collect tool_result in chronological order
  const out: Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }> = [];
  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block && typeof block === 'object' && (block as any).type === 'tool_result') {
        const id = (block as any).tool_use_id;
        const info = (typeof id === 'string' && idToToolInfo.get(id)) || null;
        const toolName = info?.name ?? '';
        const toolInput = info?.input;
        const c = (block as any).content;
        if (typeof c === 'string') {
          out.push({ toolName, content: c, toolInput });
        } else if (Array.isArray(c)) {
          for (const sub of c) {
            if (sub && typeof sub === 'object' && (sub as any).type === 'text' && typeof (sub as any).text === 'string') {
              out.push({ toolName, content: (sub as any).text, toolInput });
            }
          }
        }
      }
    }
  }
  return out;
}

// ── Memory layer initialization ──────────────────────────────────────────────────────────────
// Default path changed from ./memory.sqlite to ~/.philont/memory/memory.sqlite.
// If the user has not explicitly set MEMORY_DB_PATH, migrate the old DB under CWD (if present);
// when a path is explicitly configured, no automatic migration is triggered — configuration is fully respected.
const MEMORY_DB_PATH = (() => {
  if (process.env.MEMORY_DB_PATH) return process.env.MEMORY_DB_PATH;
  const target = resolveDefaultMemoryPath();
  migrateLegacyMemoryDb(target);
  return target;
})();

export const memory = openMemoryDb(MEMORY_DB_PATH, {
  backup: {
    intervalMs: Number(process.env.MEMORY_BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000,
    retain: Number(process.env.MEMORY_BACKUP_RETAIN) || 28,
    // dir defaults to <dbDir>/backups
  },
});

// ── compass.md — the owner-authored source that orients the intrinsic drives + declares the self-drive's
// focus (see agent-memory/src/compass.ts).
//
// Location: philont's OWN install directory (next to the tracked compass.example.md), NOT the data dir —
// there is always an initialized compass. The active compass.md is git-ignored and, on first start, copied
// from compass.example.md, so `git pull` never clobbers the owner's edits (or Phase 2's learned updates).
// PHILONT_COMPASS_PATH overrides the location.
function resolveCompassPaths(): { active: string; example: string | null } {
  if (process.env.PHILONT_COMPASS_PATH) {
    return { active: process.env.PHILONT_COMPASS_PATH, example: null };
  }
  // Walk up from cwd (server is started from within the install tree) to the dir holding compass.example.md.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const ex = pathJoin(dir, 'compass.example.md');
    if (existsSync(ex)) return { active: pathJoin(dir, 'compass.md'), example: ex };
    const up = pathDirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Fallback: alongside the DB (keeps working even if the example can't be located).
  return { active: pathJoin(pathDirname(MEMORY_DB_PATH), 'compass.md'), example: null };
}

let loadedCompass: CompassConfig | null = null;
try {
  const { active: COMPASS_PATH, example } = resolveCompassPaths();
  // First-run init: no active compass yet → seed it from the shipped template so there is always one.
  if (!existsSync(COMPASS_PATH) && example && existsSync(example)) {
    try {
      copyFileSync(example, COMPASS_PATH);
      console.log(`[compass] initialized ${COMPASS_PATH} from ${example} (first run) — edit it to make it yours`);
    } catch (e) {
      console.warn('[compass] could not initialize from the template', e);
    }
  }
  if (existsSync(COMPASS_PATH)) {
    loadedCompass = parseCompass(readFileSync(COMPASS_PATH, 'utf8'));
    console.log(
      `[compass] loaded ${COMPASS_PATH}: ${loadedCompass?.focus.length ?? 0} focus area(s), ` +
        `drives=[${Object.keys(loadedCompass?.drives ?? {}).join(',') || 'none'}]`,
    );
  } else {
    console.log(`[compass] none at ${COMPASS_PATH} — neutral defaults (drives auto-tune unbounded, no declared focus)`);
  }
} catch (e) {
  console.warn('[compass] failed to load, ignoring', e);
}
/** The owner's compass (null when there is no compass.md). */
export function currentCompass(): CompassConfig | null {
  return loadedCompass;
}

// Focus → pursuits (Phase 1b): seed the compass focus areas as pursuit rows so BOTH self-drive channels
// anchor to them — the in-turn drives (read active pursuits every user turn → proactive DURING work) and the
// background autonomous loop (curiosity/pursuit drivers → work between turns). Idempotent (deterministic
// compass:<slug> ids) + reconciling: a focus removed from the compass archives its pursuit; a stake edit
// syncs. Runs even when the compass is null, so removing compass.md cleans up its seeded pursuits.
try {
  const existing = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID).map((p) => ({
    id: p.id,
    origin: p.origin,
    stakeWeight: p.stakeWeight,
  }));
  const plan = reconcileCompassPursuits(loadedCompass, existing);
  for (const d of plan.create) {
    memory.pursuits.createChild({
      parentPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
      id: d.id,
      title: d.title,
      intent: d.intent,
      stakeWeight: d.stakeWeight,
      origin: 'compass',
      status: 'active',
      // A focus with no open question is inert — no driver can advance it (see focusOpeningQuestion).
      openQuestions: [{ text: d.openingQuestion }],
    });
  }
  for (const u of plan.updateStake) memory.pursuits.setStakeWeight(u.id, u.stakeWeight);
  for (const id of plan.archive) memory.pursuits.updateStatus(id, 'archived');
  // Backfill for rows seeded before focus areas carried an opening question. Such a pursuit is inert —
  // PursuitDriver can only advance one that has an open question or resolutionCriteria — so without this
  // an existing compass focus would stay stuck even after the fix. Idempotent by construction: it only
  // fires when the pursuit has NO open question and NO criteria, which stops being true immediately after.
  // Reconciling against an empty "existing" yields every focus area the compass declares, whether or not
  // it already has a row — which is exactly the set to check.
  const allDesired = reconcileCompassPursuits(loadedCompass, []).create;
  let backfilled = 0;
  for (const desired of allDesired) {
    const existing = memory.pursuits.get(desired.id);
    if (!existing || existing.status !== 'active') continue;
    const hasQuestion = existing.openQuestions.some((q) => q.status === 'open');
    const hasCriteria = (existing.resolutionCriteria ?? '').trim().length > 0;
    if (hasQuestion || hasCriteria) continue;
    memory.pursuits.addOpenQuestion(desired.id, desired.openingQuestion, 0);
    backfilled++;
  }
  if (backfilled > 0) {
    console.log(`[compass] backfilled an opening question onto ${backfilled} inert pursuit(s)`);
  }
  if (plan.create.length || plan.updateStake.length || plan.archive.length) {
    console.log(
      `[compass] pursuits reconciled: +${plan.create.length} created, ` +
        `~${plan.updateStake.length} stake-synced, -${plan.archive.length} archived`,
    );
  }
} catch (e) {
  console.warn('[compass] pursuit reconcile failed, ignoring', e);
}

// Adapt LLM to the ExtractorLlmClient interface
const extractorLlm: ExtractorLlmClient = {
  async complete(prompt: string) {
    const resp = await llm.send([{ role: 'user', content: prompt }]);
    return {
      text: resp.type === 'text' ? resp.content : '',
      tokensUsed: 0, // LLM adapter does not expose token counts; estimation can be added later
    };
  },
};

// Wire the conscience gate's judge LLM (the gate stays a no-op unless PHILONT_CONSCIENCE_GATE is on).
setConscienceLlm(extractorLlm);

// Self-learning Phase 3a: wire the controller registry's persisted fire counter to the MetricsStore
// and log the registered L3-guard controllers so the whole layer is visible as one system at startup.
// Purely observational — the registry sits on no control-flow path.
setControllerMetrics(memory.metrics);
logRegisteredControllers();

// Intrinsic-drive audit log: all cross-session self-domain internal writes (extractor/reflector/compactor)
// are recorded through this AuditLog. SHA-256 chain covers all Internal-origin events.
export const internalAudit = new AuditLog();

// ── Pursuit / Constitution startup: soul identity registration ─────────────────────────
//
// Since v7 the root row of the pursuit table is the agent identity. initSchema inside openMemoryDb()
// already ensures the bootstrap root ("default") exists. Here we read the four constitution fields
// of root, compute SHA-256, and record a constitution_load audit event — serving as a soul integrity
// credential. Within a session the constitution is treated as frozen; even if the DB is changed externally, the change
// takes effect only after the next restart.
const bootRoot = memory.pursuits.getDefaultRoot();
if (bootRoot) {
  const loaded = loadConstitution(
    memory.pursuits,
    BOOTSTRAP_ROOT_PURSUIT_ID,
    internalAudit,
  );
  console.log(
    `[pursuit] bootstrap root=${bootRoot.id} title="${bootRoot.title}" ` +
      `constitution_hash=${loaded.hash.slice(0, 12)}...`,
  );
} else {
  // Should never reach here — initSchema guarantees the bootstrap root exists
  console.warn(
    '[pursuit] bootstrap root pursuit missing, memory-db init may have failed',
  );
}
/** Exposed for downstream use (future TS-side drive runtime, reflector drive_bounds validation, etc.) */
export const constitution = bootRoot
  ? loadConstitution(memory.pursuits, BOOTSTRAP_ROOT_PURSUIT_ID).fields
  : null;

const extractor = new SessionExtractor(
  extractorLlm,
  memory.facts,
  memory.notes,
  memory.raw,
  {
    timezone: process.env.AGENT_TIMEZONE || 'UTC',
    calendar: memory.calendar,
    auditHook: internalAudit,
  },
);

const reflector = new SessionReflector(
  extractorLlm,
  memory.skills,
  memory.actions,
  memory.raw,
  // facts (WS5): recipe reuse-verification failures write obs.recipe-decay self-observations
  { auditHook: internalAudit, metrics: memory.metrics, facts: memory.facts },
);

// v7: pursuit proposer (shadow state) — at session end, identify unclosed inquiry topics from the conversation
const pursuitExtractor = new SessionPursuitExtractor(
  extractorLlm,
  memory.pursuits,
  memory.raw,
  { auditHook: internalAudit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
);

// WS3 (selfhood_closure): constitution proposals — the agent proposes identity amendments with
// evidence; the OWNER ratifies via decide_constitution_proposal. Red lines are not amendable.
const constitutionProposals = new ConstitutionProposalStore(memory.db);

/** WS3 kill switch (gates the producer + surfacing; the decision tool always works on existing rows). */
function constitutionProposalsEnabled(): boolean {
  const v = (process.env.PHILONT_CONSTITUTION_PROPOSALS ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// v7: drive reflector — scan drive_outcomes to back-fill utility + tune parameters within constitution.driveBounds
const driveReflector = new SessionDriveReflector(
  memory.driveOutcomes,
  memory.driveConfigs,
  memory.pursuits,
  {
    auditHook: internalAudit,
    rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
    // WS3: out-of-bounds tuning attempts become ratifiable proposals instead of audit-only dead ends.
    proposals: constitutionProposalsEnabled() ? constitutionProposals : undefined,
  },
);

// K3: emergent identity reflector — at session end, synthesize skills/pursuits to produce first-person self-description,
// and write to memory_facts['self.*']. Non-reflector paths cannot write; the agent can read.
const selfReflector = new SelfReflector(
  extractorLlm,
  memory.facts,
  memory.skills,
  memory.pursuits,
  memory.actions,
  memory.driveOutcomes,
  { auditHook: internalAudit, rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID },
);

// Referential integrity (2026-07-23). The self.* check below covers ONE reference class; the defects that
// actually cost months — a subscription naming a channel that does not resolve, a DB skill the disk prune
// treats as an orphan — live in the classes nothing checked. See referential_integrity.ts for why a written
// lesson was not enough. Advisory: a broken reference means a feature is silently dead, but refusing to
// boot over it is worse. Runs after the skill/channel registries are populated, hence deferred.
export async function runStartupIntegrityCheck(): Promise<IntegrityReport> {
  let diskNames: string[] = [];
  try {
    diskNames = (await loadSkills(process.cwd(), [bundledSkillsDir])).map((p) => p.name);
  } catch {
    diskNames = [];
  }
  const report = runIntegrityChecks(
    buildIntegrityChecks({
      listSubscriptions: () => memory.pushSubscriptions.listActive().map((s) => ({ channel: s.channel, peer: s.peer })),
      resolvePushChannel: (c) => findPushChannel(c),
      describePushChannelMiss,
      listExternalSkills: () => memory.skills.listExternalSkills().map((s) => ({ name: s.name, source: s.source })),
      listDiskSkillNames: () => diskNames,
      listCompassPursuits: () =>
        memory.pursuits
          .listActive(BOOTSTRAP_ROOT_PURSUIT_ID)
          .filter((p) => p.origin === 'compass')
          .map((p) => ({ id: p.id, title: p.title })),
      compassFocusIds: () => (loadedCompass?.focus ?? []).map((f) => compassPursuitId(f.name)),
    }),
  );
  for (const line of renderIntegrityReport(report)) {
    if (line.includes('⛔') || line.includes('⚠')) console.warn(line);
    else console.log(line);
  }
  lastIntegrityReport = report;
  return report;
}

/**
 * The daily self-check, delivered to the OWNER.
 *
 * This is the piece the console instrumentation could never be. Every number below was already being
 * computed and written to a log; the log was read by nobody for months while five subsystems sat dead.
 * See health_report.ts — the design property is not "report health", it is that the report goes to the
 * one recipient who cannot silently drop it.
 *
 * Sent only when something is actually wrong. A report that arrives every day is one a person learns to
 * skip, which is precisely how the console stopped working.
 */
export async function runDailyHealthCheck(force = false): Promise<string | null> {
  try {
    // Once per CALENDAR DAY, persisted. The first version fired 8s after every boot plus every 24h of
    // uptime, so three restarts in one morning meant three attempts — the second of which was correctly
    // swallowed by the generic 4-hour digest rate limiter, turning "daily self-check" into "whatever
    // survives the limiter after a restart". A cadence that depends on process lifetime is not a cadence.
    const today = utcDateString(Date.now());
    const stampFact = memory.facts.getFact('system', 'health_selfcheck_last_ymd');
    const stamp = (stampFact?.value ?? null) as HealthSendStamp | null;
    if (!force && shouldSkipHealthSend(stamp, today)) {
      console.log(`[health] daily self-check already handled today (${today}) — not repeating on restart`);
      return null;
    }
    const lang = currentPhraseLang() === 'en' ? 'en' : 'zh';
    // Day-keyed metrics, not the in-memory windows: the boot-time check runs 8s after start, when every
    // in-memory window is empty — which silently deleted the judge and autonomy lines from every
    // boot-time report. See dayCount in health_report.ts.
    const metricsSnap = memory.metrics.snapshot();
    const rules = memory.routingRules.listAll();
    const compassFocus = loadedCompass?.focus ?? [];
    const compassPursuits = memory.pursuits
      .listActive(BOOTSTRAP_ROOT_PURSUIT_ID)
      .filter((p) => p.origin === 'compass');
    const dayAgo = Date.now() - 86_400_000;
    const subs = memory.pushSubscriptions.listActive();

    const ratios = computeHealthRatios(
      {
        autonomy: {
          found: dayCount(metricsSnap, 'autonomy.day.found', today),
          eligible: dayCount(metricsSnap, 'autonomy.day.eligible', today),
        },
        judge: (() => {
          const na = dayCount(metricsSnap, 'judge.day.na', today);
          return {
            verified: dayCount(metricsSnap, 'judge.day.verified', today),
            // Turns that HAD a checkable goal. See judgeWindowTally for why the split exists.
            total: Math.max(0, dayCount(metricsSnap, 'judge.day.total', today) - na),
            notApplicable: na,
          };
        })(),
        routingRules: {
          validated: rules.filter((r) => r.confidence === 'validated').length,
          active: rules.filter((r) => r.confidence !== 'retired').length,
          retired: rules.filter((r) => r.confidence === 'retired').length,
        },
        // The ratio that would have shown the frozen skill ladder on day one. It was defined in
        // health_report.ts and then not passed in — an unused field is a check that does not exist.
        // Reflection drafts only, matching both the exploration slot's supply and the mint bound — disk
        // skills also sit at maturity 'draft' and would inflate the denominator with rows the exploration
        // slot never offers (the same overstatement class as the retired-rules denominator).
        skills: memory.skills.reflectionDraftStats(),
        focus: {
          // "Advanced" means touched in the last day — the same lastTouchedAt the dormancy branch reads,
          // so the report cannot disagree with the mechanism it is reporting on.
          advanced: compassPursuits.filter((p) => (p.lastTouchedAt ?? 0) >= dayAgo).length,
          declared: compassFocus.length,
        },
        push: (() => {
          // Deliverable = resolvable AND not observably failing. A channel whose every send today failed
          // is down whatever the registry says — that is precisely the state the WeChat iLink session was
          // in for twelve hours while this line reported 1/1.
          const failingToday = subs.filter(
            (sub) =>
              findPushChannel(sub.channel) &&
              dayCount(metricsSnap, `push.day.fail.${sub.channel}`, today) > 0 &&
              dayCount(metricsSnap, `push.day.ok.${sub.channel}`, today) === 0,
          ).length;
          return {
            deliverable: subs.filter((sub) => findPushChannel(sub.channel)).length - failingToday,
            active: subs.length,
            failingToday,
          };
        })(),
      },
      lang,
    );
    const broken = (lastIntegrityReport?.violations ?? []).map((v) => ({
      check: v.check,
      ref: v.ref,
      consequence: v.consequence,
    }));

    const expiredDeferred = dayCount(metricsSnap, 'push.deferred_expired.day', today);

    if (!shouldSendHealthReport(ratios, broken) && expiredDeferred === 0) {
      console.log('[health] daily self-check: nothing degenerate — not interrupting the owner');
      return null;
    }
    let text = renderHealthReport(ratios, broken, lang);
    if (expiredDeferred > 0) {
      text += lang === 'en'
        ? `\n· Proactive delivery: ${expiredDeferred} queued notice(s) expired before reaching you.`
        : `\n· 主动送达:${expiredDeferred} 条排队通知在送达你之前已过期。`;
    }
    console.log(`[health] daily self-check reporting to owner:\n${text}`);
    for (const [, send] of webuiClients) {
      try { send({ type: 'finding', text }); } catch { /* one dead client must not stop the rest */ }
    }
    // The stamp records the OUTCOME. The first version stamped before dispatch so a failure could not
    // retry-hammer — and the boot-time send then raced the WeChat gateway warmup, failed with "prepare
    // failed" 8s after start, and the stamp swallowed the report for the day. Now: delivered → final for
    // today; failed → retryable (next boot / 24h tick, paced by the dispatcher's own digest limiter) up to
    // a small daily cap. See shouldSkipHealthSend.
    const dispatch = await pushDispatcher
      .enqueue({ severity: 'digest', kind: 'health_selfcheck', targetRef: 'health:daily', text })
      .catch((e) => {
        console.warn('[health] push dispatch threw', e);
        return { delivered: 0, deferred: 0 } as { delivered: number; deferred: number };
      });
    const wasDeferred = (dispatch?.deferred ?? 0) > 0;
    const newStamp = nextHealthSendStamp(stamp, today, (dispatch?.delivered ?? 0) > 0, wasDeferred);
    memory.facts.storeFact({
      namespace: 'system',
      key: 'health_selfcheck_last_ymd',
      value: newStamp,
      confidence: 1,
    });
    // In-process retry on failed delivery. The boot-time send races the WeChat gateway warmup — the same
    // +8s send succeeded at 11:36 and failed at 16:53 with "prepare failed" — and without this, a boot-time
    // failure waits for the next restart or the 24h tick. Twenty minutes is comfortably past warmup; the
    // attempt cap in shouldSkipHealthSend bounds the total, and the dispatcher's digest limiter is not an
    // obstacle because markDigestSent advances only on SUCCESS.
    if (!newStamp.delivered && !newStamp.deferred && newStamp.attempts < HEALTH_SEND_MAX_ATTEMPTS_PER_DAY) {
      if (healthRetryTimer) clearTimeout(healthRetryTimer);
      healthRetryTimer = setTimeout(() => {
        healthRetryTimer = null;
        void runDailyHealthCheck().catch(() => {});
      }, 20 * 60_000);
      healthRetryTimer.unref?.();
      console.log(`[health] delivery failed (attempt ${newStamp.attempts}) — retrying in 20min`);
    }
    return text;
  } catch (e) {
    // Reporting on health must never be the thing that breaks.
    console.warn('[health] daily self-check failed, ignored', (e as Error)?.message ?? e);
    return null;
  }
}

/** Pending in-process retry for a health report whose delivery failed (see runDailyHealthCheck). */
let healthRetryTimer: NodeJS.Timeout | null = null;

/** Latest startup integrity result, for the owner-facing health report. */
let lastIntegrityReport: IntegrityReport | null = null;
export function getLastIntegrityReport(): IntegrityReport | null {
  return lastIntegrityReport;
}

// K3 cleanup: at startup, verify that sourceRefs in self.summary / strengths / growth_edges
// still reference valid skills / pursuits. High stale rate → asynchronously trigger reflectSelf regeneration,
// without blocking startup. Prevents "ghost references" from being endlessly injected into LLM context.
{
  const integrity = verifySelfSummaryIntegrity({
    facts: memory.facts,
    skills: memory.skills,
    pursuits: memory.pursuits,
  });
  if (integrity.totalRefs === 0) {
    console.log('[self-integrity] no self.* facts to verify (fresh agent or first run)');
  } else {
    console.log(
      `[self-integrity] ${integrity.validRefs}/${integrity.totalRefs} refs valid (score=${integrity.integrityScore.toFixed(2)})`,
    );
    if (integrity.staleRefs.length > 0) {
      console.warn(`[self-integrity] stale refs: ${integrity.staleRefs.join(', ')}`);
    }
  }
  internalAudit.append('self_domain_access', {
    source: 'self_summary_integrity',
    origin: 'Internal',
    toolName: 'startup_check',
    totalRefs: integrity.totalRefs,
    validRefs: integrity.validRefs,
    staleRefs: integrity.staleRefs,
    integrityScore: integrity.integrityScore,
  });
  // Stale rate ≥ 30% (integrityScore < 0.7) → regenerate asynchronously. Fire-and-forget, does not block startup.
  if (integrity.totalRefs > 0 && integrity.integrityScore < 0.7) {
    console.warn(
      `[self-integrity] score=${integrity.integrityScore.toFixed(2)} < 0.7, triggering async reflectSelf`,
    );
    selfReflector.reflect().then(
      (r) => console.log(`[self-integrity] async reflect done: updated=${r.updated} sourceIntegrity=${r.sourceIntegrity?.toFixed(2)}`),
      (e) => console.warn('[self-integrity] async reflect failed:', e),
    );
  }
}

// v7: per-turn drive runtime (TS side) — evaluates drives and injects Internal-origin messages each turn
// within the server's own synchronous chat loop. Attached before/after LLM calls in handleChatSendInner.
//
// Kernel drives (species-level character, every philont agent should mount these):
//   - TaskCommitmentDrive (competitive drive / task commitment)
//   - CuriosityDrive (curiosity)
// More drives can be registered later or dynamically loaded from memory_drive_configs (TS version of DeclarativeEngine).
//
// Note: TsOpenLoopDrive (dangling-question retrieval, ported from Rust) was previously mounted and removed on 2026-05-03 —
// trigger conditions were extremely strict (combined hit rate < 1% of conversations), overlapped with existing K0 timeline recall / K3 pursuits /
// askUserQuestion mechanisms, and the original semantic "user has not replied for a long time" could not cover the more
// realistic "user short-answer treated as new topic by LLM" problem. Maintenance cost > benefit.
//
// maxInjectionsPerTurn=2: up to 2 intrinsic-drive messages may be injected per turn; higher-Utility winner goes first.
const driveRuntime = new TsDriveRuntime(memory.driveOutcomes, {
  rootPursuitId: BOOTSTRAP_ROOT_PURSUIT_ID,
  auditHook: internalAudit,
  maxInjectionsPerTurn: 2,
});
// K2a: competitive drive (kernel character, to be migrated to Rust). Detects the previous-turn "punt task back to user"
// pattern and injects "think of another approach". See kernel_drives.ts.
driveRuntime.register(
  new TsTaskCommitmentDrive('task-commitment', {
    cooldownMs: 90_000,
    minMessageLen: 8,
  }),
);
// Note: K2c TsCuriosityDrive (turn-time "nudge LLM to look it up") was removed on 2026-05-06,
// replaced by the CuriosityDriver in K8 proactivity layer (agent-memory/src/autonomous/) —
// the latter is an idle-time driver that actually runs webSearch / searchNotes, not an injection reminder.
// See startAutonomousLoop below.

const COMPACT_THRESHOLD_TOKENS = Number(process.env.COMPACT_THRESHOLD_TOKENS) || 180_000;
const COMPACT_HARD_THRESHOLD_TOKENS = Number(process.env.COMPACT_HARD_THRESHOLD_TOKENS) || 250_000;
/** A compaction that frees less than this fraction of the context is not worth another LLM call. */
const COMPACT_MIN_GAIN_RATIO = 0.05;
/** Sessions whose current turn has an incompressible tail — skip further compact() attempts. Cleared per turn. */
const incompressibleTurns = new Set<string>();

// Context compactor: summarize the middle segments when the conversation exceeds the threshold
const compactor = new Compactor(extractorLlm, memory.notes, {
  // 2026-05-13: 100K → 180K + add hard-cap 250K safety net + protectLastN 6→10.
  // Background: mycox production observed compression triggering mid tool-loop (107K→24K), summarizing plan_id
  // into the summary; LLM then called plan_update_step from memory and failed 4 times. Fix:
  //   1) Use soft threshold (180K) at turn-entry "quiet period" — not mid plan/tool chain
  //   2) In-turn tool loop only triggers at hard cap (250K) as a safety net against window overflow
  //   3) protectLastN 6→10 gives active plan/tool chain tail more room to avoid compression
  // env overrides still available: COMPACT_THRESHOLD_TOKENS / COMPACT_HARD_THRESHOLD_TOKENS.
  thresholdTokens: COMPACT_THRESHOLD_TOKENS,
  hardThresholdTokens: COMPACT_HARD_THRESHOLD_TOKENS,
  protectFirstN: 2,   // preserve system prompt + first turn
  protectLastN: 10,   // preserve the most recent ~5 conversation turns (gives active plan/tool chain tail room)
}, { auditHook: internalAudit });

// ── K7 interrupt infrastructure (2026-04-27) ─────────────────────────────────────────
// Uses real Rust FFI: JsInterruptController is the napi wrapper of agent-core. mapper fires interrupt
// through it → broadcasts to drainer's 4 callbacks → drainer buffers →
// chat-handler drains during buildMemoryPrefix → outputs to system section (not the user-role slot).
//
// receiver is currently unused (server does not run agent-core's run_agent_loop); kept for future reuse
// when Rust kernel drives are integrated via the same channel pair.
const { controller: interruptController, receiver: _interruptReceiver } = interruptChannelJs();
const interruptDrainer = new InterruptDrainer(interruptController);
const interruptMapper = new InterruptMapper(interruptController, {
  // Default thresholds: NORMAL=0.4 / HIGH=0.7 / CRITICAL=0.9 + hysteresis 0.15 + cooldown 30s
});

// Reader of "last service time" used by idle_consolidator
function lastAssistantTs(): number | null {
  const m = memory.raw.getLastMessageByRole('assistant');
  return m ? m.timestamp : null;
}

/** mapper FireRecord → kind string (for audit / rendering), consistent with the logic inside mapper */
function signalKindForFire(signalName: string, level: 'IDLE' | 'NORMAL' | 'HIGH' | 'CRITICAL'): string {
  if (signalName === 'service_dormancy') return 'BoredomThreshold';
  if (signalName === 'commitment_pressure') {
    return level === 'CRITICAL' || level === 'HIGH' ? 'IdentityThreat' : 'SteerMessage';
  }
  return 'SteerMessage';
}

function levelToSeverityStr(level: 'IDLE' | 'NORMAL' | 'HIGH' | 'CRITICAL'): string {
  return level.toLowerCase();
}

/** Snapshot of all current signals used by mapper.tick */
function collectSignalSnapshot(): { [name: string]: number } {
  const dorm = computeServiceDormancy({
    lastAssistantTs: lastAssistantTs(),
    now: Date.now(),
  });
  return {
    commitment_pressure: signalState.commitmentPressure,
    service_dormancy: dorm.dormancy,
  };
}

// K0.6: idle_consolidator — replaces the old "ws.close → finalizeSession" path.
// A background timer checks idleness (time since the latest message on the raw global timeline); when idle exceeds the threshold
// + new messages accumulated reach minNewMessages → run extractor + reflector + onConsolidate
// hooks (used to attach pursuitExtractor / selfReflector / driveReflector). cursor
// progress is stored in memory_facts['system.last_consolidated_ts'], idempotent across restarts.
const idleConsolidator = startIdleConsolidator({
  raw: memory.raw,
  facts: memory.facts,
  extractor,
  reflector,
  idleThresholdMs: Number(process.env.IDLE_CONSOLIDATE_THRESHOLD_MS) || 5 * 60_000,
  minNewMessages: Number(process.env.IDLE_CONSOLIDATE_MIN_MSGS) || 4,
  tickIntervalMs: Number(process.env.IDLE_CONSOLIDATE_TICK_MS) || 60_000,
  async onConsolidate({ fromTs, toTs }) {
    // K3 self-description reflection: not bounded by time window; synthesizes all skills/pursuits to produce
    try {
      const r = await selfReflector.reflect();
      if (r.updated) {
        console.log(
          `[idle-consolidator] self-reflect: sourceIntegrity=${r.sourceIntegrity.toFixed(2)}`,
        );
      }
    } catch (e) {
      console.error('[idle-consolidator] self-reflect failed', e);
    }
    // pursuit proposal (bounded by time window)
    try {
      const r = await pursuitExtractor.extractFromTimeRange(fromTs, toTs);
      if (r.pursuitsProposed > 0) {
        console.log(`[idle-consolidator] new shadow pursuits: ${r.pursuitsProposed}`);
      }
    } catch (e) {
      console.error('[idle-consolidator] pursuit-extract failed', e);
    }
    // drive reflection (scan unscored outcomes to back-fill utility + tune parameters)
    try {
      const r = await driveReflector.reflect();
      if (r.outcomesScored > 0 || r.driveParamsTuned > 0) {
        console.log(
          `[idle-consolidator] drive-reflect: scored=${r.outcomesScored}, tuned=${r.driveParamsTuned}`,
        );
      }
    } catch (e) {
      console.error('[idle-consolidator] drive-reflect failed', e);
    }
    // WS4 (selfhood_closure): self-observations — pure aggregation over the action/drive ledger
    // into obs.* self facts (evidence refs mandatory). Kill switch PHILONT_SELF_OBSERVATIONS=0.
    if (selfObservationsEnabled()) {
      try {
        const r = runSelfObservations({
          facts: memory.facts,
          actions: memory.actions,
          driveOutcomes: memory.driveOutcomes,
        });
        if (r.written.length > 0 || r.cleared.length > 0) {
          console.log(
            `[idle-consolidator] self-observations: written=[${r.written.join(',')}] cleared=[${r.cleared.join(',')}]`,
          );
        }
        // WS3 producer (b): a tendency that persisted >=14d despite prompt visibility becomes a
        // ratifiable value-annotation proposal (store dedups; rejections suppress 30d).
        if (constitutionProposalsEnabled()) {
          const filed = proposeValueAnnotationsFromObservations(
            memory.facts,
            constitutionProposals,
            BOOTSTRAP_ROOT_PURSUIT_ID,
          );
          if (filed.length > 0) {
            console.log(`[idle-consolidator] value-annotation proposals filed: ${filed.length}`);
          }
        }
      } catch (e) {
        console.error('[idle-consolidator] self-observations failed', e);
      }
    }
    // Tier 2 signal: recompute commitment_pressure during idle period and record audit event
    // making "how many open items the agent has accumulated this week" an observable trace.
    try {
      const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
      const breakdown = signalState.recomputeCommitmentPressure(active, Date.now());
      internalAudit.append('self_domain_write', {
        source: 'signal_recompute',
        origin: 'Internal',
        toolName: 'signal_computed',
        signal: 'commitment_pressure',
        value: breakdown.pressure,
        activeCount: breakdown.activeCount,
        topContributors: breakdown.contributors.slice(0, 3).map((c) => ({
          id: c.pursuitId,
          title: c.title,
          ageH: Math.round(c.ageHours),
          stake: c.stakeWeight,
          contrib: Number(c.contribution.toFixed(3)),
        })),
      });
      if (breakdown.pressure > 0.3) {
        console.log(
          `[signal] commitment_pressure=${breakdown.pressure.toFixed(2)} (${breakdown.activeCount} active)`,
        );
      }
    } catch (e) {
      console.error('[signal] commitment_pressure recompute failed', e);
    }
    // K7.2: aggregate all signals → mapper.tick → fire interrupt to controller →
    // broadcast to drainer. This is the only trigger point for the "hormone → interrupt" chain (during idle).
    try {
      const snapshot = collectSignalSnapshot();
      const fires = interruptMapper.tick(snapshot);
      for (const f of fires) {
        internalAudit.append('self_domain_write', {
          source: 'interrupt_mapper',
          origin: 'Internal',
          toolName: 'signal_threshold_crossed',
          signal: f.signal,
          severity: f.level,
          prevSeverity: f.prevLevel,
          value: f.value,
          firedAtMs: f.firedAtMs,
        });
        console.log(
          `[interrupt] fire ${f.level} on ${f.signal} (value=${f.value.toFixed(2)}, was ${f.prevLevel})`,
        );
        // Seam ①: a CRITICAL/HIGH crossing during idle is the agent's own "I should reach out"
        // signal — route it to an actual outbound message instead of only bucketing for the
        // next-turn prefix (which never fires unless the user speaks first).
        if (f.level === 'CRITICAL' || f.level === 'HIGH') {
          try {
            const text = renderOutreachText(f.signal);
            if (text) emitProactiveOutreach(text, `drive:${f.signal}`, `drive:${f.signal}:${f.level}`);
          } catch (e) {
            console.warn('[outreach] render/emit failed', e);
          }
        }
      }
    } catch (e) {
      console.error('[interrupt] mapper.tick failed', e);
    }
    // 2026-05-06 D.1: routing rule time decay. No activity for 30 days → demote one level; 90 days → retired.
    // Idempotent — multiple ticks within the same idle window will not repeat the demotion (updated_at is already fresh after demotion).
    try {
      const r = memory.routingRules.decayStale(Date.now());
      if (r.demoted > 0 || r.retired > 0) {
        internalAudit.append('self_domain_write', {
          source: 'routing_decay',
          origin: 'Internal',
          toolName: 'routing_rules_decayed',
          demoted: r.demoted,
          retired: r.retired,
        });
        console.log(
          `[routing-decay] demoted=${r.demoted} retired=${r.retired}`,
        );
      }
    } catch (e) {
      console.error('[routing-decay] failed', e);
    }
    // 2026-06-22 instrumentation: log the self-learning report once per UTC day (data to decide
    // keep-vs-simplify). Day-gated via a metric stamp so idle ticks don't spam it. Read-only.
    try {
      const d = new Date();
      const ymd = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      if (memory.metrics.get('stats.last_logged_ymd') !== ymd) {
        memory.metrics.set('stats.last_logged_ymd', ymd);
        console.log('[learning-stats]\n' + renderLearningStats(memory));
      }
    } catch (e) {
      console.error('[learning-stats] failed', e);
    }
    // 2026-05-29 predictive proactive: deadline pursuit → schedule soft wake-up.
    // For active pursuits with a deadline and high enough stake, schedule a one-shot autonomous_turn
    // ahead of the deadline for read-only preparation. Reconcile to desired state (idempotent): create if absent / reschedule if deadline changed
    // / cancel if pursuit closed or stake lowered / sweep orphans. Does not touch interrupts or the turn loop.
    try {
      const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
      const r = reconcilePredictiveWakeups({
        pursuits: active,
        now: Date.now(),
        schedules: memory.schedules,
      });
      if (r.created > 0 || r.updated > 0 || r.cancelled > 0) {
        internalAudit.append('self_domain_write', {
          source: 'predictive_wakeup',
          origin: 'Internal',
          toolName: 'predictive_wakeup_reconciled',
          created: r.created,
          updated: r.updated,
          cancelled: r.cancelled,
        });
        console.log(
          `[predictive-wakeup] created=${r.created} updated=${r.updated} cancelled=${r.cancelled}`,
        );
      }
    } catch (e) {
      console.error('[predictive-wakeup] reconcile failed', e);
    }
    // 2026-05-06 Phase C: ServiceDriver — when the agent has been dormant for a long time and accumulated ≥ N done initiatives,
    // proactively send a digest push to (channel, peer) pairs with opt-in subscriptions.
    // dispatcher internally re-checks enabled / frequency / quiet / dedup; here we only decide "is it worth enqueuing".
    try {
      const r = await serviceDriverTick({
        raw: memory.raw,
        initiatives: autonomousLoop.initiatives,
        dispatcher: pushDispatcher,
        // The digest is the agent speaking first — no user message, nothing to mirror. Tell it the language.
        lang: resolvePhraseLang({ userLocale: readUserLanguage() }),
      });
      if (r.triggered) {
        internalAudit.append('self_domain_write', {
          source: 'service_driver',
          origin: 'Internal',
          toolName: 'service_checkin_enqueued',
          dormantHours: r.dormantHours,
          findings: r.findings,
          dispatchDelivered: r.dispatchDelivered,
          dispatchSkipped: r.dispatchSkipped,
        });
      }
    } catch (e) {
      console.error('[service-driver] tick failed', e);
    }
    // 2026-05-07 path 7: user behavior observation — detect repeated action chains across turns, write candidates to
    // facts.user.patterns, to be rendered in the next user-turn buildMemoryPrefix.
    // Runs at most once every ≥ 24h to prevent noise (each idle tick is 60s, ~1440 ticks/day).
    try {
      const lastTickKey = 'system.user_pattern_last_tick_ts';
      const lastTick = memory.facts.getFact('system', 'user_pattern_last_tick_ts');
      const lastTs = lastTick && typeof (lastTick.value as { ts?: number })?.ts === 'number'
        ? ((lastTick.value as { ts: number }).ts)
        : 0;
      if (Date.now() - lastTs > 24 * 60 * 60 * 1000) {
        const candidates = detectRecurringUserPatterns({
          raw: memory.raw,
          actions: memory.actions,
          windowDays: 30,
          minOccurrences: 3,
        });
        for (const c of candidates) {
          // Skip already confirmed/declined ones
          const existing = memory.facts.getFact('user.patterns', c.signature);
          if (existing) {
            const v = existing.value as { status?: string } | undefined;
            if (v?.status === 'confirmed' || v?.status === 'declined') continue;
          }
          savePatternCandidate(memory.facts, c);
        }
        memory.facts.storeFact({
          namespace: 'system',
          key: 'user_pattern_last_tick_ts',
          value: { ts: Date.now() },
          confidence: 1,
        });
        if (candidates.length > 0) {
          console.log(`[user-pattern] propose ${candidates.length} pending`);
        }
        // expire pending items with no response for 7+ days → 'expired' (avoid long-term accumulation)
        const pending = listPendingPatterns(memory.facts);
        const sevenDaysAgo = Date.now() - 7 * 86400_000;
        for (const p of pending) {
          if (p.proposedAt < sevenDaysAgo) {
            markPatternStatus(memory.facts, p.signature, 'expired');
          }
        }
      }
    } catch (e) {
      console.error('[user-pattern] tick failed', e);
    }

    // 2026-05-12 Phase 8 M3: MetaConfigObserver — scan internalAudit for patterns,
    // automatically write config_rules (provisional). Only proposes when same pattern appears ≥ threshold times; dedup idempotent.
    // env PHILONT_META_OBSERVER=0 to disable. Failures are swallowed in try/catch, main flow unaffected.
    if (process.env.PHILONT_META_OBSERVER !== '0') {
      try {
        const result = runMetaConfigObserver({
          auditEvents: internalAudit.getEvents(),
          configRules: memory.configRules,
        });
        if (result.insertedRuleIds.length > 0) {
          console.log(
            `[meta-config] inserted ${result.insertedRuleIds.length} new provisional rule(s):`,
            result.proposals.map((p) => `${p.pattern}:${p.scope}=${JSON.stringify(p.value)}`),
          );
          internalAudit.append('self_domain_write', {
            source: 'meta_config_observer',
            origin: 'Internal',
            toolName: 'config_rule_proposed',
            insertedCount: result.insertedRuleIds.length,
            skippedExisting: result.skippedExisting,
            proposals: result.proposals.map((p) => ({
              pattern: p.pattern,
              scope: p.scope,
              value: p.value,
              evidence: p.evidence,
            })),
          });
        }
      } catch (e) {
        console.error('[meta-config] observer tick failed', e);
      }
    }

    // 2026-05-12 Phase 8 M4 (= 8B): BugDetector — scan internalAudit for logic-layer bugs,
    // output a precise bug report (file_hint + expected/actual + fix_proposal).
    // Does not write code; only emits audit event 'bug_report_generated' so engineers can locate and fix within 1 minute.
    // dedup maintained across ticks: bugReportRecentKeys module-level Set (24h TTL; currently reset on idle)
    // env PHILONT_BUG_DETECTOR=0 to disable.
    if (process.env.PHILONT_BUG_DETECTOR !== '0') {
      try {
        const result = runBugDetector({
          auditEvents: internalAudit.getEvents(),
          recentlyReported: bugReportRecentKeys,
        });
        for (const report of result.reports) {
          bugReportRecentKeys.add(report.key);
          console.warn(
            `[bug-detector] ${report.pattern} (${report.severity}): ${report.title}`,
          );
          internalAudit.append('bug_report_generated', {
            source: 'bug_detector',
            origin: 'Internal',
            toolName: 'bug_report_generated',
            pattern: report.pattern,
            key: report.key,
            title: report.title,
            severity: report.severity,
            expected: report.expected,
            actual: report.actual,
            fileHint: report.fileHint,
            fixProposal: report.fixProposal,
            count: report.count,
            firstSeen: report.firstSeen,
            lastSeen: report.lastSeen,
            evidence: report.evidence.slice(0, 5),
          });
        }
      } catch (e) {
        console.error('[bug-detector] tick failed', e);
      }
    }
  },
});

// 2026-07-03: scheduled-turn progress verdict bridge. The scheduler's failure circuit breaker
// (recordFailure → 1h auto-pause after N consecutive failures) only fired when the autonomous turn
// THREW (chat-handler.ts ~2680). But a scheduled turn that returns an HONEST "partial (0/N)" report
// — every business http 401'd — does NOT throw, so recordSuccess reset the counter and the schedule
// never paused (prod: two mycox heartbeats avalanched, ~30s apart, all 401, each recorded outcome=ok).
// The turn-finalization block writes a "did this turn make real external progress?" verdict here,
// keyed by scheduled sessionId; the fire handler reads it to choose recordFailure vs recordSuccess.
const scheduledTurnProgress = new Map<string, { madeProgress: boolean; at: number }>();

// 2026-05-12 Phase 8 M4: bug report dedup state (maintained across idle ticks).
// Reset every 24h to prevent unbounded growth. Can also be manually cleared by admin (reportedBugKeys.clear()).
const bugReportRecentKeys = new Set<string>();
setInterval(() => {
  bugReportRecentKeys.clear();
}, 24 * 60 * 60_000).unref();

// Adapt the memory tools provided by agent-memory (store_fact/get_fact/list_facts/search_notes/
// search_skills/use_skill/create_calendar_event/list_upcoming/schedule_reminder)
// to the agent-policy Tool interface, and add them to the toolset.
// Memory tools have domain='self'; they must enter the registry via extraInternalTools (using registerInternal).
const memoryToolAdapters: Tool[] = createMemoryTools(
  memory.facts,
  memory.notes,
  memory.skills,
  memory.calendar,
  memory.schedules,
  memory.raw,
).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    // Phase 13.5 (2026-05-18): schedule_reminder post-hook — if the LLM did not pass a project but the current session
    // has an active plan.persistedTo, automatically fill in schedule.project.
    // When a scheduled session fires later, chat-handler.buildMemoryPrefix uses this project to
    // look up plan.md and inject it into the prefix. Mechanism-layer safety net: even if the LLM forgets to pass project, the plan.md pipeline still works.
    if (
      t.name === 'schedule_reminder' &&
      r.success &&
      r.data &&
      typeof r.data === 'object' &&
      !(params as { project?: string }).project
    ) {
      try {
        const sched = r.data as { id?: string; project?: string | null };
        if (sched.id && !sched.project) {
          const sid = currentSessionId();
          if (sid) {
            const activePlan = memory.plans.listBySession(sid, { limit: 1 })[0];
            if (activePlan?.persistedTo) {
              memory.schedules.setProject(sched.id, activePlan.persistedTo);
              console.log(
                `[schedule-project-autofill] schedule=${sched.id} project=${activePlan.persistedTo} ` +
                  `(from session active plan, no project passed by LLM)`,
              );
            }
          }
        }
      } catch (e) {
        console.warn('[schedule-project-autofill] failed (ignored):', e);
      }
    }
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// 2026-05-07:SecretStore + saveCredential / removeCredential / listCredentialNames
// Tools (domain='self', only user-driven turns may record credentials; autonomous_turn blacklist prohibits them).
// Persisted to ~/.philont/secrets.json (AES-256-GCM encrypted; master key provided by
// PHILONT_MASTER_KEY env or ~/.philont/secret.key).
const SECRETS_PATH = join(homedir(), '.philont', 'secrets.json');
const secretStore = new SecretStore({ path: SECRETS_PATH });
console.log(`[secrets] SecretStore loaded ${secretStore.list().length} entries from ${SECRETS_PATH}`);
const credentialToolAdapters: Tool[] = createCredentialTools(secretStore);

// 2026-05-06 Phase C: subscribePush / unsubscribePush tools (domain='self').
// The LLM calls them when the user **explicitly** requests notifications. description is strictly constrained.
const pushToolAdapters: Tool[] = createPushTools(memory.pushSubscriptions).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// GrantStore singleton: dynamic authorization (with TTL decay). Shared by PolicyGate auth flow + proactive research "request permission".
// Defined before researchToolAdapters / PursuitDriver / executor so they can consume it.
const globalGrants = new GrantStore();

// 2026-05-30 proactive research loop: research_focus + grant_research_tool tools (domain='self').
// When the user explicitly requests "continuously research X", the LLM calls research_focus to register an active-research pursuit;
// the autonomous loop's PursuitDriver then advances it each tick. When background research needs a gated tool, it requests permission;
// the user calls grant_research_tool (passing globalGrants) to grant a bounded audited authorization within the conversation.
const researchToolAdapters: Tool[] = createResearchTools(memory.pursuits, globalGrants).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// 2026-05-11 (v17 complex-task protocol): task_mode_classify + plan_* tool suite.
// When the LLM opens a turn in slow mode it calls task_mode_classify('slow') → plan_draft → plan_review
// → execute → plan_close. The mechanism-layer plan_protocol_gate (dispatch section) enforces completion of the flow.
//
// Task mode store is a module-scoped in-memory KV (per session); the current turn sid is retrieved via ALS.
// PlanStore has been mounted to memory.plans inside openMemoryDb (schema v17).
const taskModeStore = new InMemoryTaskModeStore();
const taskModeToolAdapters: Tool[] = createTaskModeTools({
  store: taskModeStore,
  getCurrentSessionId: () => currentSessionId() ?? 'unknown',
  // Phase 10 P0 (2026-05-14): check for active plan when reverting slow→fast.
  // Plan in draft/reviewed/executing → reject (prevents LLM from bypassing plan_protocol_gate by switching mode).
  // 2026-05-14 production fix: even if plan is already closed to failed/completed, if updatedAt is within the
  // cooling window (default 60s), still return it — triggers the lock, blocking the plan_close→mode-switch bypass.
  getActivePlan: () => {
    const sid = currentSessionId();
    if (!sid) return null;
    const p = memory.plans.listBySession(sid, { limit: 1 })[0];
    if (!p) return null;
    // Return regardless of status (the lock inside decides based on status + cooling);
    // caller only queries when mode='fast' && current store='slow', does not affect other paths.
    return {
      id: p.id,
      status: p.status,
      reviewCount: p.reviewHistory.length,
      updatedAt: p.updatedAt,
    };
  },
}).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));
// v19 (2026-05-13): per-session signalBus map. outer handleChatSend sets it at each
// turn entry and deletes it in the finally block. createPlanTools is called once at module load;
// when plan_close.execute runs it looks up this Map via currentSessionId() to get the current turn's
// honesty / interruptDrained signals → converts to PlanCloseSignals for strict validation.
const activeSignalBuses = new Map<string, TurnSignalBus>();

// Interrupt teeth (2026-05-29): per-session turn AbortController.
// outer handleChatSend creates a new one at each turn entry and deletes it in the finally block.
// User mid-turn stop (UserHardStop) goes: ws `chat.stop` → abortActiveTurn(sessionId) →
// .abort() → (1) passed to the LLM HTTP call to cancel in-flight requests, (2) runToolLoop checks .aborted
// at each iteration / tool boundary to exit early.
// This is the TS implementation of the K7 CRITICAL channel in production (Rust loop refactor frozen).
const activeTurnAborters = new Map<string, AbortController>();

/** Get the AbortSignal for the current turn (used for boundary checks in sendLlmWithRescue / runToolLoop). */
function turnAbortSignal(sessionId: string): AbortSignal | undefined {
  return activeTurnAborters.get(sessionId)?.signal;
}

/**
 * Identify abort exceptions caused by "user mid-turn stop".
 * Anthropic SDK throws APIUserAbortError; fetch (OpenAI-compatible endpoint) throws DOMException with name='AbortError'.
 * Both are treated uniformly as UserHardStop, mapped to interrupted outcome (not an error).
 */
export function isAbortError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

/**
 * Stop the current turn mid-flight (UserHardStop). Called by ws `chat.stop`.
 * Returns true if the session currently has an active turn and an abort has been issued.
 */
export function abortActiveTurn(sessionId: string): boolean {
  const aborter = activeTurnAborters.get(sessionId);
  if (!aborter || aborter.signal.aborted) return false;
  aborter.abort();
  return true;
}

/**
 * Global emergency stop: abort **all** turns currently running across all sessions. Returns the count of actual aborts issued.
 * Together with autonomousLoop.pause(), forms the "one-click stop everything" mechanism.
 */
export function abortAllTurns(): number {
  let n = 0;
  for (const aborter of activeTurnAborters.values()) {
    if (!aborter.signal.aborted) { aborter.abort(); n++; }
  }
  return n;
}

// Phase 11 (2026-05-14): per-session messages reference, for plan_review tool to query
// "recent assistant text" to detect the self-review section. outer handleChatSend sets it at each
// turn entry and deletes in the finally block. Returns a reference to the current messages array (no copy).
const activeSessionMessages = new Map<string, NativeMessage[]>();

// Phase 12 refactor (2026-05-17): plan_protocol_gate switched to 3×4 capability/domain decision.
//
// Old implementation used a hardcoded whitelist by tool name (PLAN_PROTOCOL_READONLY_EXEMPT), decoupled from agent-policy's
// 3×4 PermissionMatrix — adding any read-only tool required changing the gate whitelist,
// and self×write (store_fact / saveCredential, etc.) was incorrectly blocked, violating the 3×4 principle
// (self domain = agent self-state, non-externalizing, write does not need approval).
//
// New rules (layered):
//   1. plan_* / task_mode_classify: protocol-layer tools, always passed through
//   2. askUserQuestion: even if classified as read, questioning the user is not allowed during the plan-drafting phase (semantic special case)
//   3. read any domain → pass (research / read facts, no mutation)
//   4. write × self → pass (memory self-managed, consistent with 3×4 self×write not requiring approval)
//   5. others (write × local/network, execute × *) → block, subject to plan state constraints
//
// Relationship to 3×4: gate adds plan-state constraints on top of 3×4. Tools already blocked by 3×4 (write network /
// execute) do not need the gate to repeat; those allowed by 3×4 but crossing plan boundaries (write local / execute local)
// get additional gate constraints. The two layers are orthogonally composable.
//
// Phase 18 (2026-05-27): isPlanGateExempt / isReadOnlyShellCommand extracted to a separate module
// to prevent unit tests from hanging due to top-level DB side-effects when importing chat-handler.ts.
// Uses import + re-export internally to keep call sites unchanged — `export ... from` alone does not bring the
// binding into this module's scope, and the 4 gate call sites would get ReferenceError.
import { autoRecoveryPlanScopeAllows, autoRecoveryScopedTool, isPlanGateExempt, isReadOnlyShellCommand, terminalPlanClosedThisTurn } from './plan_gate.js';
export { isPlanGateExempt, isReadOnlyShellCommand, terminalPlanClosedThisTurn };

// Phase 10 M1 (2026-05-14): persist fetched resources to local disk.
// Intercepts successful webFetch / readFile tool_results → saves to ~/.philont/workspace/fetched/.
// plan_aux_llm.resolveGuideText queries this store to get the actual guide.md content for aux.
// env PHILONT_FETCHED_ENABLED=0 to disable (reverts to Phase 9.2 "not fetched" placeholder behavior).
const fetchedStore = new FetchedResourceStore();
console.log(
  `[fetched-store] config: enabled=${fetchedStore.enabled ? 'on' : 'off'} baseDir=${fetchedStore.baseDir}`,
);

const planToolAdapters: Tool[] = createPlanTools({
  plans: memory.plans,
  skills: memory.skills,
  getCurrentSessionId: () => currentSessionId() ?? 'unknown',
  // M4 (2026-05-15): spec-coverage R1 validates minimum deliverables count for slow tasks
  getIsSlow: () => {
    const sid = currentSessionId();
    if (!sid) return false;
    return taskModeStore.get(sid) === 'slow';
  },
  getCloseTimeSignals: () => {
    const sid = currentSessionId();
    if (!sid) return null;
    const bus = activeSignalBuses.get(sid);
    if (!bus) return null;
    // sameRootCauseFailures: computed in real time at close moment over a 24h / 30-entry window (the true signal
    // before turn finalization; does not depend on a post-turn-end copy).
    let sameRoot = 0;
    try {
      const sinceTs = Date.now() - 24 * 60 * 60_000;
      const recent = memory.actions.listRecentFailures({ sinceTs, limit: 30 });
      sameRoot = countSameRootCauseFailures(recent);
    } catch {
      // Failures in computing the failure window are swallowed; does not affect close — close-time validation falls back to
      // checking only step / evidence / honesty.
    }
    return {
      honestyReason: bus.honesty?.evaluation.reason ?? null,
      honestySeverity: bus.honesty?.evaluation.severity ?? null,
      sameRootCauseFailures: sameRoot,
    };
  },
  // Phase 9.2 M3 (2026-05-13) pre-wired: plan_close immediately writes back to signalBus on invocation;
  // turn finalization fallback uses this to determine "did the LLM call plan_close".
  markPlanCloseCalled: () => {
    const sid = currentSessionId();
    if (!sid) return;
    const bus = activeSignalBuses.get(sid);
    if (bus) bus.planCloseCalled = true;
  },
  // Phase 13(2026-05-17):per-project plan.md hook
  planFiles: memory.planFiles,
  // M2 / Phase 11 (2026-05-15) removed: auxLLMFn / fetchedStoreLookup /
  // getRecentAssistantText — aux LLM re-review + self-review checks entirely removed;
  // the nested-call trap was empirically ineffective.
}).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  capability: t.capability,
  domain: t.domain,
  async execute(params: Record<string, unknown>) {
    const r = await t.execute(params);
    return {
      success: r.success,
      output: r.output ?? '',
      ...(r.error ? { error: r.error } : {}),
    };
  },
}));

// All tools registered → access control delegated to PolicyGate's 3×4 matrix + GrantStore authorization flow.
// Design rationale: profile is "which tools exist"; PermissionMatrix is "whether they can execute".
// Having profile do access control = silently swallowing tools; users never know the agent has capabilities like shell/process/patch
// — the authorization flow never gets a chance to trigger.
//
// Current createReadOnlyMatrix(): read=local/network/self, write=self only, execute=all blocked.
// So writeFile/shell/git/process etc. trigger onAuthRequest to ask the user on the first call;
// user replies with an offered approval word (including OK/继续) → the suspended call resumes;
// the pending card and resumed local workflow use configurable 30-minute defaults.
//
// The old utility/memory (volatile Map) is still included automatically from full, but we additionally inject
// persistent agent-memory tools via extraInternalTools — the conflict between the two sets of memory tools needs attention;
// createToolset below should prefer extraInternalTools, overriding same-named builtins.
// replyWithMedia is a channel-aware tool: whether it succeeds depends on whether the current sessionId
// corresponds to a channel with media-sending capability registered (e.g. wechat). Under a web-ui session
// it returns a clear "this session does not support sending media" error; the LLM falls back to writeFile + text notification.
// capability=write/domain=network → PolicyGate sends onAuthRequest on first call.
const channelTools: Tool[] = [replyWithMediaTool];

// installSkill / uninstallSkill wrappers: **synchronously await reloadSkillsFromDisk** after execute,
// eliminating the "installed but not usable" inconsistency window. See skill_install_wrapper.ts.
const installSkillSync = wrapSkillToolWithReload(installSkillTool, reloadSkillsFromDisk);
// uninstall also clears the marketplace provenance/lock entry (best-effort) before reloading.
const uninstallSkillSync = wrapSkillToolWithReload(
  {
    ...uninstallSkillTool,
    async execute(params: Record<string, unknown>) {
      const result = await uninstallSkillTool.execute(params);
      if (result.success && typeof params.name === 'string') {
        try { removeLock(params.name); } catch { /* lock cleanup is advisory */ }
      }
      return result;
    },
  },
  reloadSkillsFromDisk,
);
// installSkillFromRegistry: typed aggregator install (fetch→scan→gate→write). Wrap with reload so the
// installed skill is usable the same turn (same rationale as installSkill).
const installFromRegistrySync = wrapSkillToolWithReload(installSkillFromRegistryTool, reloadSkillsFromDisk);

// WS3 (selfhood_closure): owner-ratified constitution amendment. The agent may only call this
// AFTER the owner has explicitly approved/rejected a surfaced proposal in conversation — the tool
// applies the decision (approve: append-only amend + hash audit; reject: 30d re-proposal
// suppression). Red lines are not amendable through this channel (enforced in approveAndApply).
// Blacklisted for autonomous turns: self-ratification is not ratification.
const decideConstitutionProposalTool: Tool = {
  name: 'decide_constitution_proposal',
  description:
    'Apply the OWNER\'s explicit decision on a pending constitution amendment proposal. Call ONLY ' +
    'after the owner has clearly approved ("同意/批准/approve") or rejected ("不要/拒绝/reject") the ' +
    'specific proposal you relayed to them — never decide for them, never call this unprompted. ' +
    'approve applies an append-only amendment (red lines can never be changed); reject suppresses ' +
    'the same proposal for 30 days.',
  schema: {
    type: 'object',
    required: ['id', 'decision'],
    properties: {
      id: { type: 'string', description: 'Proposal id (full id from the pending-proposal card).' },
      decision: { type: 'string', enum: ['approve', 'reject'], description: "Owner's decision." },
    },
  },
  capability: 'write',
  domain: 'self',
  async execute(params: Record<string, unknown>) {
    try {
      const id = typeof params.id === 'string' ? params.id.trim() : '';
      const decision = params.decision === 'approve' ? 'approve' : params.decision === 'reject' ? 'reject' : null;
      if (!id || !decision) {
        return { success: false, output: '', error: 'decide_constitution_proposal: id and decision (approve|reject) are required' };
      }
      if (decision === 'approve') {
        const applied = approveAndApply(constitutionProposals, memory.pursuits, id, internalAudit);
        return {
          success: true,
          output: `Constitution amended per proposal ${applied.id.slice(0, 8)} (${applied.kind}). The amendment is append-only and hash-audited.`,
        };
      }
      const rejected = constitutionProposals.decide(id, 'rejected');
      if (!rejected) {
        return { success: false, output: '', error: `proposal ${id} not found or already decided` };
      }
      return {
        success: true,
        output: `Proposal ${rejected.id.slice(0, 8)} rejected; identical content will not be re-proposed for 30 days.`,
      };
    } catch (e) {
      return { success: false, output: '', error: `decide_constitution_proposal failed: ${(e as Error).message}` };
    }
  },
};

// self_capabilities: read-only introspection of the agent's CURRENT capabilities, generated from live
// runtime state (feature flags + registered autonomous drivers + tool count) — never from memory or
// training. Backs the always-injected compact manifest with on-demand depth, so when the agent reasons
// about "what can I do / self-evaluate my abilities" it reads the current build, not a stale self-image
// (prod 2026-07-11: it reported just-shipped self-repair/versioning/trajectory features as ❌ missing).
const selfCapabilitiesTool: Tool = {
  name: 'self_capabilities',
  description:
    'Read your OWN current capabilities — which self-learning / reasoning / autonomy features are ' +
    'enabled right now, which autonomous drivers are running, how many tools you have. Generated live ' +
    'from process state, so it is the ground truth, NOT what you may remember from training or an ' +
    'earlier version of yourself. Call this before answering "what can you do" or self-evaluating your ' +
    'abilities, especially after the user mentions an upgrade.',
  schema: { type: 'object', properties: {} },
  capability: 'read',
  domain: 'self',
  async execute() {
    try {
      return { success: true, output: renderCapabilityDetail(buildCapabilityState(tools.list().length)) };
    } catch (e) {
      return { success: false, output: '', error: `self_capabilities failed: ${(e as Error).message}` };
    }
  },
};

// forget_skill: delete SELF-LEARNED skills (reflection/plan-distilled, stored DB-only — the ones
// uninstallSkill cannot reach because they have no SKILL.md on disk). This closes a real gap: the
// model could `search_skills` and SEE these, and `uninstallSkill` only removes file-backed dirs, so a
// "delete the X skills" request left DB-only self-learned skills behind (and the model would overclaim).
//
// Safety: file-backed skills (bundled / installed via installSkill — they have a SKILL.md on disk and a
// non-trivial `source`) are NEVER deleted here. We compute the on-disk name set via the same loader the
// reload-prune uses, and protect any skill whose name is on disk. `source` alone is NOT a reliable
// "DB-only" signal (a bundled SKILL.md without a `source:` frontmatter field lands as source=NULL), so we
// gate on actual disk presence, not on source.
const forgetSkillTool: Tool = {
  name: 'forget_skill',
  description:
    'Delete one or more SELF-LEARNED skills (the reflection/plan-distilled skills stored in the DB — exactly the ones ' +
    'uninstallSkill cannot reach). Three selectors (combine contains + max_use_count as AND): exact `name`; ' +
    "`contains` (case-insensitive substring of name / description / trigger keywords — e.g. contains=\"mycox\"); " +
    'and `max_use_count` (delete every self-learned skill used ≤ N times — use max_use_count=0 for "删除使用次数为0的' +
    '技能" / prune all never-used skills in ONE call — do NOT enumerate and delete one by one). File-backed skills ' +
    '(bundled, or installed via installSkill — they have a SKILL.md on disk) are NEVER touched here and are reported ' +
    'as skipped; use uninstallSkill for those. Returns the true count + names actually deleted — report THAT count, ' +
    'do not invent one. NOTE: if a recurring source is still active (a failing scheduled task / repeated pattern), a ' +
    'skill can be re-learned later — stop that source too.',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact skill name (slug) to delete — a single target.' },
      contains: {
        type: 'string',
        description:
          'Case-insensitive substring. Deletes EVERY self-learned skill whose name / description / trigger keywords ' +
          'contain it. Use for bulk cleanup of a topic (e.g. "mycox").',
      },
      max_use_count: {
        type: 'number',
        description:
          'Delete every self-learned skill whose use count is ≤ this. max_use_count=0 prunes all never-used skills ' +
          'in ONE call (the "删除使用次数为0" case). Combines with `contains` (AND).',
      },
    },
  },
  capability: 'write',
  domain: 'self',
  async execute(params: Record<string, unknown>) {
    try {
      const name = typeof params.name === 'string' ? params.name.trim() : '';
      const contains = typeof params.contains === 'string' ? params.contains.trim() : '';
      const maxUseCount =
        typeof params.max_use_count === 'number' && Number.isFinite(params.max_use_count)
          ? params.max_use_count
          : undefined;
      if (!name && !contains && maxUseCount === undefined) {
        return {
          success: false,
          output: '',
          error: 'forget_skill: provide `name` (exact), `contains` (substring), or `max_use_count` (e.g. 0 for never-used).',
        };
      }

      // On-disk skill names = file-backed (bundled / installed). Never delete these here.
      let onDisk = new Set<string>();
      try {
        const parsed = await loadSkills(process.cwd(), [bundledSkillsDir]);
        onDisk = new Set(parsed.map((p) => p.name));
      } catch {
        // Loader failure → conservatively fall through with an empty on-disk set; matching below is still
        // bounded by the selectors, and the worst case is deleting a DB row that reload would re-import.
      }

      const query = { name, contains, maxUseCount };
      // Use the maintenance list (ALL maturities incl. deprecated, unranked) — listAll/search hide
      // deprecated + rank+truncate, so a criterion delete must not go through them or it silently
      // misses skills (prod: "94" claimed, most never targeted because search_skills is relevance FTS).
      const all = memory.skills.listAllForMaintenance();
      const matches = selectSkillsToForget(all, onDisk, query);
      // Skills matching the criterion but protected because they are file-backed — reported so the true
      // "matched N, deleted M, skipped K file-backed" is visible (K left for uninstallSkill), not surfaced
      // as K separate tool failures like the per-name enumeration did.
      const fileBackedSkipped = selectSkillsToForget(all, new Set<string>(), query).length - matches.length;

      if (matches.length === 0) {
        if (name && onDisk.has(name)) {
          return {
            success: false,
            output: '',
            error: `'${name}' is a file-backed skill (has a SKILL.md on disk) — use uninstallSkill instead of forget_skill.`,
          };
        }
        const crit = name
          ? `name='${name}'`
          : [contains ? `contains='${contains}'` : '', maxUseCount !== undefined ? `max_use_count=${maxUseCount}` : '']
              .filter(Boolean)
              .join(' + ');
        // Idempotent delete: zero matches = SUCCESS (nothing to delete), not an error. Prod: on an
        // already-clean store this returned fail → the honesty gate saw "cleanup claimed but no
        // successful forget_skill" → forced re-calls → same-sig failures → in-turn-reflection locked
        // the tool → a 59-tool churn. "Already clean" must be indistinguishable from a clean delete.
        return {
          success: true,
          output: `No self-learned skill matched ${crit} — nothing to delete (already clean).`,
          data: { deleted: [], count: 0, fileBackedSkipped },
        };
      }

      const deleted: string[] = [];
      for (const s of matches) {
        if (memory.skills.deleteSkill(s.name)) deleted.push(s.name);
      }
      // Cap the listed names so a 90-skill prune does not dump a wall of text.
      const shown = deleted.slice(0, 20).join(', ');
      const more = deleted.length > 20 ? `, …(+${deleted.length - 20} more)` : '';
      const skippedNote = fileBackedSkipped > 0
        ? ` Skipped ${fileBackedSkipped} file-backed skill(s) — use uninstallSkill for those.`
        : '';
      return {
        success: true,
        output:
          `🗑️ Forgot ${deleted.length} self-learned skill(s): ${shown}${more}.${skippedNote}\n` +
          '(If a scheduled task or recurring failure keeps re-learning a skill, stop that source too, or it will return.)',
        data: { deleted, count: deleted.length, fileBackedSkipped },
      };
    } catch (e) {
      return { success: false, output: '', error: `forget_skill failed: ${(e as Error).message}` };
    }
  },
};

const tools = createToolset({
  profile: 'server',
  customProfiles: {
    server: {
      extends: 'coding',
      // Remove volatile memory (Map): its semantics look nearly identical to the persistent store_fact/get_fact/search_notes
      // to the LLM; keeping it would tempt it to store important facts in the Map, which are lost on next startup.
      // Remove original installSkill/uninstallSkill/installSkillFromRegistry: fs-only or registry write,
      // install→use not visible within the same turn. extraInternalTools below replaces them with wrapped
      // versions that synchronously reload after execution. (searchSkills is read-only — kept as-is.)
      exclude: ['memory', 'installSkill', 'uninstallSkill', 'installSkillFromRegistry'],
    },
  },
  extraInternalTools: [
    ...memoryToolAdapters,
    ...pushToolAdapters,
    ...researchToolAdapters,
    ...credentialToolAdapters,
    ...taskModeToolAdapters,
    ...planToolAdapters,
    ...channelTools,
    installSkillSync,
    uninstallSkillSync,
    installFromRegistrySync,
    forgetSkillTool,
    decideConstitutionProposalTool,
    selfCapabilitiesTool,
  ],
  // 2026-05-07: hook up SecretStore so the http tool uses the secured variant, supporting {SECRET_NAME}
  // placeholders. Credentials written by saveCredential can be referenced directly in http headers / body.
  secretStore,
});

// ── planAndExecute composite tool(2026-05-07)─────────────────────────────
// Parent turn calls once → internally plans + runs sub-tasks via a mini-agent-loop → aggregates and returns.
// From the parent turn's perspective, 1 iteration completes without hitting the MAX_TOOL_LOOP_ITERATIONS cap.
//
// Sub-loop blacklist:
//   - planAndExecute (prevent nested recursion with unbounded budget)
//   - askUserQuestion (sub-loop is non-interactive)
//   - installSkill / uninstallSkill (self domain cannot be written by sub-loop)
const PLAN_EXEC_BLACKLIST: ReadonlySet<string> = new Set([
  'planAndExecute',
  'askUserQuestion',
  'installSkill',
  'uninstallSkill',
  'installSkillFromRegistry',
  'forget_skill',
  // WS3: constitution decisions require the owner in the loop — never inside a sub-loop.
  'decide_constitution_proposal',
  // Authorization is not something a sub-loop may write, even a validated kind. grant_research_tool
  // ratifies a request the background research already made — a legitimate act, and one that belongs
  // to a turn the owner is present for. A sub-task reaching for it would be asking itself.
  'grant_research_tool',
  // Credential recording is only allowed in user-driven turns; sub-loop inside planAndExecute / autonomous turns
  // cannot modify secrets.
  'saveCredential',
  'removeCredential',
]);

// 2026-05-10: autonomous turn (system:scheduled:*) tool blacklist.
// K0 session filtering (408eb0a) cuts off cross-session contamination; but autonomous heartbeats
// could still go astray if the LLM takes a wrong path (e.g. calling writeFile / shell to work around an API failure).
// Production mycox heartbeat called writeFile → auth_pending → turn blocked; confirms the blacklist
// is still a necessary defense-in-depth.
//
// Blacklist principles:
//  - askUserQuestion: autonomous has no user to ask
//  - cancel_schedule / schedule_reminder: prevent self-destruction + prevent uncontrolled creation of new schedules
//  - saveCredential / removeCredential / installSkill / uninstallSkill: writing
//    self / credentials only allowed in user-driven turns
//  - shell / writeFile / patch / editFile: heavy side-effects; if autonomous errs
//    there is no user rescue; read-only tools (http / readFile / listDir, etc.) suffice
//  - forgetFact: prevent losing user memory
/**
 * Tool blacklist for the MECHANISM plan-loop (runPlanExecuteLoop) — PLAN_EXEC_BLACKLIST minus
 * saveCredential. The plan-loop is USER-DRIVEN and mechanism-owned, unlike planAndExecute sub-loops /
 * autonomous turns, so persisting a credential here is legitimate (prod: register obtained the API key but
 * could not save it, so later posting steps had no auth and attempted 0 actions). Everything else in the
 * blacklist still applies.
 *
 * This MUST be the single source for BOTH the model's tool defs and the runner blacklist. They used to be
 * computed separately and disagreed: the runner allowed saveCredential while the defs filter still used the
 * unmodified PLAN_EXEC_BLACKLIST (which contains it), so the model never saw the tool and could not call it
 * — the allowance silently did nothing, and the plan protocol's mandated "MUST have a saveCredential
 * deliverable" was unsatisfiable (prod 2026-07-17: `EXECUTE save-creds: tools=5 ok=2 actions=1/3` was the
 * model flailing at a deliverable it had no tool for, then reporting done).
 */
export const PLAN_LOOP_BLACKLIST: ReadonlySet<string> = (() => {
  const b = new Set(PLAN_EXEC_BLACKLIST);
  b.delete('saveCredential');
  return b;
})();

// ── Unsatisfiable scheduled goal ──────────────────────────────────────────────────────────────
//
// A scheduled task whose goal needs a tool the mechanism forbids fails identically forever, and
// nothing ever said so. Prod 2026-07-21: a 6-minute heartbeat was created with the goal "MycoX
// check-in routine (including logging to memory/YYYY-MM-DD.md)"; heartbeat turns may not call
// writeFile, so every run was blocked at the same step and every run was correctly judged a failure.
// Fourteen consecutive runs, hours of tokens, and the only trace was one warn line per run.
//
// Detection is from EVIDENCE, not from reading the goal text. Deciding up-front whether prose
// "requires writeFile" would need the aux LLM to classify capability requirements from free text, and
// a false positive there would BLOCK task creation — the landmine direction. A rejection that already
// happened, repeatedly, is a fact: the task tried, and the mechanism said no. The cost of waiting for
// the evidence is a few runs; the cost of guessing wrong at creation is a task the user cannot create.
const UNSATISFIABLE_GOAL_WINDOW = 5;
/** Runs within the window that must show the same block before it counts as structural, not incidental. */
const UNSATISFIABLE_GOAL_MIN_RUNS = 3;

/** Persisted signature for "the blacklist refused this tool" — namespaced so it cannot collide with http ones. */
export function blockedToolSignature(toolName: string): string {
  return `blocked:${toolName}`;
}

/**
 * Persisted signature for "the learning judge could not confirm this run met its goal".
 *
 * 2026-07-22: the detector above only ever saw a goal fail through a BLOCKED TOOL CALL — which is the
 * exact defect it was built to fix, wearing a different hat. Once appendJournal shipped, the model
 * stopped calling writeFile, so no `blocked:` signature was produced and the detector fell silent — while
 * the goal ("log to memory/YYYY-MM-DD.md") remained just as unreachable, and the judge kept saying so
 * every run: "appended a journal entry but the goal requires logging to memory/YYYY-MM-DD.md, not
 * journal/". A model that learns to work AROUND an impossible requirement makes the impossibility
 * invisible to a detector that watches only for the collision.
 *
 * Deliberately ONE signature rather than a key derived from the judge's prose. The evidence text is
 * free-form LLM output that words the same cause differently every run, and matching it would mean either
 * a vocabulary table or a similarity threshold — both guesses. "The judge has not been able to confirm
 * this schedule met its goal, N runs running" is already the actionable statement, and it is exact.
 */
export const JUDGE_GOAL_UNMET_SIGNATURE = 'judge:goal_unmet';

/**
 * Latest unconfirmed-goal verdict per schedule, carried into the NEXT run's outcome row.
 *
 * The judge is deliberately async and fire-and-forget (shadow wiring), so its verdict lands after this
 * run's outcome row is already written. Rather than reopen the row, the signal rides along with the next
 * one: the detector counts recurrence over a window, so a one-run offset changes nothing about what it
 * concludes. A restart loses at most one run's carry.
 */
const lastJudgeGoalUnmet = new Map<string, string>();

/**
 * Tools blocked in THIS run that have now been blocked in at least UNSATISFIABLE_GOAL_MIN_RUNS of the
 * last UNSATISFIABLE_GOAL_WINDOW runs. Pure; `prior` is the window BEFORE this run was recorded.
 *
 * Fires on the crossing only (count === threshold), so a permanently broken schedule reports once per
 * streak instead of once per run — the report is meant to reach a human, and a repeated report is one
 * a human learns to ignore.
 */
export function detectUnsatisfiableGoal(
  blockedThisRun: readonly string[],
  prior: ReadonlyArray<{ failureSignatures: string[] }>,
  minRuns = UNSATISFIABLE_GOAL_MIN_RUNS,
  window = UNSATISFIABLE_GOAL_WINDOW,
): string[] {
  const recent = prior.slice(0, Math.max(0, window - 1));
  return blockedThisRun.filter((sig) => {
    const count = 1 + recent.filter((o) => o.failureSignatures.includes(sig)).length;
    return count === minRuns;
  });
}

/**
 * Surface a structurally unsatisfiable schedule to the owner. High-importance note (the same channel
 * the rejection message tells the model to use) plus a warn line, so it shows up whether the user is
 * reading notes or reading logs.
 */
function reportUnsatisfiableGoal(
  scheduleId: string,
  sessionId: string,
  structuralThisRun: readonly string[],
  prior: ReadonlyArray<{ failureSignatures: string[] }>,
  judgeEvidence?: string,
): void {
  try {
    const crossed = detectUnsatisfiableGoal(structuralThisRun, prior);
    if (crossed.length === 0) return;
    const tools = crossed.filter((s) => s.startsWith('blocked:')).map((s) => s.slice('blocked:'.length));
    const goalUnmet = crossed.includes(JUDGE_GOAL_UNMET_SIGNATURE);
    const runs = `${UNSATISFIABLE_GOAL_MIN_RUNS} of the last ${UNSATISFIABLE_GOAL_WINDOW} runs`;

    const parts: string[] = [`Scheduled task "${scheduleId}" is not achieving its goal as written.`];
    if (tools.length > 0) {
      parts.push(
        `It has tried to call ${tools.join(', ')} in ${runs}, and unattended turns are not allowed to call ` +
          `${tools.length > 1 ? 'those tools' : 'that tool'}.`,
      );
    }
    if (goalUnmet) {
      parts.push(
        `Its runs completed without erroring, but the learning judge could not confirm the goal was met in ` +
          `${runs}.` + (judgeEvidence ? ` Latest reason: "${judgeEvidence}"` : ''),
      );
    }
    parts.push(
      `It will keep ending the same way until the goal is reworded to describe something a scheduled turn ` +
        `can actually do and verify (appendJournal for a per-run log, store_note to hand something to you), ` +
        `or the task is run interactively instead. Nothing else about the task is broken.`,
    );

    console.warn(
      `[unsatisfiable-goal] scheduleId=${scheduleId} ${
        tools.length > 0 ? `blocked ${tools.join(', ')}; ` : ''
      }${goalUnmet ? 'goal unconfirmed by the judge; ' : ''}in ${runs}`,
    );
    const text = parts.join(' ');
    // The durable record.
    memory.notes.storeNote({ sessionId, importance: 0.95, content: text });
    // ...and actually tell the owner. This report existed for exactly one purpose — so they would learn
    // a scheduled task cannot work — and it was filed into a note, which is passive: it sits in the DB
    // until someone thinks to look. That is the same silence this whole class of defect keeps taking, and
    // it was mine. It is safe to be loud here precisely because detectUnsatisfiableGoal fires on the
    // threshold CROSSING only: at most one message per schedule per streak, not one per run.
    for (const [, send] of webuiClients) {
      try { send({ type: 'finding', text: `🔔 ${text}` }); }
      catch (e) { console.warn('[unsatisfiable-goal] webui send failed', e); }
    }
    void pushDispatcher
      .enqueue({ severity: 'digest', kind: 'schedule_unsatisfiable', targetRef: `schedule:${scheduleId}`, text })
      .catch((e) => console.warn('[unsatisfiable-goal] push dispatch threw', e));
  } catch (e) {
    // Advisory reporting only — never let it take down the turn it is reporting on.
    console.warn('[unsatisfiable-goal] report failed, ignored', (e as Error)?.message ?? e);
  }
}

/**
 * What an unattended turn CAN do, stated up front.
 *
 * appendJournal shipped as the supported way for a scheduled run to record what it did, but its only
 * advertisement was the blacklist rejection message — so the model learned it exists by first calling
 * writeFile and being refused. Prod 2026-07-21: run 61 hit the wall, read the message, and called
 * appendJournal correctly; runs 62-69 never attempted writeFile at all, therefore never saw the message,
 * therefore never used the tool, and settled on store_fact — which the learning judge then failed for not
 * satisfying the goal's "log to memory/YYYY-MM-DD.md", run after run.
 *
 * The general defect: a capability advertised only in an error message is invisible to anyone who stops
 * making the error. So state it at the top of the turn, where the model is deciding what to do, instead of
 * at the bottom of a failure it may never repeat.
 */
export function autonomousCapabilityNote(): string {
  return (
    `\n\n[unattended-turn] No user is present this turn, so tools that change the machine or need approval ` +
    `are unavailable — writeFile, shell, and file edits among them. Two things ARE available and cover what ` +
    `they are usually reached for:\n` +
    `- appendJournal({text}) — append to the agent's own dated journal. This is how you record what this run ` +
    `did or observed; use it INSTEAD of trying to write a log/markdown file yourself. Do not report a log as ` +
    `written unless this call succeeded.\n` +
    `- store_note({content, importance}) — hand something to the owner to act on when you next talk.`
  );
}

/**
 * The single rejection message for an autonomous-turn blacklist hit. Both interception sites (initial
 * calls and the main loop) MUST use this: they used to carry separately-written text that had already
 * drifted — one English, one Chinese — and a model that reads only one of them gets only half the
 * available options. Same lesson as PLAN_LOOP_BLACKLIST being the single source for defs AND runner.
 *
 * The message must name a tool that ACTUALLY EXISTS for the blocked intent. Telling a scheduled task
 * "you may not write files, leave a note instead" left its stated goal ("log to memory/YYYY-MM-DD.md")
 * unreachable, so it failed identically on every run forever — see appendJournal.ts.
 */
export function autonomousBlacklistReason(toolName: string): string {
  return (
    `Autonomous heartbeat turns may not call ${toolName}. This turn was fired by a schedule with no user ` +
    `present, so changing self-state timing, writing to the shared filesystem and asking the user are all unsafe.\n` +
    `Continue observing with read-only tools (http / readFile / listDir / get_fact / list_facts / search_notes / search_skills).\n` +
    `To RECORD what this run did: call appendJournal({text}) — an append-only dated journal inside the agent's own ` +
    `state directory. It is permitted here and is the supported way to keep a per-run log; do not try to write the ` +
    `log file yourself.\n` +
    `To hand work to the user (cancelling a schedule, saving a credential, anything needing approval): ` +
    `store_note(importance=high), and they will see it next time you talk.`
  );
}

//  - planAndExecute: prevent nested unbounded budget
export const AUTONOMOUS_TURN_BLACKLIST_HARDCODED: ReadonlySet<string> = new Set([
  'askUserQuestion',
  'cancel_schedule',
  'schedule_reminder',
  'saveCredential',
  'removeCredential',
  'installSkill',
  'uninstallSkill',
  'installSkillFromRegistry',
  'forget_skill',
  // WS3: an autonomous turn ratifying its own constitution proposal is self-ratification.
  'decide_constitution_proposal',
  'forgetFact',
  'shell',
  'writeFile',
  'patch',
  'editFile',
  'planAndExecute',
  // 2026-05-15 production supplement: mycox-heartbeat called env to find invite_code → hit auth flow →
  // autonomous turn had no one to approve → auth_pending dead-loop consumed 27s + 7 same-root-cause failures.
  // env has no legitimate use in autonomous (credentials go through listCredentialNames + secret placeholders);
  // direct rejection is far safer than triggering auth.
  'env',
]);

// 2026-05-12 Phase 8 M2: autonomous_blacklist changed from hardcoded to hardcoded + DB overlay.
// hardcoded is the baseline (always blocks); DB rules are added via configRules.getProductionRules,
// allowing MetaConfigObserver (Phase 8 M3) to automatically add rules based on audit patterns.
// PHILONT_SELF_CONFIG=0 reverts to pure hardcoded.
let AUTONOMOUS_TURN_BLACKLIST: Set<string> = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);

function reloadAutonomousBlacklist(): void {
  if (process.env.PHILONT_SELF_CONFIG === '0') {
    AUTONOMOUS_TURN_BLACKLIST = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);
    return;
  }
  const merged = new Set(AUTONOMOUS_TURN_BLACKLIST_HARDCODED);
  try {
    for (const rule of memory.configRules.getProductionRules('autonomous_blacklist')) {
      if (typeof rule.value === 'string' && rule.value.length > 0) {
        merged.add(rule.value);
      }
    }
  } catch (e) {
    console.warn('[config] reloadAutonomousBlacklist failed, fallback to hardcoded:', e);
  }
  AUTONOMOUS_TURN_BLACKLIST = merged;
}

// 2026-05-12 Phase 8 M2: task_mode_classifier.skip_patterns — list of sessionId prefixes;
// if matched, autoClassify is skipped.
//
// History: hardcoded included 'system:scheduled:' / 'system:cron:', with the original intent "schedule turns are
// already structured; no need to classify again." **Overturned by production** (2026-05-15 mycox-heartbeat):
// schedule turn's user message is an instruction template written by the LLM itself (containing guide / keywords);
// without upgrading to slow it hits a wall directly (http × 3 → 404 → in-turn-reflection only upgrades to slow after 3 failures, wasted).
// → Remove 'system:scheduled:' (let the classifier read the user message; high probability of hitting guide-hint
// + heavy-keyword and naturally upgrading to slow). Keep empty array as future hook (env=DB can add custom skips).
//
// Default empty — loaded from DB at startup; when PHILONT_SELF_CONFIG=0, not loaded, keeps hardcoded fallback.
const CLASSIFIER_SKIP_PATTERNS_HARDCODED: readonly string[] = [];
let classifierSkipPatterns: readonly string[] = CLASSIFIER_SKIP_PATTERNS_HARDCODED;

function reloadClassifierSkipPatterns(): void {
  if (process.env.PHILONT_SELF_CONFIG === '0') {
    classifierSkipPatterns = CLASSIFIER_SKIP_PATTERNS_HARDCODED;
    return;
  }
  const merged: string[] = [...CLASSIFIER_SKIP_PATTERNS_HARDCODED];
  try {
    for (const rule of memory.configRules.getProductionRules('task_mode_classifier.skip_patterns')) {
      if (typeof rule.value === 'string' && rule.value.length > 0) {
        if (!merged.includes(rule.value)) merged.push(rule.value);
      }
    }
  } catch (e) {
    console.warn('[config] reloadClassifierSkipPatterns failed, fallback to hardcoded:', e);
  }
  classifierSkipPatterns = merged;
}

// Load at startup + automatically refresh on changed events
reloadAutonomousBlacklist();
reloadClassifierSkipPatterns();
memory.configRules.on('changed', (e: { type: string }) => {
  // Any change triggers a synchronous refresh (coarse-grained, simple and stable)
  reloadAutonomousBlacklist();
  reloadClassifierSkipPatterns();
});

// LLMAdapter does not directly support an independent system field; systemPrompt is prepended to the messages[0] user-segment prefix.
const miniLoopLLM: MiniLoopLLMClient = {
  async send(systemPrompt: string, messages: MiniLoopMessage[], toolDefsForSub, opts?: { signal?: AbortSignal; reasoning?: ReasoningConfig }) {
    const adjusted: NativeMessage[] = messages.length > 0
      ? messages.map((m, i) => {
          if (i === 0 && m.role === 'user' && typeof m.content === 'string') {
            return {
              role: 'user',
              content: `# Sub-task System Instructions\n${systemPrompt}\n\n# Sub-task Task\n${m.content}`,
            };
          }
          return m as NativeMessage;
        })
      : [{ role: 'user', content: systemPrompt }];

    // Forward the sub-loop abort signal so the deep_explore round deadline cancels the
    // in-flight HTTP call (LLMAdapter.send honours opts.signal), instead of the call running
    // to its own timeout and overrunning the parent turn's 20-min hard deadline.
    // 2026-06-07: also forward per-scenario reasoning so deep_explore rounds / skeptics can
    // request explicit max/high thinking effort (runMiniAgentLoop threads opts.reasoning here).
    const resp = await llm.send(adjusted, toolDefsForSub, { signal: opts?.signal, reasoning: opts?.reasoning });
    // LLMResponse and MiniLoopLLMResponse are structurally isomorphic
    return resp as unknown as MiniLoopLLMResponse;
  },
};

/**
 * A SUB-LOOP BORROWS AUTHORIZATION. IT CANNOT MINT IT.
 *
 * This runner called `tools.execute()` — the bare registry, which looks a tool up and invokes it and
 * does nothing else. Every gate this server has lives in createToolChecker, and none of them ran here:
 * not the permission matrix, not GrantStore, not the validator chain, not pathAcl, not the
 * dangerous-command list, not the command gate that was added this morning, not even the catastrophic
 * hard-denies. The sub-loop's own "gate" is a name blacklist of nine self-domain tools; shell, http,
 * writeFile, patch, process, downloadFile and deleteFile are all on the offered list.
 *
 * So the owner was shown `planAndExecute(task="…")` and asked to approve THAT, while what actually
 * ran was whatever commands, paths and HTTP requests a sub-model composed at runtime. A confused
 * deputy: the approval names the wrapper, the wrapper's contents are unknown when it is granted, and
 * every control the wrapper's contents should have met was on the other side of the call.
 *
 * The rule now is the one the composition implies: a sub-task may use what the turn has ALREADY been
 * granted, and nothing more. Reads still flow (the matrix permits them); anything the owner approved
 * this turn keeps working, which is what most plan runs actually depend on — in the 2026-08-09 log
 * shell was approved at 06:58 and planAndExecute ran under that grant at 07:14. What changes is that
 * a sub-task can no longer reach for a capability nobody granted.
 *
 * It cannot ask for one either, because it has no owner to ask (askUserQuestion is blacklisted here
 * by design). So a denial is returned as a structured, quotable failure and the plan reports it
 * upward, where the parent turn CAN raise a card. That is the cheap half of bubbling up: the owner
 * learns exactly which capability was wanted, and a retry runs with it in hand. Resuming a plan from
 * the denied sub-step instead of re-running it needs the sub-loop's state persisted — worth doing,
 * not done here.
 */
let subLoopChecker: ReturnType<typeof createToolChecker> | null = null;
function getSubLoopChecker() {
  // Lazy: `permissions` and `conservativeValidatorChain` are defined below this point.
  subLoopChecker ??= createToolChecker({
    permissions,
    audit: internalAudit,
    classifyTool: (name, params) => tools.classify(name, params),
    grantStore: globalGrants,
    validatorChain: conservativeValidatorChain,
  });
  return subLoopChecker;
}

/**
 * Did this tool result say "a plan stopped because it lacked an approval, and here is which one"?
 *
 * Reads the structured channel rather than the prose: the same report in `output` is what the model
 * sees, and a turn that decided whether to interrupt its owner by matching sentences would be one
 * more mechanism resting on how a model chose to phrase something.
 */
export function subLoopBlockedAuthorization(
  result: { success: boolean; data?: Record<string, unknown> },
): { tool: string; capability: string; domain: string; subTaskId: string } | null {
  const d = result.data;
  if (!d || d.authorizationRequired !== true) return null;
  const tool = typeof d.blockedTool === 'string' ? d.blockedTool : null;
  const capability = typeof d.blockedCapability === 'string' ? d.blockedCapability : null;
  const domain = typeof d.blockedDomain === 'string' ? d.blockedDomain : null;
  // Without a named capability there is no answerable question; let the report speak for itself.
  if (!tool || !capability || !domain) return null;
  return {
    tool,
    capability,
    domain,
    subTaskId: typeof d.blockedSubTaskId === 'string' ? d.blockedSubTaskId : '?',
  };
}

/**
 * Escape hatch if this turns out to break a flow at an inconvenient hour. Default: enforced.
 *
 * `off` drops the GRANT layer for sub-loops — the matrix and the approvals — and nothing else. An
 * operator switching this at 2am is saying "stop asking me", not "let a background plan write to
 * ~/.ssh or pipe a credential out"; a switch whose blast radius is larger than its name is how an
 * escape hatch becomes the incident. The deep checks below run either way.
 */
const subLoopPolicyEnabled = (): boolean => process.env.PHILONT_SUBLOOP_POLICY !== 'off';

/** The refusals no flag reaches: catastrophic commands, sensitive paths, credential exfiltration. */
let subLoopFloorChecker: ReturnType<typeof createToolChecker> | null = null;
function getSubLoopFloorChecker() {
  subLoopFloorChecker ??= createToolChecker({
    // No grant store, and deliberately no classifyTool: without a classifier the matrix branch in
    // createToolChecker does not run at all, so this sandbox matrix is inert and only the validator
    // chain below decides. That is the intent — this layer does not rule on who may do what, only on
    // what is not done regardless. Passing a classifier here would deny everything.
    permissions: createSandboxMatrix(),
    audit: internalAudit,
    validatorChain: conservativeValidatorChain,
  });
  return subLoopFloorChecker;
}

const subTurnToolRunner = async (
  name: string,
  input: Record<string, unknown>,
): Promise<{
  ok: boolean;
  output: string;
  error?: string;
  policyDenied?: boolean;
  deniedTool?: string;
  deniedCapability?: string;
  deniedDomain?: string;
}> => {
  try {
    {
      const check = subLoopPolicyEnabled() ? getSubLoopChecker() : getSubLoopFloorChecker();
      const denial = await check({
        toolName: name,
        approval: 'never',
        params: JSON.stringify(input ?? {}),
      });
      if (denial) {
        const cls = tools.classify(name, input);
        const capability = cls ? `${cls.capability}/${cls.domain}` : 'unknown';
        console.warn(`[sub-loop] blocked ${name} (${capability}): ${denial.slice(0, 120)}`);
        return {
          ok: false,
          output: '',
          // Structured, so a business error that happens to say "not authorized" — an HTTP 401 body,
          // say — is never mistaken for OUR refusal and turned into a resumable checkpoint.
          policyDenied: true,
          deniedTool: name,
          deniedCapability: cls?.capability,
          deniedDomain: cls?.domain,
          error:
            `${SUBLOOP_AUTH_DENIED} for this sub-task: ${name} (${capability}). ${denial}\n` +
            `A sub-task inherits the approvals this turn already has and cannot request new ones — ` +
            `there is nobody here to ask. Do not try a different phrasing of the same call, and do ` +
            `not claim the step succeeded. Stop this sub-task and report it as blocked, naming the ` +
            `tool and capability above, so the owner can be asked once and the plan re-run with it.`,
        };
      }
    }
    const r = await tools.execute(name, input);
    return {
      ok: !!r.success,
      output: r.output ?? '',
      error: r.error,
    };
  } catch (e) {
    return { ok: false, output: '', error: String(e) };
  }
};

/**
 * Interrupted plans, waiting for the approval they stopped for.
 *
 * Keyed by task text: the parent model re-issues the same planAndExecute call after the owner says
 * yes, which is the only handle both sides reliably share. Bounded and short-lived — a checkpoint is
 * a convenience, and a stale one that resurrected an old plan would be worse than re-planning.
 */
const PLAN_CHECKPOINT_TTL_MS = 30 * 60_000;
const planCheckpoints = new Map<string, PlanExecCheckpoint>();

/**
 * A CHECKPOINT BELONGS TO ONE CONVERSATION.
 *
 * Keyed on the task text alone, this was a process-wide map: two conversations that phrased a task
 * identically — "build and publish", "check the logs" — would share one entry, and the second would
 * resume the first one's plan, inherit its completed results, and fold their text into its own
 * summary. Cross-session continuation, and a way for one conversation's file paths and outputs to
 * surface in another's report. Task text is a description; it was never an identity.
 */
function planCheckpointKey(task: string): string {
  return `${currentSessionId() ?? 'unknown'}::${task.trim()}`;
}

const planCheckpointStore = {
  load: (task: string): PlanExecCheckpoint | null => {
    const key = planCheckpointKey(task);
    const cp = planCheckpoints.get(key);
    if (!cp) return null;
    if (Date.now() - cp.createdAt > PLAN_CHECKPOINT_TTL_MS) {
      planCheckpoints.delete(key);
      return null;
    }
    return cp;
  },
  save: (cp: PlanExecCheckpoint): void => {
    if (planCheckpoints.size > 20) planCheckpoints.clear();
    planCheckpoints.set(planCheckpointKey(cp.task), cp);
    console.warn(
      `[plan-execute] session=${safeSessionId(currentSessionId() ?? '')} checkpointed at ${cp.blockedSubTaskId}: ` +
        `${cp.completed.filter((c) => c.status === 'success').length} done, waiting on an approval — ` +
        `a retry of the same task in THIS conversation resumes instead of re-planning`,
    );
  },
  clear: (task: string): void => { planCheckpoints.delete(planCheckpointKey(task)); },
};

const planAndExecuteTool = createPlanAndExecuteTool({
  llm: miniLoopLLM,
  toolRunner: subTurnToolRunner,
  checkpoints: planCheckpointStore,
  toolDefs: tools.list()
    .filter((t) => !PLAN_EXEC_BLACKLIST.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: JSON.stringify(t.schema),
    })),
  // NOTE: no budgetTracker injected — createPlanAndExecuteTool constructs a FRESH tracker per
  // invocation. A module-lifetime singleton here once anchored the wallclock budget to PROCESS
  // START (prod 2026-07-07: resume-after-auth turns saw "wallclock reached 1416439ms/300000ms"
  // and skipped every sub-task) and accumulated the token/tool budget across all calls forever.
  defaultMaxIters: 8,
  defaultMaxSubTasks: 6,
  toolBlacklist: PLAN_EXEC_BLACKLIST,
  logger: {
    log: (m) => console.log(`[plan-execute] ${m}`),
    warn: (m) => console.warn(`[plan-execute] ${m}`),
  },
  onProgress: (text) => console.log(`[plan-execute] ${text}`),
  // Cross-layer skill recall (P3): surface task-relevant anti-patterns into each sub-task's prompt
  // so a corrected mistake does not recur in a blind sub-step. agent-tools cannot import memory, so
  // the selection is done here and passed as a rendered text block. Flag OFF => returns '' =>
  // sub-loop systemPrompt is byte-identical to today (zero behavior change).
  recall: (q) =>
    recallRelevanceEnabled()
      ? selectRelevantSkills(memory.skills, q, {
          pool: 'negative',
          k: 5,
          fallback: () => memory.skills.listNegative(5),
        })
          .map((s) => `- ${s.name}: ${s.description}`)
          .join('\n')
      : '',
});

// domain='self' → registerInternal path (plugin/external are not allowed to declare self)
tools.registerInternal(planAndExecuteTool);

// ── Deep reasoning subsystem (isolated; env flag on by default; only disabled with PHILONT_DEEP_EXPLORE='0') ──────────
// deep_explore tool is registered by default; skipped only when PHILONT_DEEP_EXPLORE='0' is explicitly set. Reuses miniLoopLLM +
// subTurnToolRunner; tool subset = autonomous read-only whitelist + native verification tools ∩ registered tools.
// These verifiers are not all in DEFAULT_TOOL_WHITELIST, so deep_explore opts into them explicitly.
// Background auto-advance (Part 2) reaches the round runner through this handle; set when deep_explore
// is enabled, read by the (default-off) auto-advance loop started further down.
let deepExploreAdvanceSession: ((session: ReasoningSession) => Promise<ToolResult>) | null = null;
export const DEEP_EXPLORE_VERIFY_TOOL_NAMES = new Set([
  'z3Verify', 'pariGp', 'leanCheck', 'magnitude', 'lemmaLookup',
]);

const formalVerificationEvidenceBySession = new Map<string, string[]>();
function focusedReasoningSession(owner: string): ReasoningSession | null {
  const focused = memory.reasoning.getFocusedSession(owner);
  if (focused) return focused;
  // A sole session is unambiguous and preserves the convenient single-project path. With multiple
  // sessions, returning null is safer than assigning another project's frontier to this turn.
  const active = memory.reasoning.listActiveSessions(owner);
  if (active.length === 1) {
    memory.reasoning.setFocusedSession(owner, active[0].id);
    return active[0];
  }
  return null;
}

function shellVerificationScope(command: string): string | null {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const lakeTarget = normalized.match(/(?:^|[;&|]\s*)lake\s+build\s+([^\s;&|]+)/i)?.[1];
  if (lakeTarget) return `target:${lakeTarget}`;
  if (/(?:^|[;&|]\s*)lake\s+build(?:\s|$)/i.test(normalized)) return 'project-build-only';
  const leanFile = normalized.match(/(?:^|[;&|]\s*)(?:lake\s+env\s+)?lean(?:\.exe)?\s+([^\s;&|]+\.lean)(?:\s|$)/i)?.[1];
  return leanFile ? `file:${leanFile}` : null;
}

export function formalEvidenceAppliesToClaims(evidence: string, claims: readonly string[]): boolean {
  const scope = evidence.match(/^\[scope=([^\]]+)\]/)?.[1];
  if (!scope) return false;
  const haystack = claims.join('\n').toLowerCase();
  // A bare `lake build` covers compilation of every module in the project, so it may support any
  // explicit BUILD/COMPILE claim without requiring the prose to repeat "whole project". It still
  // does not establish an arbitrary mathematical claim merely because that claim lives in Lean.
  if (scope === 'project-build-only') {
    return /\b(?:build|built|compile|compiled|compiles|compilation)\b|(?:\u7f16\u8bd1|\u6784\u5efa).{0,12}(?:\u901a\u8fc7|\u6210\u529f|\u5b8c\u6210|\u65e0\u8bef)|(?:\u901a\u8fc7|\u6210\u529f|\u5b8c\u6210).{0,12}(?:\u7f16\u8bd1|\u6784\u5efa)/i.test(haystack);
  }
  const named = scope.replace(/^(?:target|file):/, '').toLowerCase();
  const basename = named.split(/[\\/]/).pop() ?? named;
  const leaf = scope.startsWith('target:') ? (basename.split('.').filter(Boolean).pop() ?? basename) : '';
  return haystack.includes(named)
    || haystack.includes(basename)
    || haystack.includes(basename.replace(/\.lean$/i, ''))
    || (!!leaf && haystack.includes(leaf));
}

/** Strict enough that `lean --version` cannot masquerade as proof/build verification. */
export function extractFormalVerificationEvidence(
  toolName: string,
  input: Record<string, unknown>,
  result: Pick<ToolResult, 'success' | 'output'>,
): string | null {
  if (!result.success) return null;
  const output = (result.output ?? '').replace(/\s+/g, ' ').trim();
  if (toolName === 'leanCheck' || toolName === 'z3Verify') {
    return `${toolName}: ${output.slice(0, 500) || 'verified successfully'}`;
  }
  if (toolName !== 'shell' && toolName !== 'process') return null;
  const command = String(input.command ?? input.cmd ?? '').replace(/\s+/g, ' ').trim();
  if (!isStrictFormalVerificationCommand(command)) return null;
  const scope = shellVerificationScope(command);
  if (!scope) return null;
  return `[scope=${scope}] ${toolName}: ${command.slice(0, 240)} → ${output.slice(0, 500) || 'exit 0'}`;
}

function rememberFormalVerificationEvidence(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  result: Pick<ToolResult, 'success' | 'output'>,
): void {
  const evidence = extractFormalVerificationEvidence(toolName, input, result);
  if (!evidence) return;
  const prior = formalVerificationEvidenceBySession.get(sessionId) ?? [];
  formalVerificationEvidenceBySession.set(sessionId, [...prior.filter((e) => e !== evidence), evidence].slice(-12));
}

if (process.env.PHILONT_DEEP_EXPLORE !== '0') {
  const readOnlyToolDefs: ToolDefinition[] = tools.list()
    .filter((t) => DEFAULT_TOOL_WHITELIST.has(t.name) || DEEP_EXPLORE_VERIFY_TOOL_NAMES.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.schema) }));
  const { tool: deepExploreTool, advanceSession: deepExploreAdvance } = createDeepExploreTool({
    reasoning: memory.reasoning,
    miniLoopLLM,
    subTurnToolRunner,
    readOnlyToolDefs,
    // 2026-06-07: close the failure-learning loop for compute tools — log pariGp/z3 failures to
    // the action ledger (reflector distils durable lessons) and surface learned lessons back into
    // the round prompt (collectComputeLessons).
    actions: memory.actions,
    skills: memory.skills,
    getSelectedSessionId: (owner) => owner ? memory.reasoning.getFocusedSession(owner)?.id : undefined,
    onSessionSelected: (owner, session, source) => {
      if (owner) {
        memory.reasoning.setFocusedSession(owner, session.id);
        memory.metrics.increment(`deep_explore.binding.${source}`);
      }
    },
    onSessionAbandoned: (owner, session) => {
      if (owner) memory.reasoning.clearFocusedSession(owner, session.id);
    },
    getExternalVerificationEvidence: (owner, activeClaims) => {
      try {
        const plan = memory.plans.listBySession(owner, { limit: 1 })[0];
        const planEvidence = plan ? plan.steps
          .filter((s) => s.status === 'done' && !!s.evidence?.trim())
          .map((s) => `${s.description}: ${s.evidence!.trim()}`) : [];
        const formalEvidence = (formalVerificationEvidenceBySession.get(owner) ?? [])
          .filter((evidence) => formalEvidenceAppliesToClaims(evidence, activeClaims));
        return [...planEvidence, ...formalEvidence].slice(-12);
      } catch {
        return (formalVerificationEvidenceBySession.get(owner) ?? [])
          .filter((evidence) => formalEvidenceAppliesToClaims(evidence, activeClaims));
      }
    },
    onStatus: (text) => console.log(`[deep-explore] ${text}`),
    // Surface each round's progress summary to the user. Without this the 12-min rounds are
    // silent — the user only saw the next auth prompt. web-ui gets a persistent chat bubble (its
    // onStatus is an ephemeral status line, cleared at turn end); other channels (WeChat) use
    // onStatus, which they deliver as a real message. currentSessionId/onStatus come from the ALS.
    onMilestone: (text) => {
      const sid = currentSessionId();
      const webuiSend = sid ? webuiClients.get(sid) : undefined;
      if (webuiSend) {
        webuiSend({ type: 'milestone', text });
      } else {
        const s = currentTurnStatus();
        if (s) s(text);
      }
    },
  });
  tools.registerInternal(deepExploreTool);
  deepExploreAdvanceSession = deepExploreAdvance;
  console.log('[deep-explore] enabled (on by default; set PHILONT_DEEP_EXPLORE=0 to disable)');
}

const toolDefs: ToolDefinition[] = tools.list().map(t => ({
  name: t.name,
  description: t.description,
  parameters: JSON.stringify(t.schema),
}));

// ── MCP external tool mounting (async, non-blocking) ──────────────────────────────────────────
// agent-mcp bridge mounts the tools of external MCP servers (e.g. Playwright browser) as philont tools.
// The connection is async while tools / toolDefs are built synchronously at module load — so this is fire-and-
// forget: after connecting, register into the same registry + push into the same toolDefs array reference
// (const binding but mutable content; per-turn sendLlmWithRescue holds the same reference), naturally
// visible to turns seconds later. Failure does not block or crash (connectMcpServers uses allSettled internally).
//
// Security: MCP tools use the normal register() (external untrusted source, self domain prohibited); browser-type configs
// set capability='execute' → under the read-only matrix, the first call triggers onAuthRequest rather than auto-allowing.
// autonomous loop uses an independent whitelist (DEFAULT_TOOL_WHITELIST, which does not include MCP tool names); background
// does not browse live websites.
// Supervised, not fire-and-forget: an MCP server is a separate process (or a remote host) and can die
// at any time. Mount adds to the same registry + toolDefs array; unmount takes them straight back out,
// so a crashed server stops being advertised to the model instead of failing every call forever.
const mcpServerConfigs = loadMcpConfig();
let mcpSupervisor: McpSupervisor | null = null;

if (mcpServerConfigs.length > 0) {
  mcpSupervisor = new McpSupervisor(mcpServerConfigs, {
    onMount: (server, mcpTools) => {
      // Name-based dedup: after sanitizing tool names, collisions may occur (with each other or with
      // built-in tools); duplicate names in toolDefs make the LLM API return 400. Existing names win.
      const existingNames = new Set(toolDefs.map((d) => d.name));
      const mounted: string[] = [];
      for (const tool of mcpTools) {
        if (existingNames.has(tool.name)) {
          console.warn(`[mcp] skipped duplicate tool name ${tool.name} (conflicts with existing tool)`);
          continue;
        }
        try {
          tools.register(tool);
          toolDefs.push({
            name: tool.name,
            description: tool.description,
            parameters: JSON.stringify(tool.schema),
          });
          existingNames.add(tool.name);
          mounted.push(tool.name);
        } catch (e) {
          console.warn(`[mcp] register tool ${tool.name} failed: ${(e as Error)?.message ?? e}`);
        }
      }
      if (mounted.length) console.log(`[mcp] mounted ${mounted.length} tool(s) from "${server}"`);
      // Return what was ACTUALLY mounted: a name we skipped belongs to someone else, and unmounting
      // this server must not take it away from them.
      return mounted;
    },
    onUnmount: (server, toolNames) => {
      for (const name of toolNames) {
        tools.unregister(name);
        const idx = toolDefs.findIndex((d) => d.name === name);
        if (idx >= 0) toolDefs.splice(idx, 1);
      }
      console.warn(`[mcp] unmounted ${toolNames.length} tool(s) from "${server}" (server unavailable)`);
    },
  });

  mcpSupervisor.start().catch((e) => console.warn(`[mcp] supervisor start failed: ${(e as Error)?.message ?? e}`));
}

/** Live MCP connection status (for /api/mcp/status and the health report). */
export function getMcpStatus(): { servers: McpServerStatus[]; summary: string; configured: number } {
  return {
    servers: mcpSupervisor?.status() ?? [],
    summary: mcpSupervisor ? mcpSupervisor.summary() : 'MCP: no servers configured',
    configured: mcpServerConfigs.length,
  };
}

/** Close all MCP connections (subprocesses / HTTP sessions) during graceful shutdown. Called by index.ts. */
export function closeMcpBridgesOnShutdown(): Promise<void> {
  return mcpSupervisor ? mcpSupervisor.stop() : Promise.resolve();
}

const permissions = createReadOnlyMatrix();

// 2026-06-09: wire the validator chain into the server for the first time. Previously
// `createToolChecker` was called WITHOUT a validatorChain, so pathAcl / dangerousCommands / etc.
// existed but ran only in demos — never in production. This is the conservative "safe-deny" config
// agreed with the maintainer (see SECURITY-DESIGN.md §5):
//   - dangerousCommands: the hard-deny catastrophic patterns (rm -rf /, mkfs, dd on /dev, fork bomb,
//     base64|sh, eval $(curl), writes to /etc · /boot · ~/.ssh, secret-file exfil) AND, since
//     2026-08-11, the grant-action patterns.
//
//     Those were filtered out on the reasoning that "a require-grant would just dead-end", and half
//     of that was right: the card does appear (this handler's own auth flow raises it off the denial
//     string, not policy's onApprovalNeeded), but approving it issued a TOOL-scope grant, which
//     isGranted(…, 'command') deliberately refuses — so the next attempt was denied again, forever.
//     The missing half is below in the grant path: an approval for a command-gated call now also
//     issues a command-scope grant for exactly that command, so the loop converges on one yes.
//
//     What this turns on is the distinction the list was written for and never got to make. Local git
//     is free — staging, committing, rebasing are reversible and stay on the machine — while `git
//     push`, `git remote set-url` and credential configuration each need their own approval. On
//     2026-08-10 a plain `git push`, running under a shell grant given half an hour earlier for
//     something else, put 902 files including a live GitHub token onto a public repository.
//   - pathAcl: sensitive-path denylist (~/.ssh, .env, /etc/shadow, .aws/credentials, …). Closes the
//     real gap that `readFile ~/.ssh/id_rsa` succeeded today. workspaceOnly stays OFF (would over-block).
//     KNOWN TRADEOFF: this also blocks legitimate `.env` reads via the file tools.
// NOT wired yet (breakage risk — localhost/MCP, webhooks): SSRF, urlAllowlist, egress allowlist,
// workspaceOnly. See SECURITY-DESIGN.md for the staged plan.
const conservativeValidatorChain = createDefaultChain({
  pathAcl: createPathAclValidator({}),
  dangerousCommands: createDangerousCommandValidator({ patterns: commandGatePatterns() }),
});

/**
 * Which command gates are live. `full` (default) honours every pattern the list was written with;
 * `publish` keeps only the ones whose damage leaves this machine — publishing, where a push would go,
 * stored credentials, and piping the network into an interpreter — and lets the local-destructive ones
 * (git reset --hard, git clean -fdx, chmod 777, systemctl stop …) through as before.
 *
 * The knob exists because the failure mode of a gate is not only "too loose". An owner who is asked
 * twelve times in a morning stops reading the question, and this codebase has that morning on record.
 * If the local-destructive tail turns out to be noise here, `publish` is the retreat that keeps the
 * part that matters; `off` restores the pre-2026-08-11 behaviour of deny-patterns only.
 */
function commandGatePatterns(): typeof DEFAULT_DANGEROUS_PATTERNS {
  const mode = (process.env.PHILONT_COMMAND_GATE ?? 'full').toLowerCase();
  if (mode === 'off') return DEFAULT_DANGEROUS_PATTERNS.filter((p) => p.defaultAction === 'deny');
  if (mode === 'publish') {
    const leavesTheMachine = new Set([
      'git_push', 'git_force_push', 'git_remote_write', 'git_credential_config',
      'curl_pipe_shell', 'wget_pipe_shell',
      'powershell_download_pipe_expression', 'network_pipe_interpreter',
    ]);
    return DEFAULT_DANGEROUS_PATTERNS.filter(
      (p) => p.defaultAction === 'deny' || leavesTheMachine.has(p.id),
    );
  }
  return DEFAULT_DANGEROUS_PATTERNS;
}

/**
 * How long an approval for a command-gated call covers THAT command. Short on purpose: the point of
 * the narrow scope is that the yes is about one invocation, not about a capability.
 */
const SENSITIVE_COMMAND_GRANT_TTL_MS = 5 * 60_000;

/** The command a shell/process call would run, for the command-gate checks. */
function pendingCommandText(toolName: string, input: Record<string, unknown> | undefined): string {
  if (toolName !== 'shell' && toolName !== 'process') return '';
  const command = input?.command;
  return typeof command === 'string' ? command : '';
}

// ── K8 proactivity layer: autonomous loop ────────────────────────────────────────────
// Runs independent ticks during idle time (default 5 min); GapDriver / CuriosityDriver scan memory
// state to find "knowledge gaps / tokens that repeatedly appear but have never been researched / long-stale high-stake pursuits",
// use read-only tools constrained by a whitelist + a single LLM call to actually investigate, produce facts/notes into the DB,
// and fire interrupts so the next turn sees "what I just did on my own" in the system prefix.
//
// Old TsCuriosityDrive (turn-time nudge to LLM) was removed on 2026-05-06. This layer is its
// complete rewrite: upgraded from "reactive reminder" to "proactive investigation".
//
// Key constraints:
//   - Strict tool whitelist (webSearch/webFetch/searchNotes/searchSkills/searchKB/
//     getFact/listFacts/readFile); write tools are unconditionally rejected
//   - Three-level budget hard thresholds (daily/per-tick/per-initiative) + PHILONT_AUTONOMOUS=0 kill switch
//   - 24h dedup per targetRef to prevent repeatedly running the same target
//   - LLM output is forced into structured JSON; facts with empty sourceRefs are silently discarded (prevents hallucination)
/**
 * The whitelist here is real — StandardExecutor checks it before every step — but it is a list of
 * NAMES, and this runner then went straight to the bare registry, so the checks that read the
 * ARGUMENTS never ran. Two consequences, both on the path that executes with nobody watching:
 *
 *   · `readFile` is on the default read-only whitelist, and pathAcl exists precisely to stop
 *     `readFile ~/.ssh/id_ed25519`. It was never consulted here, so the one tool most likely to be
 *     pointed at a secret was the one running without the rule written for it.
 *   · the whitelist widens by `isToolGranted: (tool) => globalGrants.isGranted(tool)`. That is for
 *     the research-grant flow, but it cannot tell "granted for background research" from "the owner
 *     approved shell in a chat two minutes ago" — and a granted `shell` here reached execute() with
 *     no dangerous-command validator and no command gate behind it. An overnight initiative could
 *     compose `rm -rf …`, or a `git push`, and meet nothing.
 *
 * Same rule as the plan sub-loop: the name list stays as the outer bound, and the checker decides
 * the rest. Autonomous work cannot ask for anything, so a denial is simply a failed step — which is
 * the correct shape for an unattended path.
 */
const autonomousToolRunner: ToolRunner = {
  async run(toolName: string, params: unknown): Promise<ToolRunResult> {
    try {
      {
        const check = subLoopPolicyEnabled() ? getSubLoopChecker() : getSubLoopFloorChecker();
        const denial = await check({
          toolName,
          approval: 'never',
          params: JSON.stringify((params as Record<string, unknown>) ?? {}),
        });
        if (denial) {
          console.warn(`[autonomous] blocked ${toolName}: ${denial.slice(0, 120)}`);
          return { ok: false, output: '', policyDenied: true, error: `${SUBLOOP_AUTH_DENIED} for autonomous work: ${denial}` };
        }
      }
      const result = await tools.execute(
        toolName,
        params as Record<string, unknown>,
      );
      return {
        ok: !!result.success,
        output: result.output ?? '',
        error: result.error,
      };
    } catch (e) {
      return { ok: false, output: '', error: String(e) };
    }
  },
};

/**
 * Maximum number of tool-call rounds per turn (each round = one LLM call + running several tools).
 * Old default of 10 was too tight; production PPT generation / long workflows often take 12-15 steps and get truncated.
 *
 * env override: PHILONT_TOOL_LOOP_MAX (range 5-100), default 20.
 */
const MAX_TOOL_LOOP_ITERATIONS: number = (() => {
  const raw = process.env.PHILONT_TOOL_LOOP_MAX;
  if (!raw) return 20;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5 || n > 100) {
    console.warn(
      `[config] PHILONT_TOOL_LOOP_MAX="${raw}" out of range (allowed 5-100), using default 20`,
    );
    return 20;
  }
  return n;
})();

// Phase 10 (2026-05-14): separate tool loop cap configuration for slow mode.
//
// Background: mycox production found complex tasks (reading multiple sub-documents referenced in guide + plan-aux repeated
// revise + register + post + heartbeat + failure recovery) insufficient at 20 iterations. Meanwhile giving 40 to simple fast
// tasks wastes resources. Natural tiering by auto-task-mode:
//   fast → MAX_TOOL_LOOP_ITERATIONS (default 20, env PHILONT_TOOL_LOOP_MAX override)
//   slow → MAX_TOOL_LOOP_ITERATIONS_SLOW (default 40, env PHILONT_TOOL_LOOP_MAX_SLOW override)
//
// Default slow=40 = 2x fast, leaving room for plan-aux repeated revise (6-10 iter) + sub-document reading
// (3-5) + actual execution (8-15) + failure recovery (2-5).
const MAX_TOOL_LOOP_ITERATIONS_SLOW: number = (() => {
  const raw = process.env.PHILONT_TOOL_LOOP_MAX_SLOW;
  if (!raw) return Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 10 || n > 100) {
    console.warn(
      `[config] PHILONT_TOOL_LOOP_MAX_SLOW="${raw}" out of range (allowed 10-100), using default ${Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60)}`,
    );
    return Math.min(MAX_TOOL_LOOP_ITERATIONS * 2, 60);
  }
  return n;
})();
console.log(
  `[config] MAX_TOOL_LOOP_ITERATIONS=${MAX_TOOL_LOOP_ITERATIONS}(fast)/ ${MAX_TOOL_LOOP_ITERATIONS_SLOW}(slow)`,
);

/**
 * Phase 10: get the effective tool loop cap by task mode.
 * slow mode → MAX_TOOL_LOOP_ITERATIONS_SLOW (default 40); others → MAX_TOOL_LOOP_ITERATIONS (default 20).
 * Caller snapshots this once at runToolLoop entry into a local var to avoid cap jumping if mode changes mid-turn.
 */
function effectiveMaxIter(sessionId: string): number {
  return taskModeStore.get(sessionId) === 'slow'
    ? MAX_TOOL_LOOP_ITERATIONS_SLOW
    : MAX_TOOL_LOOP_ITERATIONS;
}

// same_root_cause count at which the system is treated as "stuck" (the ViabilityGate's "high" tier).
const CURIOSITY_STUCK_SUPPRESS_THRESHOLD = 6;

// Cleanup-turn scoping: how long schedules matching the cleanup target stay soft-paused so a
// scheduled fire cannot race the deletion mid-turn. Comfortably above the turn hard deadline's
// practical clear-turn duration (observed ≤3min; worst 20min turn cap does not apply to direct).
const CLEANUP_SCHEDULE_PAUSE_MS = 15 * 60_000;

// Autonomous driver registry — single source of truth; dashboard / tests / loop all reference it.
// PursuitDriver injects an isGranted callback: used to query GrantStore when replaying proactive research "request permission".
/**
 * H3 skill self-repair kill switch. DEFAULT ON (2026-07-11, after two clean dogfood runs — detect-and-
 * report on a missing-dependency recipe, a real in-place rewrite on a syntax-bug recipe). This is the
 * only autonomous driver whose outcome rewrites a reusable artifact, so it keeps its own switch:
 * PHILONT_SKILL_REPAIR=0/off/false/no disables. Safety rails stay in force regardless — only demoted
 * callable recipes are touched, the diagnosis prompt forbids OS-assuming / privileged / system-mutating
 * fixes, an inconclusive diagnosis rewrites nothing, and 3 failed repairs retire the recipe from proposals.
 */
export function skillRepairEnabled(): boolean {
  const v = (process.env.PHILONT_SKILL_REPAIR ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

const AUTONOMOUS_DRIVERS = [
  new GapDriver(),
  // Phase 18 (2026-06-16): suppress token-curiosity while the system is in a doom-loop (high global
  // same_root_cause). Otherwise the curiosity driver keeps autonomously spawning lookups on dead/adjacent
  // topics while the main thread is walled (prod: "素数 R…/RDC…/DSML" tokens).
  new CuriosityDriver({
    ...DEFAULT_CURIOSITY_CONFIG,
    // WS1 (selfhood_closure): live traits — a provider callback so each tick sees a profile
    // derived from CURRENT history (autonomousLoop.initiatives is undefined until the loop is
    // constructed below; the callback resolves it lazily, and curiosity just stays neutral
    // on the very first reads).
    traits: () => {
      // autonomousLoop is a const declared later in this module; guard the TDZ window
      // (a propose() before the loop finishes constructing just gets neutral curiosity).
      let initiatives: InitiativeStore | undefined;
      try {
        initiatives = autonomousLoop.initiatives;
      } catch {
        initiatives = undefined;
      }
      return currentTraitProfile({ driveOutcomes: memory.driveOutcomes, initiatives }, process.env, Date.now(), loadedCompass);
    },
    isSystemStuck: () => {
      // Same "high" tier as the ViabilityGate's same_root_cause weighting — a constant, no env knob.
      // Window is 2h, not 24h: this gate asks "is the system stuck NOW". With 24h, one afternoon
      // task's failure burst (prod 2026-07-07: downloadFile fetch-failed ×7 in the PPT task)
      // suppressed token-curiosity for the rest of the DAY, long after the wall was gone.
      // Reflection/plan_close keep their 24h windows — their job is cross-day lesson writing.
      try {
        const recent = memory.actions.listRecentFailures({ sinceTs: Date.now() - 2 * 60 * 60_000, limit: 30 });
        return countSameRootCauseFailures(recent) >= CURIOSITY_STUCK_SUPPRESS_THRESHOLD;
      } catch {
        return false;
      }
    },
  }),
  new PursuitDriver(DEFAULT_PURSUIT_CONFIG, (tool) => globalGrants.isGranted(tool)),
  // H3 (skill_self_repair.md): continuous self-evolution — a callable recipe that failed its own reuse
  // verification gets diagnosed from the ledger's real failed runs and rewritten, instead of being
  // demoted and forgotten. DEFAULT ON (PHILONT_SKILL_REPAIR=0 disables); it is still the only driver
  // whose outcome REWRITES a reusable artifact, so it keeps its own kill switch and safety rails
  // (bounded prompt, inconclusive → no rewrite, 3-strike retirement — see skillRepairEnabled).
  ...(skillRepairEnabled() ? [new SkillRepairDriver()] : []),
] as const;
export const autonomousDriverNames: readonly string[] = AUTONOMOUS_DRIVERS.map((d) => d.name);

// 2026-05-06 Phase C: proactive push dispatcher. env PHILONT_PUSH_ENABLED controls the global switch.
// Default OFF — even when enabled, per-(channel, peer) opt-in is required for actual pushes.
const pushDispatcher = new PushDispatcher({
  // Day-keyed send outcomes, so "deliverable" in the health report means "sends actually work today", not
  // merely "the name resolves". Keyed by the SUBSCRIPTION's channel string so the health check's lookups
  // match without re-deriving the qualified name.
  onSendOutcome: (channel, ok) => {
    try {
      memory.metrics.increment(`push.day.${ok ? 'ok' : 'fail'}.${channel}.${utcDateString(Date.now())}`);
    } catch { /* counting must never affect delivery */ }
  },
  subscriptions: memory.pushSubscriptions,
  deferredPushes: memory.deferredPushes,
  logger: {
    log: (m) => console.log(`[push] ${m}`),
    warn: (m) => console.warn(`[push] ${m}`),
    error: (m, e) => console.error(`[push] ${m}`, e),
  },
});

// ── Proactive research "request permission" integration with WeChat ─────────────────────────────────────────────────
//
// When background research needs a gated tool (running Lean/Z3, etc.) → executor returns needsGrant → here:
//   (1) Register the request as a pendingResearchGrant (keyed by the subscribed WeChat user's stable sessionId,
//       structurally identical to turn-level pendingAuth, but **without** the tool-chain resume burden — continuation
//       is handled automatically by the next autonomous tick's driver replay);
//   (2) pushDispatcher proactively pushes an authorization card (reusing subscription/rate-limiting/quiet/dedup).
//       If no subscription exists, the push cannot be sent → automatically falls back to "in-conversation authorization"
//       (prompt pending section + grant_research_tool fallback).
// User replies "approve/reject" on WeChat → handleChatSendInner entry deterministic routing (see below).
// Pure logic (rendering / sessionId reconstruction / verdict) extracted to research_grant.ts for independent testing.
/**
 * WHO IS THIS REPLY FOR.
 *
 * Four kinds of card used to compete to interpret one unaddressed sentence, in a fixed code order
 * that has nothing to do with which card the owner was looking at, each keeping a single slot that a
 * later request silently overwrote. The book is the address layer; each kind still owns its payload
 * and its resume path. See pending_decisions.ts for the routing rules and what they refuse to guess.
 *
 * Only research authorization and the deep-explore ask are registered here so far. pendingAuth and
 * pendingQuestion carry provider tool_use pairing and continuations, and get their own pass rather
 * than being bent into a common shape for the sake of a uniform surface.
 */
export const pendingDecisions = new PendingDecisionBook((sessionId, decision) => {
  // A card nobody answered in time. Whatever was waiting behind it has to be told, because the
  // address is gone and no message the owner writes can reach it any more.
  onDecisionExpired(sessionId, decision);
});

/**
 * Research tools whose effects leave this machine or touch credentials. A bare "同意" may not decide
 * these even when they are the only thing outstanding — the owner has to point at the card.
 */
const RESEARCH_TOOLS_NEEDING_EXPLICIT_ADDRESS: ReadonlySet<string> = new Set([
  'shell', 'process', 'http', 'securedHttp', 'downloadFile', 'writeFile', 'patch', 'deleteFile', 'moveFile',
]);

/**
 * There is no shadow mode.
 *
 * One was written as `shadow | enforce`, and it did not compare anything: in shadow the router
 * declined to set the resolved id, while both wired branches now require it — so the old paths were
 * already closed by their address checks and the new one never opened. The net effect was that
 * research authorization and the deep-explore ask could be neither approved nor denied, under a name
 * that reads like a safe observation mode. A switch that silently disables the thing it claims to
 * merely watch is worse than not having one, so it is gone rather than repaired.
 */

/**
 * A message belongs to one decision, and a module that is not that decision may not read it.
 *
 * The address book only registers research authorization and the deep-explore ask so far, and the
 * conclusion drawn from that was that the others could migrate later. They cannot wait, because they
 * still CONSUME: pendingAuth is consulted before the research branch, so a "同意" quoted at a research
 * card resolved correctly at entry and was then spent by the tool authorization anyway — the exact
 * mis-addressing the router exists to end, surviving underneath it.
 *
 * Payload and continuation migration can wait. Obedience to the address cannot.
 */
export function claimedByAnotherDecision(signalBus: TurnSignalBus, ownDecisionId?: string): boolean {
  const resolved = signalBus.resolvedDecisionId;
  if (!resolved) return false;
  return resolved !== ownDecisionId;
}

/** WeChat folds a quoted message into the text as `[引用: …]`; that quote is the exact address. */
function splitQuotedReply(message: string): { quoted?: string; reply: string } {
  const m = message.match(/^\[引用[:：]\s*([\s\S]*?)\]\s*\n?([\s\S]*)$/);
  if (!m) return { reply: message };
  return { quoted: m[1], reply: m[2] ?? '' };
}

/**
 * ADDRESSED is not APPLIED.
 *
 * One record was written the moment the router matched, before the owning module had validated its
 * payload, decided grant or deny, written a grant or resumed anything. In the case that prompted
 * this — an approval for research A landing while only B's payload survived — the ledger said
 * `resolved A` and nothing whatsoever had happened to A. A ledger that records intentions as
 * outcomes is the failure this project keeps writing gates against; it must not be the gate's own
 * bookkeeping.
 */
function auditDecisionAddressed(
  sessionId: string,
  decision: PendingDecision,
  how: string,
  verdict: string,
): void {
  internalAudit.append('self_domain_write', {
    source: 'pending_decision',
    origin: 'External',
    toolName: 'decision_addressed',
    sessionId,
    decisionId: decision.id,
    decisionKind: decision.kind,
    addressedBy: how,
    verdict: verdict.slice(0, 40),
    principal: safeSessionId(sessionId),
    at: Date.now(),
  });
  console.log(
    `[pending] session=${safeSessionId(sessionId)} addressed ${decision.id} (${decision.kind}) ` +
      `by=${how} verdict="${verdict.slice(0, 24)}"`,
  );
}

/** What actually happened to it, written by the module that made it happen — or failed to. */
function auditDecisionApplied(
  sessionId: string,
  decisionId: string,
  outcome: 'granted' | 'denied' | 'expired' | 'failed',
  detail: string,
): void {
  internalAudit.append('self_domain_write', {
    source: 'pending_decision',
    origin: 'Internal',
    toolName: outcome === 'failed' ? 'decision_failed' : 'decision_applied',
    sessionId,
    decisionId,
    outcome,
    detail: detail.slice(0, 120),
    at: Date.now(),
  });
  console.log(
    `[pending] session=${safeSessionId(sessionId)} ${decisionId} → ${outcome}: ${detail.slice(0, 60)}`,
  );
}

/**
 * Keyed by DECISION id, not by session.
 *
 * `Map<sessionId, …>` held one request per conversation and set it unconditionally, so research B's
 * request replaced research A's. Giving the address book a list fixed the ADDRESSES and left this
 * untouched: A stayed answerable in name and had no payload behind it, so approving A found B's id
 * on the only surviving record, matched nothing, and did nothing at all. Half a fix reads exactly
 * like a whole one from the outside — the card is there, the reply is understood, and the grant
 * silently never happens.
 */
const pendingResearchGrants = new Map<string, PendingResearchGrant & { sessionId: string }>();

/**
 * One research-authorization card, created whole.
 *
 * The addressable decision and the payload behind it are written here together, under one id,
 * because they were once written in two places and drifted: the book held [A, B] while the payload
 * map — keyed by conversation — held only B. An approval for A then matched no payload and did
 * nothing, silently. A card you can address with nothing behind it is the worst shape available:
 * from outside it is indistinguishable from a card that works.
 */
export function registerResearchDecision(
  sid: string,
  req: { pursuitId: string; questionId: string; tool: string; why: string; title: string },
): string {
  const id = `r${Math.random().toString(36).slice(2, 6)}`;
  pendingDecisions.add(sid, {
    id,
    kind: 'research_authorization',
    title: `后台研究「${req.title}」请求使用 ${req.tool}`,
    detail: req.why ? `用途：${req.why}` : undefined,
    offered: ['同意', '批准', '授权', '允许', '可以', '好', 'approve', 'allow', 'yes', 'ok',
              '拒绝', '不同意', '不批准', '不允许', '不要', 'reject', 'deny', 'no'],
    resolutionPolicy: RESEARCH_TOOLS_NEEDING_EXPLICIT_ADDRESS.has(req.tool)
      ? 'explicit_address_required'
      : 'unique_bare_reply_allowed',
    createdAt: Date.now(),
    expiresAt: Date.now() + RESEARCH_GRANT_PENDING_TTL_MS,
  });
  pendingResearchGrants.set(id, {
    pursuitId: req.pursuitId,
    questionId: req.questionId,
    tool: req.tool,
    why: req.why,
    ts: Date.now(),
    decisionId: id,
    sessionId: sid,
  });
  return id;
}

/**
 * What happens to the thing behind a card when its address expires.
 *
 * Expired is not denied. The research still wants the tool and the owner never said no — they were
 * busy. So the payload for the dead address is dropped and the request itself (`question.pendingTool`)
 * is deliberately LEFT standing: the driver's next tick re-asks and gets a fresh card with a fresh id
 * and a fresh window. Withdrawing it here would silently convert "no answer yet" into "refused",
 * which is a decision the owner did not make.
 */
function onDecisionExpired(sessionId: string, decision: PendingDecision): void {
  if (decision.kind !== 'research_authorization') return;
  const payload = pendingResearchGrants.get(decision.id);
  pendingResearchGrants.delete(decision.id);
  auditDecisionApplied(
    sessionId,
    decision.id,
    'expired',
    payload ? `${payload.tool} for research ${payload.pursuitId}; request left standing` : 'no payload',
  );
  console.log(
    `[pending] session=${safeSessionId(sessionId)} decision=${decision.id} expired unanswered; ` +
      `payload dropped, research request left standing for a fresh card`,
  );
}

/**
 * Production's effects, in one place so the handler passes the same object every time and a test can
 * pass a failing one. Both writes are the real thing — this is not a seam that lets the test agree
 * with a broken original.
 */
const researchEffects = {
  grant: (g: {
    toolName: string;
    capability: 'execute';
    domain: 'system';
    reason: string;
    audience: string;
    ttlMs: number;
  }) => globalGrants.grant(g),
  withdrawRequest: (pursuitId: string, questionId: string) =>
    memory.pursuits.setQuestionPendingTool(pursuitId, questionId, null),
};

/**
 * The state change itself, separated from the bookkeeping around it, and reporting whether it
 * happened.
 *
 * The order used to be: delete the payload, resolve the card, write `applied`, and only then attempt
 * the grant. Every record said the decision had been carried out before anything had been carried
 * out — so a throw inside `grants.grant()` left a conversation where the card was gone, the payload
 * was gone, the ledger said granted, and no grant existed. On the deny side a failed withdrawal was
 * logged as a warning while the ledger still claimed denied and the background research kept its
 * request. This project keeps writing gates against exactly that failure; the gate's own bookkeeping
 * must not be an instance of it.
 *
 * Effects are injected so this can be tested against real state transitions without an LLM turn.
 */
export function applyResearchDecision(input: {
  payload: PendingResearchGrant & { sessionId: string };
  verdict: 'grant' | 'deny';
  effects: {
    grant: (g: {
      toolName: string;
      capability: 'execute';
      domain: 'system';
      reason: string;
      audience: string;
      ttlMs: number;
    }) => void;
    withdrawRequest: (pursuitId: string, questionId: string) => void;
  };
}): { applied: true; detail: string } | { applied: false; reason: string } {
  const { payload, verdict, effects } = input;
  try {
    if (verdict === 'grant') {
      effects.grant({
        toolName: payload.tool,
        capability: 'execute',
        domain: 'system',
        reason: `research:${payload.pursuitId}`,
        // An approval for the background research is not an approval for this conversation's next
        // shell command.
        audience: researchGrantAudience(payload.pursuitId),
        ttlMs: DEFAULT_RESEARCH_GRANT_TTL_MS,
      });
      return { applied: true, detail: `${payload.tool} for research ${payload.pursuitId}` };
    }
    // Deny means the request goes away: clear question.pendingTool so the driver stops replaying it
    // and the pending-approval section stops being shown. If that write fails the denial has NOT
    // taken effect — the research would keep asking — and saying otherwise would be the lie above.
    effects.withdrawRequest(payload.pursuitId, payload.questionId);
    return { applied: true, detail: `${payload.tool} for research ${payload.pursuitId}` };
  } catch (e) {
    return { applied: false, reason: `${verdict} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The payload for the decision this message resolved — by that id, never by "the most recent one in
 * this conversation". Exported so a test drives the same lookup production does, rather than a
 * reconstruction of it that can agree with a broken original.
 */
export function researchPayloadFor(
  signalBus: TurnSignalBus,
): (PendingResearchGrant & { sessionId: string }) | undefined {
  if (!signalBus.resolvedDecisionId) return undefined;
  return pendingResearchGrants.get(signalBus.resolvedDecisionId);
}

/** Do not consume if pending is too old (a user replying "approve" after a long time is likely out of context). Reuses the research authorization TTL. */
const RESEARCH_GRANT_PENDING_TTL_MS = DEFAULT_RESEARCH_GRANT_TTL_MS;

// ── Web-ui proactive push bridge ─────────────────────────────────────────────────────────────
//
// pushDispatcher fans out only to registered PushChannels (WeChat / Telegram). The web-ui has no
// persistent channel or push subscription — its session ids are ephemeral, one per WS connection —
// so proactive, turn-external messages (background research grant requests, autonomous findings)
// never reached it. We keep a live registry of connected web-ui sessions: index.ts registers each
// WS connection, and the proactive emitters below fan out to them too. For grant requests we also
// register the pending under the web-ui session, so a typed "approve" matches at the
// handleChatSendInner entry exactly like a WeChat/Telegram reply.
export interface WebuiProactiveMessage {
  type: 'research_grant_request' | 'finding' | 'milestone';
  /** Pre-rendered text (findings / milestones) — shown verbatim. */
  text?: string;
  /** Structured fields (grant request) — the front-end renders these bilingually. */
  payload?: Record<string, unknown>;
}
/**
 * The user's language, persisted as the `user.locale` fact.
 *
 * Response language used to be resolved from the CHANNEL (wechat → Chinese). That was wrong: WeChat is
 * international, and the app someone messages from is not evidence of the language they speak. The resolver
 * always had a higher-priority tier for the user's own locale — but nothing ever wrote the fact and no
 * caller ever passed it, so the tier was a comment and the channel pin silently decided for everyone.
 *
 * Observing it (rather than mirroring this turn's message) is what makes it work on a turn with NO user
 * message — which is exactly what a proactive push is: the agent speaking first, with nothing to mirror.
 */
function readUserLanguage(): string | null {
  try {
    const v = memory.facts.getFact('user', 'locale')?.value;
    return typeof v === 'string' && v.trim() ? v : null;
  } catch {
    return null;
  }
}

// Install the reader once, so channels/renderers that cannot reach the memory store resolve from the SAME
// source instead of re-deriving it.
setUserLocaleProvider(readUserLanguage);

function refreshUserLanguage(userMessage: string | null | undefined): void {
  const observed = observeUserLanguage(userMessage);
  if (!observed) return; // no decisive signal — never overwrite a known language with a guess
  try {
    if (readUserLanguage() === observed) return;
    memory.facts.storeFact({ namespace: 'user', key: 'locale', value: observed });
    console.log(`[response-language] user language observed → ${observed}`);
  } catch {
    // Best-effort: language observation must never break a turn.
  }
}

const webuiClients = new Map<string, (msg: WebuiProactiveMessage) => void>();

/**
 * Last time a REAL user action arrived from a web-ui session (a chat message — not a socket connect).
 *
 * The launcher auto-opens a browser tab at startup, so "a web-ui client is connected" says nothing about
 * whether anyone is looking. The double-disturbance guard read that connection as "the owner already saw
 * it" and suppressed the WeChat push — permanently, for an owner who lives in WeChat. The finding was
 * delivered to an unattended tab, and the one channel they actually read was silenced BECAUSE that tab
 * was open. A connection is not a pair of eyes.
 */
let webuiLastUserActivityAt = 0;
export const WEBUI_ACTIVE_WINDOW_MS = 10 * 60_000;
export function markWebuiUserActivity(): void {
  webuiLastUserActivityAt = Date.now();
}
function webuiRecentlyActive(): boolean {
  return webuiClients.size > 0 && Date.now() - webuiLastUserActivityAt < WEBUI_ACTIVE_WINDOW_MS;
}

/** Register a connected web-ui session to receive proactive pushes. Returns an unregister fn. */
export function registerWebuiClient(
  sessionId: string,
  send: (msg: WebuiProactiveMessage) => void,
): () => void {
  webuiClients.set(sessionId, send);
  return () => { webuiClients.delete(sessionId); };
}

/**
 * needsGrant outcome → register pending + proactively push. Failure only logged; main flow unaffected.
 * Reconstruct stable sessionId (`wechat:<accountId>:<userId>`) for subscribed WeChat DM user when registering pending,
 * so that when the user replies on WeChat the pending can be matched by sessionId (same keying as pendingAuth).
 */
function enqueueResearchGrantPush(
  targetRef: string,
  requested: { tool: string; why: string },
): void {
  const parsed = parsePursuitTargetRef(targetRef);
  if (!parsed || parsed.kind !== 'question' || !parsed.questionId) return;
  const pursuit = memory.pursuits.get(parsed.pursuitId);
  const title = pursuit?.title ?? 'research';
  const { tool, why } = requested;

  /**
   * The card gets an id now, before any of it is addressable. Everything that later has to say
   * "this one" — a quote, a number, a reply arriving in another conversation — needs something
   * stable to point at, and retrofitting identity onto a card already shown is not possible.
   *
   * A research tool that reaches outside this machine is not something a stray "同意" should decide:
   * it may well arrive an hour later, about a subject the owner has half put down.
   */
  // Register pending for subscribed WeChat DM users (reconstruct stable sessionId). Group subscriptions / non-WeChat channels are skipped.
  for (const sub of memory.pushSubscriptions.listActive()) {
    const sid = reconstructDmSessionId(sub.channel, sub.peer);
    if (!sid) continue;
    const decisionId = registerResearchDecision(sid, {
      pursuitId: parsed.pursuitId,
      questionId: parsed.questionId,
      tool,
      why,
      title,
    });
  }

  // Web-ui: register pending under each connected web-ui session + show the request card.
  // (Mirrors the WeChat/Telegram path; the front-end renders the structured payload bilingually.)
  for (const [sid, send] of webuiClients) {
    const decisionId = registerResearchDecision(sid, {
      pursuitId: parsed.pursuitId,
      questionId: parsed.questionId,
      tool,
      why,
      title,
    });
    send({
      type: 'research_grant_request',
      // The id travels with the card so a button can carry it back verbatim, instead of the
      // front-end sending a word for something else to guess at.
      payload: { decisionId, title, tool, why, ttlMinutes: Math.round(RESEARCH_GRANT_PENDING_TTL_MS / 60000) },
    });
  }

  void pushDispatcher
    .enqueue({
      severity: 'urgent',
      kind: 'research_grant_request',
      targetRef: `research-grant:${parsed.pursuitId}:${tool}`,
      text: renderResearchGrantPrompt(
        title,
        tool,
        why,
        RESEARCH_GRANT_PENDING_TTL_MS,
        resolvePhraseLang({ userLocale: readUserLanguage() }),
      ),
    })
    .catch((e) => console.warn('[research-grant] push enqueue failed', e));
}

/**
 * True when a targetRef points at a pursuit the OWNER declared (origin='compass'), i.e. a focus area they
 * wrote in compass.md rather than something the agent drifted into on its own. Used as the mechanism-side
 * escalation criterion for the owner funnel.
 *
 * Reads the origin rather than the id shape: `compass-<slug>-<hash>` is only a readability convention, and
 * matching on it would be a naming table that breaks the first time the id scheme changes.
 */
function isOwnerDeclaredTarget(targetRef: string): boolean {
  const m = /^pursuit:([^:]+)/.exec(targetRef);
  if (!m) return false;
  try {
    return memory.pursuits.get(m[1])?.origin === 'compass';
  } catch {
    return false;
  }
}

/**
 * A schedule just auto-paused — tell the owner.
 *
 * Both pause sites wrote an audit row and one console.warn and stopped there. A scheduled task going
 * quiet is indistinguishable from a scheduled task with nothing to say, so the owner would find out by
 * eventually noticing the absence of something they had stopped expecting. The 2026-07-22 move to a
 * 24h cadence made that worse, not better: at one fire a day, a pause costs days before it is noticed.
 *
 * Fires exactly once per pause — the callers only reach here on the transition (`after > before`), not
 * on every fire of an already-paused schedule. Same shape as reportUnsatisfiableGoal: one structural,
 * one-shot, must-know event, and the durable note is kept alongside the notification.
 *
 * Shared by both call sites on purpose. They were separately written and had already drifted (one
 * carries a `reason`, the other does not) — the same split that produced two different blacklist
 * rejection messages.
 */
function reportSchedulePaused(input: {
  scheduleName: string;
  consecutiveFailures: number;
  pausedUntilTs: number;
  reason: 'no_external_progress' | 'run_failed';
}): void {
  try {
    const mins = Math.max(1, Math.round((input.pausedUntilTs - Date.now()) / 60_000));
    const why =
      input.reason === 'no_external_progress'
        ? 'its runs kept completing without achieving anything outside the agent'
        : 'its runs kept failing outright';
    const text =
      `⏸ Scheduled task "${input.scheduleName}" has been auto-paused for ~${mins} minute(s) after ` +
      `${input.consecutiveFailures} consecutive unproductive runs — ${why}. It will resume on its own ` +
      `afterwards; until then it does nothing. If that is not what you want, fix what it is stuck on or ` +
      `re-enable it, and tell me if the goal itself needs rewording.`;
    console.warn(`[schedule-paused] ${input.scheduleName} → owner (${input.reason}, ~${mins}min)`);
    memory.notes.storeNote({ sessionId: `system:scheduled:${input.scheduleName}`, importance: 0.9, content: text });
    for (const [, send] of webuiClients) {
      try { send({ type: 'finding', text }); }
      catch (e) { console.warn('[schedule-paused] webui send failed', e); }
    }
    void pushDispatcher
      .enqueue({
        severity: 'digest',
        kind: 'schedule_paused',
        // Include the deadline so a LATER pause of the same schedule is a distinct target and does not
        // get eaten by the dispatcher's 24h (kind, targetRef) dedup.
        targetRef: `schedule-paused:${input.scheduleName}:${input.pausedUntilTs}`,
        text,
      })
      .catch((e) => console.warn('[schedule-paused] push dispatch threw', e));
  } catch (e) {
    console.warn('[schedule-paused] report failed (ignored):', (e as Error)?.message ?? e);
  }
}

// ── Scheduled-run reporting ───────────────────────────────────────────────────────────────────
//
// A scheduled task used to report NOTHING unless it was created with replyChannel:'summary', and the
// default was 'silent'. Prod 2026-07-21/22: a check-in ran every six minutes for days, and every reply
// — including "这个模式已经走到死胡同了，同样的情况已经重复了 30+ 次" — was discarded at the emitter.
// The owner's report was that the whole flywheel is invisible.
//
// But flipping the default to 'summary' would be the opposite error: six minutes apart, that is ten
// "feed unchanged, nothing to do" messages an hour, and a notification stream a human learns to ignore
// is worth the same as no notification at all. What a person actually wants from a recurring task is to
// hear when something CHANGES.
//
// So the default becomes change-based. 'silent' and 'summary' keep their exact meanings for anyone who
// set them deliberately.

/**
 * Coarse identity of a scheduled run's OUTCOME — what a human would call "the same thing happened again".
 *
 * Deliberately drops the counts: httpOk 5 vs 6 fluctuates with how many comment threads existed that
 * minute and means nothing, while an outcome flipping ok→partial, or a new failure signature appearing,
 * always does. Coarse enough to stay stable across a quiet week, sharp enough that the first 401 breaks it.
 */
export function scheduleRunFingerprint(run: {
  outcome: string;
  httpFailCount: number;
  failureSignatures: readonly string[];
}): string {
  return [
    run.outcome,
    run.httpFailCount > 0 ? 'httpfail' : 'httpok',
    [...run.failureSignatures].sort().join('|'),
  ].join('/');
}

export type ScheduleReplyChannel = 'silent' | 'summary' | 'on-change';

/**
 * Should this run's reply reach the owner?
 *   - 'silent'    → never (an explicit opt-out stays an opt-out)
 *   - 'summary'   → always (an explicit opt-in stays an opt-in)
 *   - 'on-change' → the first run, and thereafter only when the outcome fingerprint moved
 * `prevFingerprint` is undefined on the very first run of a schedule.
 */
export function shouldReportScheduledRun(
  mode: ScheduleReplyChannel,
  fingerprint: string,
  prevFingerprint: string | undefined,
): boolean {
  if (mode === 'silent') return false;
  if (mode === 'summary') return true;
  return prevFingerprint === undefined || prevFingerprint !== fingerprint;
}

/** PursuitProgressWriter instance (reused by the onOutcome composite hook). */
const pursuitWriter = pursuitProgressWriter(memory.pursuits);
/** H3 SkillRevisionWriter instance (same composite hook). Inert unless a skill_repair initiative settles. */
const skillRepairWriter = skillRevisionWriter(memory.skills);

const autonomousInterruptSink: InterruptSink = {
  fire(severity, payload) {
    const summary =
      payload.summary.length > 200
        ? payload.summary.slice(0, 200) + '…'
        : payload.summary;
    const text = `[autonomous:${payload.kind}] ${summary} (initiative=${payload.initiativeId})`;
    // FUNNEL VISIBILITY (2026-07-14). Reaching the owner requires NINE independent conditions to hold
    // (escalate + new-facts + no-webui + not-disabled + subscribed + channel-ready + not-rate-limited +
    // not-quiet + not-duplicate). Each was written and reviewed on its own merits; nobody multiplied them.
    // The owner's report was "I don't perceive the autonomy at all" — and every one of those gates wrote
    // its decision to the audit DB and NOTHING to the console, so neither they nor I could see where the
    // findings were dying. A funnel you cannot watch is a funnel you cannot fix.
    // driver + targetRef, because `kind` has two values and both are outcome shapes — without these the
    // line cannot say whether a drop was a free-curiosity lookup or an owner-declared pursuit advance,
    // which is exactly what we now need to watch.
    const who = `${payload.driver ?? '?'} ${payload.targetRef ?? '?'}`;
    // Count it for the OWNER-facing summary too. The console funnel below is watchable by whoever is
    // reading a terminal; /autonomy is where the person who asked "why do I never perceive this?" looks.
    recordAutonomyReach(payload.driver, severity === 'high');
    try {
      const ymd = utcDateString(Date.now());
      memory.metrics.increment(`autonomy.day.found.${ymd}`);
      if (severity === 'high') memory.metrics.increment(`autonomy.day.eligible.${ymd}`);
    } catch { /* same */ }
    if (severity !== 'high') {
      console.log(
        `[autonomy-funnel] initiative=${payload.initiativeId} kind=${payload.kind} [${who}] DROPPED at gate 1/9 ` +
          `(severity=normal — needs owner-declared target, OR executor escalate=true AND >=1 new fact). ` +
          `Owner will NOT see this; it is only injected into the next turn's prompt.`,
      );
    }
    if (severity === 'high') {
      console.log(`[autonomy-funnel] initiative=${payload.initiativeId} [${who}] passed gate 1/9 (severity=high)`);
      interruptController.sendHigh({ signalType: 'AutonomousFinding', payload: text });
      // Web-ui: surface the finding to any connected web-ui session (no subscription/rate-limit;
      // the user is actively looking at the chat). WeChat/Telegram still go through pushDispatcher below.
      for (const [, send] of webuiClients) {
        send({ type: 'finding', text: `🔔 ${summary}` });
      }
      // Proactive push (urgent): actually sends only when there is an opt-in subscription and rate limit not exceeded.
      // dispatcher internally checks global kill / frequency / quiet / dedup; failure is only audited and does not affect main flow.
      // Double-disturbance guard (2026-07-08): when a web-ui client is CONNECTED the user already
      // saw the finding above — don't also spend the hourly urgent budget on WeChat/Telegram.
      // Grant requests and service digests keep their own paths (they fire when the user is away).
      // Gate 3/9 — the "don't double-disturb" guard. It used to suppress on a web-ui CONNECTION, but the
      // launcher AUTO-OPENS a browser tab, so `webuiClients.size > 0` was permanently true for an owner who
      // actually lives in WeChat: the finding went to a tab nobody was looking at, and the WeChat push was
      // killed BECAUSE that tab was open. Suppress only when the web-ui has seen REAL USER ACTIVITY
      // recently — a connection is not a pair of eyes.
      if (webuiRecentlyActive()) {
        console.log(
          `[autonomy-funnel] initiative=${payload.initiativeId} DROPPED at gate 3/9 ` +
            `(web-ui had user activity in the last ${Math.round(WEBUI_ACTIVE_WINDOW_MS / 60000)}min — ` +
            `the finding was shown there instead)`,
        );
        internalAudit.append('self_domain_write', {
          source: 'push_dispatcher',
          origin: 'Internal',
          toolName: 'push_skipped_webui_active',
          kind: payload.kind,
          initiativeId: payload.initiativeId,
        });
        return;
      }
      void pushDispatcher
        .enqueue({
          severity: 'urgent',
          kind: payload.kind,
          targetRef: payload.initiativeId,
          text: `🔔 ${summary}`,
        })
        .then((r) => {
          if (r.delivered > 0) {
            internalAudit.append('self_domain_write', {
              source: 'push_dispatcher',
              origin: 'Internal',
              toolName: 'push_delivered',
              severity: 'urgent',
              kind: payload.kind,
              initiativeId: payload.initiativeId,
              delivered: r.delivered,
              skipped: r.skipped.length,
              failed: r.failed,
            });
          }
        })
        .catch((e) => console.warn('[push] urgent dispatch threw', e));
    } else {
      interruptController.sendNormal({ signalType: 'AutonomousObservation', payload: text });
    }
  },
};

// ── Seam ①: intrinsic-drive outreach (2026-06-30) ────────────────────────────────────────────
//
// Background: CRITICAL/HIGH crossings of the passive drive signals (commitment_pressure /
// service_dormancy) used to land ONLY in the InterruptDrainer buckets, which are consumed by
// buildMemoryPrefix — and that runs ONLY when the user sends a message. So the agent's own
// "I should reach out" signal never reached the user unprompted; it merely coloured the next reply.
// This closes the loop: an idle-time CRITICAL/HIGH crossing is routed to the same emitters the K8
// high-findings use (connected web-ui sessions + pushDispatcher), reusing the dispatcher's
// global-kill / per-peer opt-in / rate-limit / quiet-hours / 24h-dedup gates verbatim.
//
// Additive only — the signal still broadcasts to the drainer as before (mirrors how
// autonomousInterruptSink does both sendHigh and the web-ui/push fan-out). Kill switch:
// PHILONT_PROACTIVE_OUTREACH=0. Mapper fires on threshold *crossings* only (hysteresis + cooldown),
// so a signal that stays HIGH across many idle ticks does not re-emit.
function emitProactiveOutreach(text: string, kind: string, targetRef: string): void {
  if (process.env.PHILONT_PROACTIVE_OUTREACH === '0') return;
  // Web-ui: fan out to any connected session (no subscription/rate-limit; the user is at the chat).
  for (const [, send] of webuiClients) {
    try { send({ type: 'finding', text: `🔔 ${text}` }); }
    catch (e) { console.warn('[outreach] webui send failed', e); }
  }
  // External channels (WeChat/Telegram): default-OFF + per-peer opt-in; dispatcher applies all gates.
  void pushDispatcher
    .enqueue({ severity: 'digest', kind, targetRef, text })
    .then((r) => {
      if (r.delivered > 0) {
        internalAudit.append('self_domain_write', {
          source: 'proactive_outreach',
          origin: 'Internal',
          toolName: 'push_delivered',
          severity: 'digest',
          kind,
          targetRef,
          delivered: r.delivered,
          skipped: r.skipped.length,
          failed: r.failed,
        });
      }
    })
    .catch((e) => console.warn('[outreach] dispatch threw', e));
}

/** Render a user-addressed outreach line for a drive signal, or null if there is nothing worth saying. */
function renderOutreachText(signal: string): string | null {
  if (signal === 'service_dormancy') {
    const dorm = computeServiceDormancy({ lastAssistantTs: lastAssistantTs(), now: Date.now() });
    const sb = signalState.getCommitmentBreakdown();
    let t = `It's been ${dorm.hoursSinceLastServe.toFixed(1)}h since I last helped you.`;
    if (sb && sb.contributors.length > 0) {
      const items = sb.contributors.slice(0, 3).map((c) => {
        const age = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
        return `${c.title} (${age})`;
      });
      t += ` Still open: ${items.join('; ')}.`;
    }
    return t + ` Anything you'd like me to pick up?`;
  }
  if (signal === 'commitment_pressure') {
    const sb = signalState.getCommitmentBreakdown();
    if (!sb || sb.activeCount === 0) return null;
    const items = sb.contributors.slice(0, 3).map((c) => {
      const age = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
      return `${c.title} (pending ${age})`;
    });
    return `I'm still carrying ${sb.activeCount} open item(s) for you: ${items.join('; ')}. Want me to push any forward?`;
  }
  return null;
}

const autonomousExecutor = new StandardExecutor({
  facts: memory.facts,
  notes: memory.notes,
  llm: extractorLlm,
  tools: autonomousToolRunner,
  // The push this produces is the agent speaking FIRST — there is no user message to mirror, so the language
  // has to be resolved and told. Resolved HERE, from the one resolver, rather than re-derived inside
  // agent-memory: two copies of a resolution is how a writer and a reader end up disagreeing.
  responseLanguage: () => resolveResponseLanguage({ userLocale: readUserLanguage() }),
  // Proactive research "request permission": let executor include user-authorized gated tools in the effective whitelist.
  // Asks as the research audience, so a research approval reaches the loop it was given for — and
  // an ordinary chat approval for `shell`, which carries no audience, still widens the whitelist the
  // way it always did. What no longer happens is the reverse: research grants leaking outward.
  isToolGranted: (tool, targetRef) => {
    // targetRef is `pursuit:<id>:q:<qid>`, so an approval given to one research does not answer for
    // another. Unscoped grants (an ordinary chat approval) still widen the whitelist as before.
    const pursuitId = targetRef?.startsWith('pursuit:') ? targetRef.split(':')[1] : undefined;
    return (
      globalGrants.isGranted(tool) ||
      (pursuitId !== undefined &&
        globalGrants.isGranted(tool, undefined, 'tool', researchGrantAudience(pursuitId)))
    );
  },
  // H3: a skill_repair initiative's evidence is local ledger state, not something to fetch with a tool.
  // Re-checks isRepairCandidate at execution time: the recipe may have been repaired, deleted, or
  // promoted between propose() and now — returning null makes the executor fail loudly instead of
  // rewriting a recipe that no longer needs it.
  skillRepairContext: (skillName) => {
    try {
      const skill = memory.skills.getByName(skillName);
      if (!skill || !isRepairCandidate(skill) || !skill.verification) return null;
      const failures = memory.actions
        .getBySkill(skillName, { onlyFailed: true, limit: 5 })
        .map((a) => ({ toolName: a.toolName, result: a.result, timestamp: a.timestamp }));
      return {
        actionTemplate: skill.actionTemplate,
        verification: skill.verification,
        toolPolicy: skill.toolPolicy,
        failures,
      };
    } catch (e) {
      console.warn('[skill-repair] skillRepairContext lookup failed', e);
      return null;
    }
  },
});

// 2026-05-06: autonomous budget caps support env override; see autonomous_budget_env.ts
const _autonomousBudgetCaps = resolveAutonomousBudgetCaps();
console.log(`[autonomous] ${describeBudgetCapsOverrides(_autonomousBudgetCaps)}`);

// WS2 (selfhood_closure): seed the k8-* drive-config rows so SessionDriveReflector's cooldown
// tuning has somewhere to land — and the loop below reads it back per tick (driverCooldowns).
try {
  ensureK8DriveConfigs(memory.driveConfigs, BOOTSTRAP_ROOT_PURSUIT_ID);
} catch (e) {
  console.warn('[autonomous] ensureK8DriveConfigs failed (cooldown tuning inert)', e);
}

export const autonomousLoop: AutonomousLoopHandle = startAutonomousLoop({
  db: memory.db,
  facts: memory.facts,
  notes: memory.notes,
  raw: memory.raw,
  skills: memory.skills,
  routingRules: memory.routingRules,
  pursuits: memory.pursuits,
  drivers: AUTONOMOUS_DRIVERS,
  executor: autonomousExecutor,
  interrupt: autonomousInterruptSink,
  // Relevance the mechanism can establish on its own: this initiative advances a pursuit the owner
  // declared in their compass. See AutonomousLoopOptions.isOwnerDeclared for why the LLM self-rating it
  // replaced could never fire.
  isOwnerDeclared: (targetRef: string) => isOwnerDeclaredTarget(targetRef),
  budgetCaps: _autonomousBudgetCaps,
  // 2026-05-06 PursuitProgressWriter:pursuit:* initiative done → addEvidence +
  // bumpProgress (automatically updates last_touched_ts), so the next PursuitDriver tick does not immediately hit
  // the same pursuit. Failure only logged; main flow unaffected.
  // Composite hook: after writer (writes pursuit / question.pendingTool), if it is a proactive research "request
  // permission" (needsGrant) → proactively push WeChat authorization card + register pending (in-conversation authorization still serves as fallback).
  onOutcome: (init, result) => {
    pursuitWriter(init, result);
    // H3: the last hop of self-evolution — a diagnosed fix is written back to the skill library
    // (old version snapshotted into revision_history, recipe re-enters at 'draft'). No-op for every
    // non-skill_repair initiative. Never throws.
    skillRepairWriter(init, result);
    if (result.needsGrant && result.requestedTool) {
      try {
        enqueueResearchGrantPush(init.targetRef, result.requestedTool);
      } catch (e) {
        console.warn('[research-grant] enqueue failed', e);
      }
    }
    // WS2: emit a drive_outcomes row per settled K8 initiative so the reflector can score the
    // driver's effectiveness and tune its cooldown. Failure only logged; main flow unaffected.
    try {
      const outcome = k8DriveOutcomeInput(init, result, BOOTSTRAP_ROOT_PURSUIT_ID);
      if (outcome) memory.driveOutcomes.append(outcome);
    } catch (e) {
      console.warn('[autonomous] k8 drive outcome append failed', e);
    }
  },
  // WS2: reflector-tuned per-driver propose cooldowns, read fresh each tick.
  driverCooldowns: () => readK8DriverCooldowns(memory.driveConfigs),
  audit: {
    onTick(e) {
      if (e.proposalsCollected === 0 && e.initiativesRun === 0) return;
      internalAudit.append('self_domain_write', {
        source: 'autonomous_loop',
        origin: 'Internal',
        toolName: 'autonomous_tick',
        proposalsCollected: e.proposalsCollected,
        initiativesRun: e.initiativesRun,
        skipped: e.skipped,
        failed: e.failed,
        llmTokensSpent: e.llmTokensSpent,
        toolCallsSpent: e.toolCallsSpent,
        budgetExhausted: e.budgetExhausted,
        durationMs: e.durationMs,
      });
      if (e.initiativesRun > 0) {
        console.log(
          `[autonomous] tick: ran=${e.initiativesRun} skipped=${e.skipped} failed=${e.failed} tokens=${e.llmTokensSpent} ${e.durationMs}ms`,
        );
      }
    },
  },
});
/**
 * Under `node --test`, module-load background work must not run: these loops (and their timers) keep the
 * event loop alive, so the test runner finishes its assertions and then hangs forever on open handles.
 *
 * That hang is why the server's ~960 tests were excluded from CI entirely (8b1c29f). The first fix reached
 * for `--test-force-exit`, but that kills the process mid-report and SILENTLY DROPS TESTS — measured 962
 * stable vs 945-953 with force-exit, always reporting fail=0. A gate that can hide a failing test is worse
 * than no gate. So the loops are simply not started under test, and the process exits on its own.
 *
 * NODE_TEST_CONTEXT is set by node itself in the test child process — nothing to remember to configure.
 */
const UNDER_TEST = !!process.env.NODE_TEST_CONTEXT;

if (!UNDER_TEST) autonomousLoop.start();

/**
 * Selfhood status snapshot (WS6 §8): one read-only composition consumed by the
 * GET /api/autonomous/selfhood endpoint (index.ts) and the '/autonomy' chat command.
 */
export function autonomySelfhoodStatus() {
  return buildSelfhoodStatus({
    traits: () =>
      currentTraitProfile(
        { driveOutcomes: memory.driveOutcomes, initiatives: autonomousLoop.initiatives },
        process.env,
        Date.now(),
        loadedCompass,
      ),
    traitsLive: traitsLiveEnabled(),
    facts: memory.facts,
    pursuits: memory.pursuits,
    proposals: constitutionProposals,
    initiatives: autonomousLoop.initiatives,
    budget: autonomousLoop.budget,
    reach: () => autonomyReachSummary(),
  });
}

// Background auto-advance for opted-in reasoning sessions (Part 2). Default-off:
// PHILONT_DEEP_EXPLORE_AUTO_ADVANCE gates the whole loop, and each session is opt-in via
// deep_explore action=auto_on. When off, the loop never arms → zero behaviour change.
export const deepExploreAutoAdvance = createAutoAdvanceLoop({
  lang: () => resolvePhraseLang({ userLocale: readUserLanguage() }),
  reasoning: memory.reasoning,
  advanceSession: (s) =>
    deepExploreAdvanceSession
      ? deepExploreAdvanceSession(s)
      : Promise.resolve({ success: false, output: '', error: 'deep_explore disabled' }),
  runInContext: runInTurnContext,
  // WS1 (selfhood_closure): trait-tuned stuck threshold — competitiveness earned from lived
  // history buys more no-progress rounds before the loop declares stuck.
  traits: () =>
    currentTraitProfile(
      { driveOutcomes: memory.driveOutcomes, initiatives: autonomousLoop.initiatives },
      process.env,
      Date.now(),
      loadedCompass,
    ),
  notify: (text, opts) => {
    for (const [, send] of webuiClients) send({ type: 'milestone', text });
    if (opts?.important) {
      void pushDispatcher
        .enqueue({
          severity: 'urgent',
          kind: 'deep_explore:auto_advance',
          targetRef: `deep_explore:auto:${Date.now()}`,
          text,
        })
        .catch(() => {});
    }
  },
});
if (!UNDER_TEST) deepExploreAutoAdvance.start();

// Proactive follow-up (S2 REPORT slice): ask the user about a quiet deep_explore session that still has
// OPEN frontier nodes (the user stopped replying "继续"). Does NOT run the round — just surfaces + asks,
// once per session. Default ON (PHILONT_DEEP_EXPLORE_FOLLOWUP=0 to disable). Reuses the same notify path.
export const deepExploreFollowUp = createFollowUpLoop({
  lang: () => resolvePhraseLang({ userLocale: readUserLanguage() }),
  reasoning: memory.reasoning,
  notify: (text, opts) => {
    // Route to the channel the session was STARTED in — a WeChat-started exploration must not spam the
    // web-ui stream (and vice versa). Unknown / legacy-null owner → web-ui as the fallback surface.
    const owner = opts?.ownerSessionId ?? '';
    if (owner.startsWith('wechat:')) {
      void pushDispatcher
        .enqueue({
          severity: 'urgent',
          kind: 'deep_explore:followup',
          targetRef: `deep_explore:followup:${owner}`,
          text,
        })
        .catch(() => {});
    } else {
      for (const [, send] of webuiClients) send({ type: 'milestone', text });
    }
  },
});
if (!UNDER_TEST) deepExploreFollowUp.start();

// Authorization-reply intent is now classified by the AUX model, for EVERY provider — see auth_intent.ts.
//
// This used to fork on `LLM_PROVIDER === 'anthropic'`, so a DeepSeek deployment (i.e. the actual one) fell
// through to KeywordIntentClassifier for every authorization decision in front of every execute/system tool.
// That classifier substring-matches a bag of words, so it graded three of the most natural things a cautious
// owner says at an auth prompt as CONSENT (measured, not supposed):
//     "我可以再想想吗" → grant · "这个工具可以干什么？" → grant · "你确认一下这是安全的吗" → grant
// A keyword list cannot represent a question, a negation, or a hedge, so it fails in the direction of ACTING.
// classifyAuthIntent exact-matches only the words WE offered on the card (reading back our own closed enum
// is parsing, not inference) and sends everything else — all open language — to the aux LLM, failing CLOSED:
// unconfigured / error / anything unexpected → 'unclear', which re-asks. Re-asking is free.

// ── Session state ──────────────────────────────────────────────────────────────────
//
// K0: LLM working context is no longer held across ws turns; instead, each turn recalls from the raw global timeline.
// `sessions: Map<sid, NativeMessage[]>` removed — it was a byproduct of the ws connection lifecycle,
// causing the agent to "short-term amnesiac" immediately after network jitter / sleep / tab switch.
// See plan: K0 working memory architecture de-sessionization.
//
// K0.4: authorization uses time-based TTL rather than binding to ws connection — users who reconnect within the
// 30-minute default window do not need to re-authorize. `pendingAuth` is still keyed by ws sid: the same agent runs
// the auth flow with only one user at a time; sid is an appropriate reverse-lookup key.
// (globalGrants has been moved up to be defined before researchToolAdapters.)

/** TimelineRetriever singleton: pulls context fragments from the raw global timeline before each LLM call */
const timelineRetriever = new TimelineRetriever(memory.raw);

/**
 * Timeline recall budget is adjustable via environment variables.
 * K8 tuning (2026-04-27): out-of-box defaults 8K + 4K ≈ 12K tokens (with the 30-entry hard cap in timeline.ts),
 * so that the most recent ~10-15 turns clearly dominate LLM attention. The old 80K + 40K empirically caused
 * the 3 most recent key messages to be drowned out by hundreds of irrelevant old history entries.
 */
// 2026-08-11: RECENT restored to 8K after the cut to 5K. In a WeChat session the owner's turns are
// overwhelmingly continuation words ("继续" / "OK" — 14 of 20 messages in the 2026-08-09 log), so the
// recent window IS the task statement; recall contributed 0–2 messages on nearly every one of those
// turns and is the affordable half to keep small.
const TIMELINE_RECENT_BUDGET = Number(process.env.TIMELINE_RECENT_BUDGET) || 8_000;
const TIMELINE_RECALL_BUDGET = Number(process.env.TIMELINE_RECALL_BUDGET) || 2_000;

/** Paused state: waiting for the user to authorize a tool call */
interface PendingAuth {
  /** Stable task goal captured before the authorization boundary; continuation words never replace it. */
  goal: string;
  callLedger: Array<{
    id: string;
    name: string;
    state: 'completed' | 'awaiting_auth' | 'queued' | 'running' | 'uncertain';
  }>;
  /** Durable execution phase. `running` is converted to `uncertain` after a process restart. */
  executionState?: 'awaiting_auth' | 'running' | 'uncertain';
  /** When this entry became `uncertain` (restart time). Bounds the retry/skip question — see UNCERTAIN_RECOVERY_TTL_MS. */
  uncertainSince?: number;
  /** How many times we have asked for an explicit retry/skip and not understood the reply. */
  uncertainPrompts?: number;
  capability: string;
  domain:     string;
  toolName:   string;
  toolCallId: string;
  /** Original input of the suspended tool; used to reconstruct the call and retry execution after authorization */
  input: Record<string, unknown>;
  /** Remaining calls to continue executing after authorization is granted */
  remainingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** toolResults already collected (processed before authorization) */
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  /** Current iteration round */
  iteration: number;
  /**
   * K0: snapshot of the complete messages array at suspend time (including systemPrompt + history + user message +
   * assistant tool_use blocks). Reused directly on authorization resume, not rebuilt — otherwise tool_use
   * and tool_result pairing can become misaligned due to timeline recall fluctuations → LLM 400.
   */
  inflightMessages: NativeMessage[];
  /**
   * Snapshot of this turn's tool ledger at suspend time. The resume ("ok") arrives as a NEW message
   * → a fresh signalBus with an empty inTurnRecords, so same-turn honesty checks (e.g.
   * skillDeleteSucceededThisTurn) would no longer see a forget_skill/write that already succeeded
   * pre-pause and fire a FALSE "claim without call" (prod: forget_skill deleted, then deleteFile
   * needed approval → resume → skill_forget_claim_without_call fired though the delete happened).
   * Seeded back on resume so the continuation remembers what the pre-pause segment did.
   */
  priorInTurnRecords: InTurnToolRecord[];
  /** Suspend timestamp; used to expire a stale pending so a later natural-language message is not trapped in the auth flow. */
  ts: number;
  /** When the channel confirmed that the authorization card reached the owner. */
  deliveredAt?: number;
  /** Delivery-capable channels set this after attempting to send the authorization card. */
  deliveryState?: 'delivered' | 'failed';
}

const pendingAuth = new Map<string, PendingAuth>();

/** Re-sending the same card must not move the point after which owner replies are eligible to approve it. */
export function firstAuthDeliveryAt(existing: number | undefined, deliveredAt: number): number {
  return existing ?? deliveredAt;
}

/** Record channel delivery, so a reply sent before this card existed cannot authorize it after polling delay. */
export function markPendingAuthDelivered(sessionId: string, requestId: string | undefined, deliveredAt: number): boolean {
  const pending = pendingAuth.get(sessionId);
  if (!pending || (requestId && pending.toolCallId !== requestId)) return false;
  pending.deliveredAt = firstAuthDeliveryAt(pending.deliveredAt, deliveredAt);
  pending.deliveryState = 'delivered';
  persistContinuation(sessionId);
  return true;
}

/** Record a failed card delivery. The next inbound must not be interpreted as approval. */
export function markPendingAuthDeliveryFailed(sessionId: string, requestId: string | undefined): boolean {
  const pending = pendingAuth.get(sessionId);
  if (!pending || (requestId && pending.toolCallId !== requestId)) return false;
  pending.deliveryState = 'failed';
  pending.deliveredAt = undefined;
  persistContinuation(sessionId);
  return true;
}

export function inboundPredatesAuthDelivery(
  pending: { deliveredAt?: number },
  inboundSentAtMs: number | undefined,
): boolean {
  return pending.deliveredAt !== undefined && inboundSentAtMs !== undefined && inboundSentAtMs < pending.deliveredAt;
}

export type PendingAuthInboundDisposition = 'resume' | 'bypass_predelivery' | 'bypass_undelivered';

/** Decide whether this inbound is eligible to answer the pending authorization card. */
export function pendingAuthInboundDisposition(
  pending: { deliveredAt?: number; deliveryState?: 'delivered' | 'failed' } | undefined,
  inboundSentAtMs: number | undefined,
): PendingAuthInboundDisposition {
  if (pending?.deliveryState === 'failed') return 'bypass_undelivered';
  if (pending && inboundPredatesAuthDelivery(pending, inboundSentAtMs)) return 'bypass_predelivery';
  return 'resume';
}

/** Both bypass causes leave the same suspended card pending, so both must restore it to channel tail. */
export function authRequestToReissue(
  disposition: PendingAuthInboundDisposition,
  pending: {
    toolCallId: string;
    toolName: string;
    capability: string;
    domain: string;
    input: unknown;
  },
): AuthRequest | undefined {
  if (disposition === 'resume') return undefined;
  return {
    requestId: pending.toolCallId,
    toolName: pending.toolName,
    capability: pending.capability,
    domain: pending.domain,
    input: pending.input,
  };
}

/**
 * Phase 18 WS2: chat sessions where the ViabilityGate recommended stop_and_report last turn, awaiting the
 * user's decision. Keyed by chat sessionId → the reasoning session id to abandon if (and only if) the user
 * explicitly accepts stopping next turn. Counsel-only: we never auto-abandon without explicit acceptance.
 */
const viabilityStopRecommended = new Map<string, { reasoningSessionId: string; at: number }>();
const VIABILITY_STOP_RECOMMEND_TTL_MS = 30 * 60_000;

/**
 * Phase 18 WS4: reflection's persisted recommend_stop signal, keyed by chat sessionId → timestamp. Written at
 * turn close (post-reflection) when the owner reasoning session is stalled AND failing the same way repeatedly
 * (reflection's cross-turn judgment, derived mechanically from its own trigger signals rather than a fragile LLM
 * output-schema change). Read the next turn pre-LLM into signalBus.recommendStop, arming the ViabilityGate (+3).
 */
const viabilityRecommendStop = new Map<string, number>();
const VIABILITY_RECOMMEND_STOP_TTL_MS = 30 * 60_000;

/**
 * Phase 18 ratchet (2026-06-16): consecutive turns this chat session got a non-continue viability verdict.
 * Passed into computeViability as repeatedPivotCount so a long pivot streak escalates to stop — generalizing
 * intractable to goals with no curated barrier. Reset to 0 the moment a turn comes back 'continue'.
 */
const viabilityPivotStreak = new Map<string, number>();

/**
 * 2026-06-17 episode anchor: epoch ms of the start of the CURRENT research episode for a chat session. Set
 * when the user overrides a stop / redirects to a new direction. Floors the same_root_cause failure window so
 * a fresh direction does not inherit the previous direction's accumulated "撞墙" count — the fix for the prod
 * loop where the gate declared a brand-new direction dead on 0 attempts. See the doom-reset block.
 */
const episodeAnchorTs = new Map<string, number>();

/**
 * Last prompt seen per scheduled session, so a re-fire of the SAME stored prompt can be told apart from the
 * owner actually editing the schedule. A scheduled task replays byte-identical text forever; the doom-reset
 * read that as "the user overrode the stop" and cleared the accounting on every fire. Comparing against the
 * previous prompt keeps a real edit working (that IS a new instruction) while a replay is not.
 */
const lastScheduledPrompt = new Map<string, string>();

/** True when this is a scheduled session re-firing the exact prompt it fired last time — nobody said this. */
export function isScheduledPromptReplay(
  sessionId: string,
  userMessage: string,
  seen: Map<string, string> = lastScheduledPrompt,
): boolean {
  if (!sessionId.startsWith('system:scheduled:')) return false;
  const prev = seen.get(sessionId);
  seen.set(sessionId, userMessage);
  return prev !== undefined && prev === userMessage;
}

/**
 * 2026-06-17: injected when the user approves a concrete next step the agent proposed last turn ("要我开始吗"
 * → "继续/启动"). Forces this turn to EXECUTE rather than re-analyze/re-propose — the prod failure where the
 * agent answered 8 "继续"s with 8 wall-reports and 0 executions.
 */
const COMMIT_TO_EXECUTION_DIRECTIVE =
  '\n\n[commit-to-execution] Last turn you proposed a concrete next step and asked the user to proceed — they ' +
  'just approved. EXECUTE that step now: actually call the tools to do the work (run the search, write+run the ' +
  'code, start the deep_explore round). This turn is for execution, not analysis. Do NOT re-assess whether the ' +
  'direction is viable, do NOT declare a wall before running it, do NOT switch to a different direction, and do ' +
  'NOT ask "要我开始吗 / shall I continue?" again. Make at least one real execution attempt before reporting.';

/**
 * 2026-06-17: injected when the user redirects / overrides a stop. Anchors the turn on the user's literal
 * instruction and forbids substituting a previously-closed direction (prod: asked for "Erdős long-tail
 * problems", the agent resumed Erdős–Straus — a famous problem it had already closed twice).
 */
function buildAntiSubstitutionDirective(userMessage: string): string {
  const ask = userMessage.replace(/\s+/g, ' ').trim().slice(0, 120);
  return (
    `\n\n[stay-on-target] The user's current instruction is the authoritative goal for this turn: "${ask}". ` +
    'Pursue exactly that. Do NOT resume, restate, or fall back to a direction you previously declared dead or ' +
    'closed (a different problem you already gave up on) unless the user explicitly named it. If their ' +
    'instruction is a CATEGORY (e.g. "the long-tail problems in set X"), work inside that category — do not ' +
    'substitute a famous hard problem you happen to remember.'
  );
}

/** Most recent assistant message text in the window (string content or joined text blocks); '' if none. */
function lastAssistantText(msgs: NativeMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
        .join(' ');
    }
  }
  return '';
}

/**
 * Phase 18 WS5: workflow grant. When the user approves one local write/execute tool, also grant these sibling
 * local workflow tools (same capability) so a coherent multi-step local workflow flows without re-prompting at
 * each step. Destructive deleteFile is intentionally absent (keeps per-call confirmation).
 */
// Research-workflow grant set + applier live in research_grant.ts (LOCAL_RESEARCH_WORKFLOW /
// localWorkflowGrants), keyed by (tool, capability, domain) so one approval covers the whole local loop.

// skill-reflex (2026-06-17): sessionIds already nudged once to search_skills before hand-rolling a
// document parser. One nudge per session, then parser shells run as-is (no loop).
const skillReflexNudged = new Set<string>();

/**
 * pendingAuth TTL. After this, a pending tool is abandoned and the user's next message is handled as
 * a normal turn (no auth re-prompt), so questions like "is the session still active?" are answered
 * instead of being bounced as "please reply allow/deny". Keyed by ws sid like the rest of the auth state.
 *
 * Defaults to 30 minutes to accommodate long-running local workflows and delayed channel replies.
 * It remains independently configurable from the post-approval workflow grant.
 * Previously it stayed at 10 minutes. It was briefly raised to 30 to stop late replies being eaten — in the
 * 2026-08-09 log the owner's reply gap ran 8 min at the median with a 35–60 min tail, and 12:43:29's
 * "OK" arrived 35.6 min late, was dropped in silence, and cost a second "ok" 21 seconds later.
 *
 * That reasoning conflated two different windows. WORKFLOW_GRANT_TTL_MS is 30 minutes because the
 * owner SAID YES and that yes should cover the loop it authorised. This window is the opposite state:
 * nothing has been approved, and widening it only widens the gap in which an "OK" can land on a
 * request the owner has stopped meaning. And the specific harm that motivated the raise — the eaten
 * approval — was the silence, not the ten minutes: an expired card is now dropped before it can
 * poison the context, the turn says the request expired and re-issues it, and the owner's message is
 * answered instead of consumed. With that fixed, the case for a longer unapproved window is gone.
 *
 * PHILONT_PENDING_AUTH_TTL_MS overrides it for deployments that want a different tradeoff.
 */

/**
 * How long an `uncertain` (process died mid-execution) entry may keep asking the owner for an explicit
 * retry/skip before it gives up and records the call as unresolved. Without a bound the question is a
 * trap: the reply words are matched deterministically (as they must be — they are OUR words), so any
 * other message re-asks, and the owner's two most common messages are exactly the two that do not match.
 */
const UNCERTAIN_RECOVERY_TTL_MS = 30 * 60_000;
/** …or after this many unrecognised replies, whichever comes first. */
const UNCERTAIN_RECOVERY_MAX_PROMPTS = 2;

/** deep_explore grant window — longer than the 12-min round deadline so one approval covers a multi-round session (see the pendingAuth grant path). */
const DEEP_EXPLORE_GRANT_TTL_MS = 60 * 60_000;

/**
 * Paused state: triggered by the askUserQuestion tool; waits for the user to choose an option or provide a free-text answer in the next message.
 *
 * Sibling pattern to pendingAuth: both save inflightMessages + remainingCalls +
 * collectedResults so the next turn can directly resume into runToolLoop.
 *
 * At most one per session at a time; not mutually exclusive here (in theory askUserQuestion's
 * read/local path will not trigger pendingAuth), but outer handleChatSend checks pendingAuth first.
 */
interface PendingQuestion {
  /** Stable task goal captured before the question boundary. */
  goal: string;
  callLedger: Array<{ id: string; name: string; state: 'completed' | 'awaiting_user' | 'queued' }>;
  toolCallId: string;
  question: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
  allowFreeText: boolean;
  remainingCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  iteration: number;
  inflightMessages: NativeMessage[];
  /** Creation timestamp, used for expiry detection */
  createdAt: number;
}

const pendingQuestion = new Map<string, PendingQuestion>();
/** Maximum wait time for the user to reply to askUserQuestion; expired requests are treated as "abandoned" */
const QUESTION_TTL_MS = 10 * 60_000;

/**
 * A snapshot that is merely WAITING (nobody ran anything) is worthless once its window has passed —
 * restoring it makes the next unrelated message resume an hours-old conversation. A snapshot that was
 * RUNNING is the opposite: an external side effect may already have committed, so it must survive
 * regardless of age and be resolved by the owner, never by a clock.
 */
/**
 * Has this authorization request timed out? The single definition, used both when a turn starts and
 * when the auth branch runs — the defect was never the check, it was that only one place had it and
 * that place ran after the message array was already built.
 *
 * `running` / `uncertain` never time out: they describe a call that may already have touched the
 * world, and only the owner can resolve that.
 */
export function pendingAuthIsStale(
  pending: { ts: number; deliveredAt?: number; executionState?: 'awaiting_auth' | 'running' | 'uncertain' } | undefined,
  now: number,
): boolean {
  if (!pending) return false;
  if (pending.executionState === 'running' || pending.executionState === 'uncertain') return false;
  // A delivery-capable channel may spend much of the TTL retrying a card the owner has not seen.
  // Once delivery succeeds, the owner's response window starts there, not at internal creation.
  return isPendingAuthExpired(pending.deliveredAt ?? pending.ts, now);
}

/**
 * Which message array this turn starts from. A suspended state's inflight messages carry assistant
 * tool_use blocks that only its own resume path answers, so they may be used ONLY while that state is
 * still live. This function, not the order of statements in handleChatSend, is what makes that true.
 */
export type TurnContextSource = 'auth-inflight' | 'question-inflight' | 'fresh';

export function selectTurnContextSource(
  auth: { ts: number; executionState?: 'awaiting_auth' | 'running' | 'uncertain' } | undefined,
  question: { createdAt: number } | undefined,
  now: number,
  bypassAuth = false,
  bypassQuestion = false,
): { source: TurnContextSource; dropAuth: boolean } {
  if (auth && pendingAuthIsStale(auth, now)) {
    return { source: question && !bypassQuestion ? 'question-inflight' : 'fresh', dropAuth: true };
  }
  if (auth && bypassAuth) {
    return { source: question && !bypassQuestion ? 'question-inflight' : 'fresh', dropAuth: false };
  }
  if (auth) return { source: 'auth-inflight', dropAuth: false };
  if (question && bypassQuestion) return { source: 'fresh', dropAuth: false };
  if (question) return { source: 'question-inflight', dropAuth: false };
  return { source: 'fresh', dropAuth: false };
}

export function continuationSurvivesRestart(
  stored: { savedAt?: number; auth?: unknown; question?: unknown },
  now: number,
): { auth: boolean; question: boolean } {
  const auth = stored.auth as PendingAuth | undefined;
  const question = stored.question as PendingQuestion | undefined;
  const authSurvives = auth
    ? !pendingAuthIsStale({ ...auth, ts: auth.ts ?? stored.savedAt ?? 0 }, now)
    : false;
  const questionSurvives = question
    ? now - (question.createdAt ?? stored.savedAt ?? 0) <= QUESTION_TTL_MS
    : false;
  return { auth: authSurvives, question: questionSurvives };
}

for (const stored of loadContinuations()) {
  const survives = continuationSurvivesRestart(stored, Date.now());
  if (stored.auth && survives.auth) {
    const auth = stored.auth as PendingAuth;
    // A process cannot know whether an external side effect committed just before it died.
    // Never replay such a call automatically: require an explicit retry/skip decision.
    if (auth.executionState === 'running') {
      auth.executionState = 'uncertain';
      auth.uncertainSince = Date.now();
      auth.uncertainPrompts = 0;
      auth.callLedger = (auth.callLedger ?? []).map((entry) =>
        entry.id === auth.toolCallId ? { ...entry, state: 'uncertain' as const } : entry,
      );
      try { saveContinuation({ ...stored, auth }); } catch { /* live state still recovers in memory */ }
    }
    pendingAuth.set(stored.sessionId, auth);
  }
  if (stored.question && survives.question) {
    pendingQuestion.set(stored.sessionId, stored.question as PendingQuestion);
  }
  if ((stored.auth && !survives.auth) || (stored.question && !survives.question)) {
    console.log(
      `[continuation-store] dropped expired snapshot for ${safeSessionId(stored.sessionId)} ` +
        `(auth=${stored.auth ? (survives.auth ? 'kept' : 'dropped') : 'none'}, ` +
        `question=${stored.question ? (survives.question ? 'kept' : 'dropped') : 'none'})`,
    );
    // Rewrite the file so the dropped half cannot come back on the next restart.
    try {
      if (!survives.auth && !survives.question) deleteContinuation(stored.sessionId);
      else
        saveContinuation({
          ...stored,
          auth: survives.auth ? stored.auth : undefined,
          question: survives.question ? stored.question : undefined,
        });
    } catch { /* best effort: the in-memory decision above already holds */ }
  }
}

// The words below are OURS — the recovery prompt offers exactly "重试" / "跳过", so reading them back is
// exact matching, not semantic classification (a general classifier has already read one of our own
// offered words as its opposite; see classifyExploreAskReply). What must NOT be exact is the tail: a
// person answering a two-option question types "重试吧" / "跳过这个", and rejecting those re-asks forever.
const UNCERTAIN_RETRY_WORDS = ['重新执行', '重试', 'run again', 'retry'];
const UNCERTAIN_SKIP_WORDS = ['不要重试', '不重试', '跳过', 'do not retry', "don't retry", 'skip'];
/** Sentence-final particles / punctuation that carry no decision content. */
const UNCERTAIN_REPLY_TAIL_RE = /^[\s吧呀啊了下它他这那个么吗，,。.!！?？~、]*$/;

function matchesOfferedWord(normalized: string, words: readonly string[]): boolean {
  return words.some(
    (w) => normalized === w || (normalized.startsWith(w) && UNCERTAIN_REPLY_TAIL_RE.test(normalized.slice(w.length))),
  );
}

/**
 * Close a suspended tool chain: one tool_result for the interrupted call and one for every call still
 * queued behind it, so nothing in the message array is left unanswered.
 *
 * The two reasons are kept apart because they are different facts about the world. `declined` is the
 * owner saying no. `unresolved` is nobody saying anything — the recovery question ran out its bound.
 * Writing "the user chose not to retry" in the second case is a fabrication, and it is one the model
 * would then repeat to the owner, the audit trail would store, and the learning judge would score.
 * Neither one is ever replayed; only one of them is a decision.
 */
export function closeSuspendedToolChain(
  pending: {
    toolCallId: string;
    remainingCalls: ReadonlyArray<{ id: string }>;
    collectedResults: ReadonlyArray<{ type: 'tool_result'; tool_use_id: string; content: string }>;
  },
  reason: 'declined' | 'unresolved',
): Array<{ type: 'tool_result'; tool_use_id: string; content: string }> {
  const head =
    reason === 'declined'
      ? '⚠ TOOL RESULT UNCERTAIN — the process restarted while this tool was executing and the user ' +
        'explicitly chose not to retry it. Whether the external side effect committed is unknown; ' +
        'verify external state before claiming success.'
      : '⚠ TOOL RESULT UNRESOLVED — the process restarted while this tool was executing, and NO explicit ' +
        'retry/skip decision was ever received. Whether the external side effect committed is unknown. ' +
        'It will not be replayed. Do not say that it ran, and do not say that the user declined it — ' +
        'nobody decided. If it matters to the current request, check the external state read-only first.';
  const tail =
    reason === 'declined'
      ? 'Skipped because the preceding tool result is uncertain after a process restart.'
      : 'Skipped because the preceding tool result is unresolved after a process restart.';
  return [
    ...pending.collectedResults,
    { type: 'tool_result' as const, tool_use_id: pending.toolCallId, content: head },
    ...pending.remainingCalls.map((call) => ({
      type: 'tool_result' as const,
      tool_use_id: call.id,
      content: tail,
    })),
  ];
}

/**
 * tool_use_id → tool name for the call ledger. Completed entries were being written with the literal
 * string `'completed'` in their `name` field, which threw away the one thing the ledger exists to
 * answer: after a restart mid-chain, WHICH tools already ran. Ids from an earlier segment are not in
 * this batch and honestly resolve to `unknown`.
 */
export function ledgerToolName(id: string, known: ReadonlyArray<{ id: string; name: string }>): string {
  return known.find((c) => c.id === id)?.name ?? 'unknown';
}

export function classifyUncertainToolReply(text: string): 'retry' | 'skip' | 'unknown' {
  const normalized = text.trim().toLowerCase();
  // SKIP first: "不要重试" contains "重试".
  if (matchesOfferedWord(normalized, UNCERTAIN_SKIP_WORDS)) return 'skip';
  if (matchesOfferedWord(normalized, UNCERTAIN_RETRY_WORDS)) return 'retry';
  return 'unknown';
}

function persistContinuation(sessionId: string): void {
  try {
    const auth = pendingAuth.get(sessionId);
    const question = pendingQuestion.get(sessionId);
    if (!auth && !question) {
      deleteContinuation(sessionId);
      return;
    }
    saveContinuation({ version: 1, sessionId, savedAt: Date.now(), auth, question });
  } catch (e) {
    // Durability is a recovery aid; a transient disk problem must not break the live turn.
    console.warn('[continuation-store] persist failed; keeping in-memory continuation', e);
  }
}

/**
 * Settle an authorization continuation as soon as its tool returns, not when the whole LLM turn later
 * finishes. A turn may spend minutes compiling/reasoning after the side effect already committed. If the
 * process restarts in that interval, leaving the snapshot as `running` turns a known-successful call into
 * `uncertain` and invites the owner to execute it twice (production: the same append patch was replayed
 * after restart). The remaining tool chain may be abandoned safely; a later call that needs approval will
 * create its own fresh continuation.
 */
export function settleRunningAuthState<T extends {
  toolCallId: string;
  executionState?: string;
  callLedger?: Array<{ id: string; state: string; [key: string]: unknown }>;
}>(entries: Map<string, T>, sessionId: string, toolCallId: string, persist: () => void): T | null {
  const pending = entries.get(sessionId);
  if (!pending || pending.toolCallId !== toolCallId || pending.executionState !== 'running') return null;
  pending.callLedger = (pending.callLedger ?? []).map((entry) =>
    entry.id === toolCallId ? { ...entry, state: 'completed' as const } : entry,
  );
  entries.delete(sessionId);
  persist();
  return pending;
}

function settleRunningPendingAuth(sessionId: string, toolCallId: string): boolean {
  const pending = settleRunningAuthState(pendingAuth, sessionId, toolCallId, () => persistContinuation(sessionId));
  if (!pending) return false;
  console.log(
    `[continuation-store] session=${safeSessionId(sessionId)} settled completed auth call ${pending.toolName} ` +
      `before continuing the turn`,
  );
  return true;
}

// Track active sessions for extraction at session end
const activeSessions = new Set<string>();

// ── Skill hot-reload ──────────────────────────────────────────────────────────
// skillsRevision increments on every skill set change (create/update/delete).
// Each session tracks its own "last seen" revision; if they differ when processing a new message → inject an update notification.
let skillsRevision = 0;
const sessionSkillsRevision = new Map<string, number>();

memory.skills.on('changed', () => {
  skillsRevision++;
});

// Filesystem watcher: when the user creates/edits a SKILL.md under .philont/skills/ → re-import
const workspaceSkillsDir = join(process.cwd(), '.philont', 'skills');
const globalSkillsDir = join(homedir(), '.philont', 'skills');
// Built-in skills: published under agent-tools/bundled-skills/ as philont's out-of-the-box knowledge base.
// Priority < workspace < global; any user-level directory's same-name skill can override it.
// Path is relative to server/src/chat-handler.ts → ../../agent-tools/bundled-skills
export const bundledSkillsDir = join(MODULE_DIR, '..', '..', 'agent-tools', 'bundled-skills');

export async function reloadSkillsFromDisk(): Promise<void> {
  try {
    const parsed = await loadSkills(process.cwd(), [bundledSkillsDir]);
    // Note: even if parsed.length === 0, run the prune below — when all external skill files are deleted at once,
    // the DB must still be cleaned up.
    let imported = { created: [] as string[], updated: [] as string[] };
    if (parsed.length > 0) {
      // 2026-05-09 v15: pass routingRules → when bundled / locally handwritten skills are loaded,
      // automatically write a 'auto:bundled:<name>' routing rule with confidence='tentative'
      // (based on the SKILL.md frontmatter `when_to_use:` text). Reflection-generated skills
      // do not go through this path (routing_bundled skips 'self:*' sources).
      imported = importSkills(memory.skills, parsed, {
        onConflict: 'replace',
        routingRules: memory.routingRules,
      });
    }

    // Prune: compare disk with the "external skills" in SkillStore (source IS NOT NULL);
    // the diff is orphan rows — directories deleted by uninstallSkill / manual user rm / clawhub uninstall
    // but DB rows still remain. Delete each skill individually to refresh the index.
    //
    // Safety guarantee: locally handwritten / reflection-generated (source IS NULL) skills never appear in
    // listExternalSkills() results and will never be accidentally deleted.
    const parsedNames = new Set(parsed.map((p) => p.name));
    const orphans = memory.skills.listExternalSkills().filter((s) => !parsedNames.has(s.name));
    for (const orphan of orphans) {
      memory.skills.deleteSkill(orphan.name);
    }

    if (imported.created.length + imported.updated.length + orphans.length > 0) {
      console.log(
        `[skills-hotreload] ${imported.created.length} created, ${imported.updated.length} updated, ` +
        `${orphans.length} prune (${orphans.map((s) => s.name).join(',')})`
      );
    }
  } catch (e) {
    console.warn('[skills-hotreload] load failed:', e);
  }
}

// Explicitly run once at startup — bundled skills are in SkillStore at least after the first startup.
// This is a fire-and-forget promise (does not block module loading; ready for use by subsequent turns).
reloadSkillsFromDisk().then(() => {
  const all = memory.skills.listAll(200);
  console.log(`[skills] startup loaded total ${all.length} skills (incl. bundled)`);
}).catch((e) => {
  console.warn('[skills] startup load failed:', e);
});

// fs.watch throws on non-existent directories → degrades to no-op; files created under that path later will not trigger.
// ensureDir at startup serves as fallback: keeps the watcher truly alive rather than "apparently mounted but actually dead".
for (const dir of [workspaceSkillsDir, globalSkillsDir]) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[skills] ensureDir failed ${dir}:`, e);
  }
}

// Start watchers for two directories; if a directory does not exist, no-op (in theory should not happen after ensureDir).
// Not under test: an fs.watch handle keeps the event loop alive forever, and these two were the reason the
// test process never exited (measured: ACTIVE_HANDLES = 2x FSWatcher). See UNDER_TEST.
const workspaceWatcher = UNDER_TEST ? null : watchSkillDir(workspaceSkillsDir, reloadSkillsFromDisk);
const globalWatcher = UNDER_TEST ? null : watchSkillDir(globalSkillsDir, reloadSkillsFromDisk);

/** Release watchers on process exit (for testing or lifecycle management) */
export function closeSkillWatchers(): void {
  workspaceWatcher?.close();
  globalWatcher?.close();
}

// ── Scheduler: proactive time-driven behavior ────────────────────────────────────
/**
 * Reminder emitter that proactively pushes to the frontend. The WS layer in index.ts subscribes to this emitter;
 * the scheduler proactively pushes via WS to active sessions each time a 'prompt'-type task expires.
 */
export interface ReminderPayload {
  scheduleName: string;
  text: string;
  at: number;
}
export const reminderEmitter = new EventEmitter();

const scheduler = startScheduler(
  memory.schedules,
  async (s: Schedule) => {
    const payload = (s.payload ?? {}) as Record<string, unknown>;
    const label = `[schedule ${s.name}]`;
    switch (s.actionType) {
      case 'prompt': {
        const message = typeof payload.message === 'string'
          ? payload.message
          : `Scheduled reminder: ${s.name}`;
        console.log(`${label} prompt → "${message}"`);
        reminderEmitter.emit('reminder', {
          scheduleName: s.name,
          text: message,
          at: Date.now(),
        } satisfies ReminderPayload);
        return;
      }
      case 'reflect': {
        const targetSessionId = typeof payload.sessionId === 'string'
          ? payload.sessionId
          : null;
        if (targetSessionId) {
          try {
            const result = await reflector.reflectFromSession(targetSessionId);
            console.log(
              `${label} reflect on ${safeSessionId(targetSessionId)}: ${result.skillsCreated} created`
            );
          } catch (e) {
            console.warn(`${label} reflect failed:`, e);
          }
        } else {
          console.log(`${label} reflect: missing payload.sessionId, skipped`);
        }
        return;
      }
      case 'tool_call': {
        // Security-sensitive: MVP only records audit log; actual execution deferred to Phase 6.5 integration with PolicyGate
        console.warn(
          `${label} tool_call scheduled and due but not executed (policy layer not wired in). ` +
            `payload: ${JSON.stringify(payload).slice(0, 200)}`
        );
        return;
      }
      case 'autonomous_turn': {
        // 2026-05-07: system-driven real chat turn, not a passive reminder.
        // Runs the full chat-handler: routing inject / failure_recovery / drives /
        // tools all present, but sessionId is independent (system:scheduled:<name>) and does not mix with user sessions.
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        if (!prompt.trim()) {
          console.warn(`${label} autonomous_turn: missing payload.prompt, skipped`);
          return;
        }
        // Default is now on-change (see scheduleRunFingerprint). 'silent' and 'summary' still mean
        // exactly what they meant to anyone who set them on purpose.
        const replyChannel: ScheduleReplyChannel =
          payload.replyChannel === 'summary'
            ? 'summary'
            : payload.replyChannel === 'silent'
              ? 'silent'
              : 'on-change';
        const turnSessionId = `system:scheduled:${s.name}`;
        const startTs = Date.now();
        let finalText = '';
        try {
          await handleChatSend(
            turnSessionId,
            prompt,
            // onDelta: write to timeline; silent mode does not push to channel
            (token) => { finalText += token; },
            // onAuthRequest: autonomous turn is non-interactive; directly deny (audit recorded)
            (req) => {
              console.warn(
                `${label} autonomous turn triggered auth request (denied): tool=${req.toolName} ` +
                  `cap=${req.capability}/${req.domain}`,
              );
            },
            // onStatus: only logged to console; not pushed to channel
            (status) => { console.log(`${label} status: ${status}`); },
          );
          const dur = Date.now() - startTs;
          console.log(`${label} autonomous_turn done durationMs=${dur} replyText=${finalText.length}b`);
          internalAudit.append('schedule_autonomous_turn_done', {
            scheduleName: s.name,
            sessionId: turnSessionId,
            durationMs: dur,
            replyTextLen: finalText.length,
            replyChannel,
          });
          // v16: one success resets failure count + clears pause. BUT a non-throwing turn is not
          // automatically progress — an honest "partial (0/N), every http 401'd" report returns
          // normally yet made no real progress. The turn-finalization block records that verdict in
          // scheduledTurnProgress; a no-progress turn is routed to recordFailure so the 1h auto-pause
          // can arm (otherwise recordSuccess resets the counter every fire → the schedule never dies).
          const progress = scheduledTurnProgress.get(turnSessionId);
          scheduledTurnProgress.delete(turnSessionId);
          if (progress && !progress.madeProgress) {
            try {
              const before = s.pausedUntil ?? 0;
              const updated = memory.schedules.recordFailure(s.id, Date.now());
              const after = updated?.pausedUntil ?? 0;
              console.warn(
                `${label} turn made NO real external progress → recordFailure ` +
                  `(consecutiveFailures=${updated?.consecutiveFailures ?? '?'})`,
              );
              if (updated && after > before && after > Date.now()) {
                const remainMin = Math.round((after - Date.now()) / 60000);
                console.warn(`${label} 🛑 auto-paused for ${remainMin} minutes after repeated no-progress fires`);
                internalAudit.append('schedule_auto_paused', {
                  scheduleName: s.name, scheduleId: s.id,
                  consecutiveFailures: updated.consecutiveFailures,
                  pausedUntil: after, pauseDurationMs: after - Date.now(),
                  reason: 'no_external_progress',
                });
                reportSchedulePaused({
                  scheduleName: s.name,
                  consecutiveFailures: updated.consecutiveFailures,
                  pausedUntilTs: after,
                  reason: 'no_external_progress',
                });
              }
            } catch (e) {
              console.warn(`${label} recordFailure (no-progress) failed (ignored):`, (e as Error)?.message ?? e);
            }
          } else {
            try { memory.schedules.recordSuccess(s.id); } catch (e) {
              console.warn(`${label} recordSuccess failed (ignored):`, (e as Error)?.message ?? e);
            }
          }
          // Report to the owner. Two runs are read back: [0] is this run (its outcome row was written
          // during the turn), [1] is the previous one — comparing their fingerprints is what makes
          // "nothing changed again" silent without making the schedule silent.
          if (finalText.trim()) {
            try {
              const recent = memory.scheduleOutcomes.recent(s.name, 2);
              const fp = recent[0] ? scheduleRunFingerprint(recent[0]) : 'unknown';
              const prevFp = recent[1] ? scheduleRunFingerprint(recent[1]) : undefined;
              if (shouldReportScheduledRun(replyChannel, fp, prevFp)) {
                const text = finalText.slice(0, 500);
                console.log(
                  `[schedule-report] ${s.name} → owner (mode=${replyChannel}, ` +
                    `${prevFp === undefined ? 'first run' : prevFp === fp ? 'forced' : `changed ${prevFp} → ${fp}`})`,
                );
                // Web-ui, as before.
                reminderEmitter.emit('reminder', {
                  scheduleName: s.name,
                  text,
                  at: Date.now(),
                } satisfies ReminderPayload);
                // ...and the push channels. reminderEmitter is wired ONLY to the web-ui WS, so even an
                // explicit replyChannel:'summary' never reached WeChat or Telegram. digest severity, so
                // the dispatcher's rate limit and quiet hours still apply.
                void pushDispatcher
                  .enqueue({
                    severity: 'digest',
                    kind: 'schedule_report',
                    // Fingerprint in the targetRef on purpose: the dispatcher dedups (kind, targetRef)
                    // for 24h, so a bare `schedule:<name>` would swallow the SECOND change of the day —
                    // exactly the one worth hearing about.
                    targetRef: `schedule:${s.name}:${fp}`,
                    text: `⏰ ${s.name}\n${text}`,
                  })
                  .catch((e) => console.warn('[schedule-report] push dispatch threw', e));
              } else {
                console.log(`[schedule-report] ${s.name} suppressed — outcome unchanged (${fp})`);
              }
            } catch (e) {
              console.warn('[schedule-report] reporting failed (ignored):', (e as Error)?.message ?? e);
            }
          }
        } catch (e) {
          const dur = Date.now() - startTs;
          console.error(`${label} autonomous_turn failed durationMs=${dur}:`, (e as Error)?.message ?? e);
          internalAudit.append('schedule_autonomous_turn_failed', {
            scheduleName: s.name,
            sessionId: turnSessionId,
            durationMs: dur,
            error: String((e as Error)?.message ?? e).slice(0, 200),
          });
          // v16: each failure increments the counter → auto-pauses for 1h when threshold is reached
          try {
            const before = s.pausedUntil ?? 0;
            const updated = memory.schedules.recordFailure(s.id, Date.now());
            const after = updated?.pausedUntil ?? 0;
            if (updated && after > before && after > Date.now()) {
              const remainMin = Math.round((after - Date.now()) / 60000);
              console.warn(
                `${label} 🛑 ${updated.consecutiveFailures} consecutive failures, auto-paused for ${remainMin} minutes (until ${new Date(after).toISOString()})`,
              );
              internalAudit.append('schedule_auto_paused', {
                scheduleName: s.name,
                scheduleId: s.id,
                consecutiveFailures: updated.consecutiveFailures,
                pausedUntil: after,
                pauseDurationMs: after - Date.now(),
                reason: 'run_failed',
              });
              reportSchedulePaused({
                scheduleName: s.name,
                consecutiveFailures: updated.consecutiveFailures,
                pausedUntilTs: after,
                reason: 'run_failed',
              });
            }
          } catch (e2) {
            console.warn(`${label} recordFailure failed (ignored):`, (e2 as Error)?.message ?? e2);
          }
        }
        return;
      }
    }
  },
  {
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS) || 30_000,
  }
);

/** Stop the scheduler on process exit */
export function closeScheduler(): void {
  scheduler.stop();
}

/** Stop the idle-consolidator timer + wait for in-flight ticks to drain during graceful shutdown. Idempotent. */
export async function closeIdleConsolidator(): Promise<void> {
  await idleConsolidator.stop();
}

/** Shut down the autonomous loop. Idempotent. */
export async function closeAutonomousLoop(): Promise<void> {
  await autonomousLoop.stop();
  deepExploreAutoAdvance.stop();
}

/**
 * Shut down FetchedResourceStore — flush manifest to disk. Idempotent.
 * gracefulShutdown should be called before memory.close().
 */
export function closeFetchedStore(): void {
  fetchedStore.close();
}

// ── Drive runtime helpers ───────────────────────────────────────────────────

/**
 * Take the last N entries from messages[] (filter to text-role messages and normalize to role+content) for drive observation.
 * Filters out structured messages like tool_result; keeps only user/assistant text.
 */
function toRecentMessages(
  messages: NativeMessage[],
  limit: number,
): RecentMessage[] {
  const out: RecentMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text =
      typeof m.content === 'string'
        ? m.content
        : // content may be an array (tool_use / tool_result); only take the string path here
          null;
    if (text === null) continue;
    out.push({ role: m.role, content: text });
  }
  out.reverse();
  return out;
}

/**
 * Collect observations after a drive fires this turn:
 *   - fact / note ids created this turn (after turnStartTs) → source of positive signals
 *   - tool call summary for this turn (from memory.actions) → success ratio
 * Does not collect pursuit progress: the current per-turn path has no pursuit progress writes;
 * Reflector will scan at the session level.
 */
function collectTurnObservations(
  sessionId: string,
  turnStartTs: number,
): { toolCalls: TsToolCallSummary[]; newFactIds: string[]; newNoteIds: string[] } {
  const db = memory.db;
  const newFacts = db
    .prepare<[number]>(
      `SELECT id FROM memory_facts WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(turnStartTs) as Array<{ id: string }>;
  const newNotes = db
    .prepare<[number]>(
      `SELECT id FROM memory_notes WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(turnStartTs) as Array<{ id: string }>;
  // K0: actions are recorded under GLOBAL_TIMELINE_SESSION_ID; timestamp window delineates the current turn
  const actions = db
    .prepare<[string, number]>(
      `SELECT tool_name, success, result FROM memory_actions
       WHERE session_id = ? AND timestamp >= ?
       ORDER BY timestamp`,
    )
    .all(GLOBAL_TIMELINE_SESSION_ID, turnStartTs) as Array<{
    tool_name: string;
    success: number;
    result: string | null;
  }>;
  return {
    toolCalls: actions.map((a) => ({
      toolName: a.tool_name,
      success: a.success === 1,
      resultSnippet: (a.result ?? '').slice(0, 120),
    })),
    newFactIds: newFacts.map((f) => f.id),
    newNoteIds: newNotes.map((n) => n.id),
  };
}

/**
 * Construct "skill directory updated" notification text for mid-session injection.
 * Only lists name + one-line description to control token cost.
 */
function buildSkillUpdateMessage(): string {
  const topSkills = memory.skills.listAll(10);
  if (topSkills.length === 0) return '';
  const lines = topSkills.map((s) => `  - ${s.name}: ${s.description}`);
  return (
    '[Memory Update] Available skill catalog has changed, current top 10:\n' +
    lines.join('\n') +
    '\n(Use use_skill(name) to retrieve the action template)'
  );
}

/**
 * Build the memory prefix: compress known structured facts into the system prompt.
 *
 * Only reads active facts in the user.* and project.* namespaces, with a compact format
 * guaranteed to be < 500 tokens. Called once at session start; unchanged for the entire session,
 * leveraging prompt cache to avoid cost amplification.
 *
 * Appended at the end: "state from the last conversation" — reads the most recent note
 * with id like `session-summary-<other-session>` from the notes table (written by Compactor / finalizeSession),
 * allowing a new session to continue from where the previous conversation left off.
 */
/**
 * Memory prefix hard limit: prevents "memory contamination" across sessions from blowing up the LLM window right from session start.
 * This is **the most fatal bug source** caught in production: Compactor wrote an oversized summary note for a very long conversation;
 * loading that note in a new session immediately consumed 2M+ tokens.
 *
 * - Per session-summary injection cap: 3KB (a genuinely useful summary will not exceed this)
 * - Per userFacts / projectFacts value injection cap: 1KB
 * - Total prefix cap: configurable, 24KB by default, leaving room for current-task context
 */
const MEMORY_PREFIX_TOTAL_CAP = Number(process.env.MEMORY_PREFIX_TOTAL_CAP) || 24_000;
const SESSION_SUMMARY_INJECT_CAP = 3_000;
const FACT_VALUE_INJECT_CAP = 1_000;
const FACT_SECTION_INJECT_CAP = 6_000;
/**
 * Phase 13 plan.md auto-inject cap (2026-05-23): scheduled session injects the full plan.md;
 * production mycox after N runs saw Lessons + Recent Runs grow to 25KB, which together with other sections
 * pushed the prefix past the 40K cap. Truncated here — the LLM gets enough to work with from the capped version
 * (Goal/Sub-tasks/Operational Knowledge are all within the first 18K); the full text is fetched explicitly via readFile.
 * 20K chars ≈ 6K tokens.
 */
const PLAN_MD_INJECT_CAP = 20_000;

function truncateForInjection(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text;
  return (
    text.slice(0, cap) +
    `\n...[${label} too long, truncated: original ${text.length} chars → keeping first ${cap}]`
  );
}

/**
 * Split the raw memory prefix by `## heading` into sections, returning each section's heading + char count.
 * Used only for overflow debugging at the end of buildMemoryPrefix; not in the hot path.
 *
 * headings shorter than 60 chars are truncated for display; the first section (content before the first `## `,
 * usually a wrapper marker) is labeled `<preamble>`.
 */
export function splitPrefixBySection(raw: string): Array<{ title: string; chars: number }> {
  const segments: Array<{ title: string; chars: number }> = [];
  const headingRe = /^## (.+)$/gm;
  let lastIdx = 0;
  let lastTitle = '<preamble>';
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(raw)) !== null) {
    const start = m.index;
    if (start > lastIdx) {
      segments.push({ title: lastTitle, chars: start - lastIdx });
    }
    lastTitle = m[1].trim().slice(0, 60);
    lastIdx = start;
  }
  if (lastIdx < raw.length) {
    segments.push({ title: lastTitle, chars: raw.length - lastIdx });
  }
  return segments.sort((a, b) => b.chars - a.chars);
}

/**
 * Priority-aware prefix trimming (2026-07-09). The old last-line-of-defense was a blunt
 * `raw.slice(0, cap)`: it cut whatever happened to be rendered LAST — typically the
 * highest-signal sections (verified working calls, self-observations, pending constitution
 * proposals, the plan-protocol teaching that ended the placeholder churn). Instead, shave the
 * tails of bulky low-priority sections first; only fall back to the blunt cut if that is not
 * enough. Pure; exported for tests.
 */
// 2026-07-21 reorder. The original ordering assumed "Lessons I have learned" was a long historical
// accumulation whose tail ages worst. It is not: it is capped at PLAYBOOK_TOP_N entries and it is the
// ONLY thing the self-learning layer puts in front of the model — reflection distils a lesson, and the
// trimmer then cut it to PREFIX_SECTION_MIN_KEEP before the prompt was sent. Prod 2026-07-21: thirteen
// consecutive turns each logged `trimmed: Lessons I have learned(-5170)`, i.e. 6170 chars shaved to the
// 1000-char floor, every single turn. The learning loop was compiling output that never shipped.
// What actually grows is "Known project information" (top-N by recency, one new entry per scheduled
// run) — it sat in 4th place and was therefore never reached. So: trim the churn-prone section FIRST
// and the learning layer's output LAST.
const PREFIX_TRIM_ORDER: readonly string[] = [
  // most churn-prone / least durable first
  'Known project information',
  'Known user information',
  'Operational Knowledge',
  'Recent Runs',
  'Extended capabilities',
  'Endpoints',
  // the self-learning layer's only channel into the prompt — sacrificed only if nothing else fits
  'Lessons I have learned',
];
const PREFIX_SECTION_MIN_KEEP = 1_000;

/**
 * Stem of a fact key with its run-identifying tail removed, used to group a recurring series.
 *
 * Derived from the key's own SHAPE — trailing segments that are pure serials, dates, times or hex ids
 * are what distinguishes one run from the next, so dropping them leaves what the series is ABOUT.
 * Deliberately carries no per-service or per-task vocabulary: a table of known key names would only
 * ever cover the series we had already been bitten by.
 *
 *   checkin-2026-07-21-13-11 → checkin        run-42        → run
 *   note-a3f9b2c1            → note           api-endpoints → api-endpoints  (nothing stripped)
 */
export function factKeyStem(key: string): string {
  const parts = key.split(/[-_.:/\s]+/).filter(Boolean);
  if (parts.length === 0) return key.toLowerCase();
  const isRunSegment = (s: string) => /^\d+$/.test(s) || /^[0-9a-f]{6,}$/i.test(s) || /^v\d+$/i.test(s);
  let end = parts.length;
  // Keep at least the first segment: a key that is ENTIRELY serial still needs an identity.
  while (end > 1 && isRunSegment(parts[end - 1])) end--;
  return parts.slice(0, end).join('-').toLowerCase();
}

/**
 * Keep only the freshest member of each recurring series, preserving input order (callers pass a
 * recency-ranked list, so the survivor is the latest run). Series of one are unaffected, so this is a
 * no-op for every fact store that has no recurring writer.
 *
 * Failure direction is deliberate: over-collapsing hides an older fact from the PROMPT only — it stays
 * in the DB and listFacts still returns it. Under-collapsing would restore the eviction this fixes.
 */
export function collapseFactSeries<T extends { key: string }>(
  ranked: readonly T[],
): { kept: T[]; collapsed: number } {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const f of ranked) {
    const stem = factKeyStem(f.key);
    if (seen.has(stem)) continue;
    seen.add(stem);
    kept.push(f);
  }
  return { kept, collapsed: ranked.length - kept.length };
}

export function trimPrefixToCap(
  raw: string,
  cap: number,
  opts: { query?: string } = {},
): { text: string; trimmed: Array<{ title: string; cut: number }> } {
  if (raw.length <= cap) return { text: raw, trimmed: [] };

  // Positional section scan (## headings), preserving order.
  const bounds: Array<{ title: string; start: number; end: number }> = [];
  const headingRe = /^## (.+)$/gm;
  let lastIdx = 0;
  let lastTitle = '<preamble>';
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(raw)) !== null) {
    if (m.index > lastIdx) bounds.push({ title: lastTitle, start: lastIdx, end: m.index });
    lastTitle = m[1].trim();
    lastIdx = m.index;
  }
  bounds.push({ title: lastTitle, start: lastIdx, end: raw.length });

  const pieces = bounds.map((b) => raw.slice(b.start, b.end));
  const trimmed: Array<{ title: string; cut: number }> = [];
  let overflow = raw.length - cap;

  const relevanceTokens = (() => {
    const q = (opts.query ?? '').toLowerCase();
    const tokens: string[] = q.match(/[a-z0-9_+-]{2,}/g) ?? [];
    const cjk = [...q.replace(/[^\p{Script=Han}]/gu, '')];
    for (let i = 0; i + 1 < cjk.length; i++) tokens.push(cjk[i]! + cjk[i + 1]!);
    return [...new Set(tokens)];
  })();
  const sectionRelevance = (prefix: string): number => {
    if (relevanceTokens.length === 0) return 0;
    const content = bounds
      .map((b, i) => b.title.startsWith(prefix) ? pieces[i].toLowerCase() : '')
      .join('\n');
    return relevanceTokens.reduce((score, token) => score + (content.includes(token) ? 1 : 0), 0);
  };
  // With a task query, sacrifice unrelated bulky sections first. Stable tie-breaking preserves the
  // historical safety order; without a query this is byte-for-byte the old behavior.
  const trimOrder = relevanceTokens.length === 0
    ? [...PREFIX_TRIM_ORDER]
    : [...PREFIX_TRIM_ORDER].sort(
        (a, b) => sectionRelevance(a) - sectionRelevance(b)
          || PREFIX_TRIM_ORDER.indexOf(a) - PREFIX_TRIM_ORDER.indexOf(b),
      );

  for (const prefix of trimOrder) {
    if (overflow <= 0) break;
    for (let i = 0; i < bounds.length && overflow > 0; i++) {
      if (!bounds[i].title.startsWith(prefix)) continue;
      const body = pieces[i];
      const trimmable = body.length - PREFIX_SECTION_MIN_KEEP;
      if (trimmable <= 0) continue;
      const marker = `\n...[section trimmed to fit the prefix cap]\n`;
      const cut = Math.min(trimmable, overflow + marker.length);
      pieces[i] = body.slice(0, body.length - cut) + marker;
      overflow -= cut - marker.length;
      trimmed.push({ title: bounds[i].title.slice(0, 60), cut });
    }
  }

  let text = pieces.join('');
  if (text.length > cap) {
    // Order exhausted and still over cap — the old blunt cut remains the true last line of defense.
    text =
      text.slice(0, cap) +
      `\n...[memory prefix too long, truncated. Original ${raw.length} chars]\n[End of memory layer]`;
  }
  return { text, trimmed };
}

/**
 * K0/K0.7: no longer depends on currentSessionId. The LLM sees a continuous timeline;
 * the concept of "last session" no longer exists — history is naturally brought back by TimelineRetriever.
 *
 * prefix now only serves as a "highly condensed long-term fact index": facts / skills / negative skills /
 * self.summary. session-summary notes are no longer specially injected — the retriever treats them as ordinary notes.
 */
/** S1 execution-ledger anchor flag. Default ON; PHILONT_EXECUTION_LEDGER=0/off/false/no disables. */
function executionLedgerEnabled(): boolean {
  const v = (process.env.PHILONT_EXECUTION_LEDGER ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** WS5 recipe reuse-verification flag (mirror of agent-memory reflector). Default ON; =0/off/false/no disables. */
function recipeReuseVerifyEnabled(): boolean {
  const v = (process.env.PHILONT_RECIPE_REUSE_VERIFY ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Assemble the capability manifest's ground-truth from LIVE runtime state — never hand-authored (see
 * capability_manifest.ts for why). Reads the real feature-flag functions, the actually-registered
 * autonomous-driver set, and the tool count, so a newly shipped+enabled capability appears with no manual
 * edit. `toolCount` is passed in because the tool registry is finalized later in module init than this fn.
 */
/** Live capability ground-truth (exported for tests / introspection): reads real flags + driver set. */
export function currentCapabilityState(): CapabilityState {
  return buildCapabilityState(tools.list().length);
}

function buildCapabilityState(toolCount: number): CapabilityState {
  return {
    skillSelfRepair: skillRepairEnabled(),
    recipeReuseVerify: recipeReuseVerifyEnabled(),
    // Versioning rides on the schema (memory_skills.revision_history, v35+); reviseRecipe is always
    // available once the column exists, which it does for any DB this build opened (migration is forced).
    skillVersioning: true,
    selfObservations: selfObservationsEnabled(),
    liveTraits: traitsLiveEnabled(),
    constitutionProposals: constitutionProposalsEnabled(),
    deepExplore: process.env.PHILONT_DEEP_EXPLORE !== '0',
    autonomousLoop: process.env.PHILONT_AUTONOMOUS !== '0',
    executionLedger: executionLedgerEnabled(),
    autonomousDrivers: autonomousDriverNames,
    toolCount,
  };
}

/**
 * S1 — execution-ledger anchor (`docs/design/execution_ledger_anchor.md`). Renders the owner's active
 * deep_explore reasoning session as an AUTHORITATIVE read-only snapshot (open frontier / proved / dead)
 * plus a generation contract: round / settlement / solved / computed claims must come from a real tool
 * result THIS TURN, not narrated from this stored snapshot. Appended to the system-prompt area at the very
 * end (recency, survives the cap), so it does NOT trip extractRecentToolResults (which parses messages,
 * not the prefix). Empty when the flag is off / there is no active session.
 *
 * P0 scope = the tree snapshot going IN (the anti-recite anchor). The this-turn tool ledger at generation
 * time is still handled by the honesty/numeric gates + force-continue; P1 folds that in here too.
 */
function buildExecutionLedger(): string[] {
  if (!executionLedgerEnabled()) return [];
  const sess = memory.reasoning.getMostRecentActiveSession(currentSessionId() ?? null);
  if (!sess) return [];
  const snap = memory.reasoning.summarizeSession(sess.id);
  if (!snap) return [];
  const goal = sess.goal.length > 80 ? sess.goal.slice(0, 80) + '…' : sess.goal;
  return [
    '## 🔒 Active reasoning — GROUND TRUTH (stored snapshot, NOT produced this turn)',
    `  goal: ${goal}`,
    `  tree: ${snap.openFrontierCount} open · ${snap.provedCount} proved · ${snap.deadCount} dead-end (session ${snap.status})`,
    '  CONTRACT: any claim of a deep_explore round / "第N轮" / settled / solved / a computed number MUST ' +
      'come from a tool you actually ran THIS TURN. The counts above are a stored snapshot — do NOT report ' +
      "them as this turn's progress. If no tool ran this turn you have NOT advanced it this turn: say so, " +
      'or call deep_explore(action=continue) now.',
  ];
}

export function buildMemoryPrefix(recallQuery: string, signalBus?: TurnSignalBus): string {
  const lines: string[] = [];

  // Runtime environment (always-on, ≤1 line): informs the LLM of the true host OS / shell so it writes correct command dialect.
  // Production pain point: LLM defaults to bash; on Windows which/heredoc/cd /d all error.
  lines.push(hostEnvPromptLine());
  lines.push('');

  // Phase 12 cont (2026-05-17): inject "this schedule's historical trace" at the top of scheduled sessions.
  // Mechanism-layer lesson accumulation channel — auto-capture (handleChatSend turn finalization record) + auto-render (inject here),
  // does not depend on the LLM reflection distillation chain. Ordinary user sessions skip this.
  {
    const sidForSched = currentSessionId();
    if (sidForSched) {
      const scheduleId = extractScheduleIdFromSession(sidForSched);
      if (scheduleId) {
        try {
          const outcomes = memory.scheduleOutcomes.recent(scheduleId, 5);
          if (outcomes.length > 0) {
            lines.push(renderScheduleOutcomesSection(outcomes, scheduleId));
            lines.push('');
          }
        } catch (e) {
          console.warn(
            `[schedule-outcomes] inject failed (ignored):`,
            (e as Error)?.message ?? e,
          );
        }
      }
    }
  }

  // Phase 13 (2026-05-17) / Phase 13.5 (2026-05-18): active project plan.md injection.
  // - scheduled session: auto-inject full plan.md (LLM must read; accumulates Lessons/Knowledge)
  // - user-driven session: only include path link; LLM decides whether to readFile based on complexity
  //
  // Phase 13.5 bug fix: scheduled session sessionId looks like `system:scheduled:mycox-
  // checkin`, which differs from the original placeholder plan's sessionId; listBySession never finds it.
  // Fix: **scheduled sessions prefer the schedule.project path** (the schedule table
  // stores the project association); non-scheduled sessions use the old listBySession path.
  {
    const sidForPlan = currentSessionId();
    if (sidForPlan) {
      try {
        let project: string | null = null;
        let isScheduled = false;
        const schedId = extractScheduleIdFromSession(sidForPlan);
        let schedPayloadText = '';
        if (schedId) {
          isScheduled = true;
          // Phase 13.5: scheduled session → find schedule by name, get schedule.project
          const sched = memory.schedules.findByName(schedId);
          if (sched?.project) project = sched.project;
          try { schedPayloadText = JSON.stringify(sched?.payload ?? ''); } catch { /* payload noise only */ }
        }
        if (!project) {
          // Non-scheduled, or schedule has no project binding → use old path (session's active plan)
          const activePlan = memory.plans.listBySession(sidForPlan, { limit: 1 })[0];
          if (activePlan?.persistedTo) project = activePlan.persistedTo;
        }
        if (project) {
          if (isScheduled) {
            // scheduled turn: auto-inject plan.md (LLM has no chance to skip)
            // Phase 13.6 (2026-05-23): cap PLAN_MD_INJECT_CAP to prevent 60K+ prefix.
            // Header sections (Goal/Sub-tasks/Operational Knowledge/Lessons) are within the first 18K;
            // tail sections Recent Runs / Archive Summary are truncated; LLM can readFile for the full text when needed.
            const md = memory.planFiles.getMarkdown(project);
            if (md) {
              const projectsBase = memory.planFiles.baseDir;
              const planPath = join(projectsBase, project, 'plan.md');
              const truncated = md.length > PLAN_MD_INJECT_CAP;
              const injectMd = truncated
                ? md.slice(0, PLAN_MD_INJECT_CAP) +
                  `\n\n[... plan.md remaining ${md.length - PLAN_MD_INJECT_CAP} chars truncated — readFile("${planPath}") for full content]\n`
                : md;
              lines.push(`## Project plan.md (${project}, auto-inject${truncated ? ', truncated' : ''})`);
              lines.push('');
              lines.push(injectMd);
              lines.push('');
              lines.push(
                `↑ This is the project's accumulated work notes. Lessons / Operational Knowledge persist across fires;` +
                  ` repeated failures mean you **did not read Lessons** — re-read before starting.` +
                  (truncated ? ` This section is truncated; for full Recent Runs use \`readFile("${planPath}")\`.` : ''),
              );
              lines.push('');
            }
          } else {
            // user-driven turn: link only, LLM readFile on demand
            const projectsBase = memory.planFiles.baseDir;
            const planPath = join(projectsBase, project, 'plan.md');
            lines.push(`## Active project plan`);
            lines.push(`project: \`${project}\``);
            lines.push(`plan.md: \`${planPath}\``);
            lines.push(
              `Lessons / Operational Knowledge / Recent Runs are all in the file.` +
                ` Use \`readFile\` when needed. Details are not repeated in the prefix to save tokens / preserve cache hit.`,
            );
            lines.push('');
          }
        }
        // Spec regime: ANY scheduled routine that names an installed service (by slug/host in its
        // schedule name, project, or payload) gets the COMPILED contract injected — endpoints,
        // auth placeholder, required body fields, verified calls — so it stops re-fetching the
        // guide every fire and stops improvising request shapes (prod: memories PUT went out as
        // {content:string} while the documented shape sat unread in the skill). Independent of
        // project binding: a schedule without one still matches via its payload text.
        if (isScheduled) {
          try {
            const svc = findServiceSkillForText(
              `${schedId ?? ''} ${project ?? ''} ${schedPayloadText}`,
              join(process.cwd(), '.philont', 'skills'),
            );
            if (svc) {
              const SKILL_INJECT_CAP = 6000;
              const body = svc.markdown.length > SKILL_INJECT_CAP
                ? svc.markdown.slice(0, SKILL_INJECT_CAP) + '\n[... truncated — readFile the SKILL.md for the rest]'
                : svc.markdown;
              lines.push(`## Service contract (compiled): ${svc.skillName} (auto-inject)`);
              lines.push('');
              lines.push(body);
              lines.push('');
              lines.push(
                '↑ Use these endpoints, auth placeholder, and body fields VERBATIM. Do NOT re-fetch the guide,' +
                  ' invent paths, or send bodies missing the documented fields.',
              );
              lines.push('');
              console.log(`[service-skill-inject] session=${sidForPlan} injected ${svc.skillName} (${body.length} chars)`);
            }
          } catch (e) {
            console.warn('[service-skill-inject] failed (ignored)', e);
          }
        }
      } catch (e) {
        console.warn(
          `[plan-files] inject failed (ignored):`,
          (e as Error)?.message ?? e,
        );
      }
    }
  }

  // ── Complex-task protocol entry point (v17 Phase 4, 2026-05-11) ──────────────────────────
  // Task mode self-assessment + active plan state. **This section must appear at the top of the prefix** — the LLM
  // only learns that the task_mode_classify / plan_* protocol exists after seeing this section. Otherwise the mechanism-layer
  // plan_protocol_gate is never activated (LLM does not call task_mode_classify('slow') → mode stays fast → gate not entered).
  //
  // Production (2026-05-11 mycox) showed: without this section, LLM sees guide.md and directly webFetches
  // without following the protocol; with this section, LLM proactively calls task_mode_classify.
  const sidForMode = currentSessionId();
  const currentMode = sidForMode ? taskModeStore.get(sidForMode) : 'fast';
  lines.push('## Task Mode Self-Assessment (v17 Complex Task Protocol)');
  if (currentMode === 'fast') {
    lines.push(`Current mode: **fast**`);
    lines.push('');
    lines.push('If this task matches any of the criteria below, **call `task_mode_classify({ mode: "slow", reason })` as the first step** before starting work.');
    lines.push('');
    lines.push('[4 self-check questions — any yes → slow]');
    lines.push('Q1 How many **independently verifiable outputs** does this task have? ≥ 2 → slow');
    lines.push('Q2 Are there **dependencies between steps** (B must wait for A\'s result)? Yes → slow');
    lines.push('Q3 Does the task involve **writes to the external world** (create account / send message / deploy / modify remote data)?');
    lines.push('   Yes → lean slow, unless the write is a single one-shot action with no subsequent verification');
    lines.push('Q4 Has the user provided a **guide document / URL / multi-step instructions** (## multi-section / 1./2./3. list)?');
    lines.push('   Yes → slow, must follow every item in the document');
    lines.push('');
    lines.push('Does not match → fast (single tool call / single-intent answer is sufficient).');
    lines.push('');
    lines.push('Once slow is activated, the mechanism layer enforces: plan_draft (with deliverables) → plan_update_step → plan_close (with deliverable_status). **Skipping the protocol = tool rejected by plan_protocol_gate**.');
  } else {
    // slow mode: show active plan state + next step guidance
    const sessionPlans = sidForMode
      ? memory.plans.listBySession(sidForMode, { limit: 1 })
      : [];
    const lastPlan = sessionPlans[0];
    lines.push(`Current mode: **slow**`);
    if (!lastPlan) {
      lines.push('**Plan not yet created** — call `plan_draft({ steps, task_signature, guide_ref })` immediately to break it down. The mechanism layer has blocked all other tools until the first `plan_update_step(status="doing")` (draft→executing transition is automatic).');
    } else if (lastPlan.status === 'draft') {
      // M4(2026-05-15) spec-coverage: distinguish placeholder plan vs real plan
      if (lastPlan.isPlaceholder) {
        lines.push(
          `Active plan: ${lastPlan.id} status **draft / placeholder plan (isPlaceholder=true)** ` +
            `(${lastPlan.steps.length} generic skeleton steps, 0 deliverables)`,
        );
        if (lastPlan.guideRef) {
          lines.push(`guide_ref: ${lastPlan.guideRef}`);
        }
        lines.push('');
        lines.push('The placeholder plan must be converted into a real plan that reflects the actual task structure. Steps in order:');
        lines.push('');
        lines.push('### 1. Read the full guide first');
        lines.push('');
        {
          const gref = lastPlan.guideRef ?? '';
          if (/^https?:\/\//i.test(gref)) {
            lines.push(`Call \`webFetch("${gref}")\`. The host automatically stores it in fetched-store; read the body returned by webFetch directly.`);
          } else if (gref.startsWith('skill:')) {
            lines.push(`Call \`use_skill("${gref.slice(6)}")\` to read the full content.`);
          } else if (gref) {
            lines.push('The guide content is a user message fragment (already in context). Proceed directly to step 2.');
          } else {
            lines.push('guide_ref is missing — confirm the task source with the user, or proceed to step 2 and break down deliverables based on the user message.');
          }
        }
        lines.push('');
        lines.push('Do NOT:');
        lines.push('- `readFile` to guess fetched-store paths (fetched-store is empty in new sessions; filenames are managed by the mechanism layer and cannot be guessed)');
        lines.push('- `plan_revise` from memory (without reading the guide you cannot know the deliverables — they will be incomplete)');
        lines.push('- Call `plan_update_step` / business tools directly (placeholder plan will reject; work done without reading the guide is unrelated to the task)');
        lines.push('- **Miss ongoing / credential deliverables** (see # 2 below) — missing them = subsequent 401 / heartbeat cannot start');
        lines.push('');
        lines.push('### 2. List deliverables');
        lines.push('');
        lines.push('Go through the guide section by section and ask:');
        lines.push('- What verifiable output does this section require?');
        lines.push('- How do we know it is done? (return value / file / fact / remote state)');
        lines.push('- Is the id kebab-case, ≥ 8 chars, and not a catch-all?');
        lines.push('');
        lines.push('**Two types of deliverables commonly missed — if you see any of the following keywords you MUST add one**:');
        lines.push('- Guide contains `Part N routine` / `check-in` / `periodic` / `ongoing` / `every N minutes` / `heartbeat`');
        lines.push('  → Must have a **schedule_reminder** deliverable (otherwise the user turn ending = task stops = ongoing commitment not fulfilled)');
        lines.push('- Guide contains `register` / `auth` returning `token` / `api_key` / `secret` / `credential`');
        lines.push('  → Must have a **saveCredential** deliverable (not stored in SecretStore → subsequent http `{SECRET_ID}` placeholder has no value → 401 Authentication required)');
        lines.push('');
        lines.push('### 3. plan_revise to convert to real plan');
        lines.push('');
        lines.push('`plan_revise({plan_id, new_steps, new_deliverables, reason})`');
        lines.push('- `new_deliverables` = complete set of truly deliverable items from the guide');
        lines.push('- `new_steps[i].covers` = deliverable ids covered by this step');
        lines.push('- `reason` = "guide reveals need to do X/Y/Z"');
        lines.push('');
        lines.push('### 4. plan_update_step("doing") — begin execution');
        lines.push('');
        lines.push('plan automatically transitions to executing.');
        lines.push('');
        lines.push('### Deliverable examples (external service integration + ongoing operation; prerequisite: guide fully read)');
        lines.push('');
        lines.push('- `register-account`: register an account on the external service and obtain account_id');
        lines.push('- `save-credentials`: register returns token/api_key — **immediately** `saveCredential` to SecretStore');
        lines.push('- `verify-auth`: call one read-only API to confirm the key is valid');
        lines.push('- `first-write-op`: perform one minimal write operation to verify the full chain');
        lines.push('- `setup-heartbeat`: register a periodic check-in via `schedule_reminder` (only if the guide mentions routine / periodic tasks)');
        lines.push('');
        lines.push('Name ids after your actual task — do not copy the example ids above.');
      } else {
        lines.push(
          `Active plan: ${lastPlan.id} status **draft** (${lastPlan.steps.length} steps, ${lastPlan.deliverables.length} deliverables)`,
        );
        lines.push('**Next step: call plan_update_step({step_id, status:"doing"})** to begin execution. plan.status will automatically transition to executing.');
      }
    } else if (lastPlan.status === 'executing') {
      const doneCount = lastPlan.steps.filter((s) => s.status === 'done').length;
      lines.push(
        `Active plan: ${lastPlan.id} status **${lastPlan.status}** (${doneCount}/${lastPlan.steps.length} done)`,
      );
      const next = lastPlan.steps.find(
        (s) => s.status === 'pending' || s.status === 'doing',
      );
      if (next) {
        lines.push(`Next step: [${next.id}] ${next.description} (${next.status})`);
      }
      lines.push('Use `plan_update_step` to advance / `plan_revise` to modify the plan / `plan_close` to finalize.');
    } else {
      // completed / failed
      lines.push(
        `Active plan: ${lastPlan.id} status **${lastPlan.status}** (finalized). If this is a new task, call task_mode_classify to re-assess.`,
      );
    }

    // Phase 15 (2026-05-18): slow task execution discipline. Analogous to Claude Code programming; fully generic,
    // contains no project-specific keywords. Historical LLM drift pattern: after 50s of slow task, LLM only reads guide → outputs
    // "let me first look at other communities" (commitment-style language) → turn ends. This section explicitly states the
    // "complete in one go" principle + autonomous problem-solving discipline + prohibition of commitment phrasing; half-finished detector handles genuine drift.
    lines.push('');
    lines.push('### Slow task execution discipline (analogous to Claude Code programming)');
    lines.push('');
    lines.push('**Complete in a single turn**:');
    lines.push('- A slow task = one complete "code execution". The plan is the code; tool calls are the runtime');
    lines.push('- All deliverables MUST be completed within this turn. Channels are fire-and-forget (user sends and leaves)');
    lines.push('- Analogy: Claude Code given "write a script" does not "research first and write later" — it goes: plan + write + run + debug');
    lines.push('');
    lines.push('**Solve problems autonomously** (do not wait for user prompts):');
    lines.push('- Tool failure = error → read the error, change approach, retry');
    lines.push('- Missing information → webSearch / read referenced docs / try endpoint variants');
    lines.push('- Auth failure → listCredentialNames to get credential names, try different headers (Authorization Bearer / X-API-Key / X-Auth-Token etc.)');
    lines.push('- Truly stuck (missing input only the user can provide) → askUserQuestion, **do not promise "later"**');
    lines.push('');
    lines.push('**Forbidden final text patterns** (mechanism layer half-finished detector triggers cap=1 regen):');
    lines.push('- ❌ "let me first X" / "I\'ll first Y then Z" / "I need to understand first"');
    lines.push('- ❌ "next I will" / "next I\'ll" / "let me look at"');
    lines.push('- ❌ "next time" / "later" / "soon" / "in a moment"');
    lines.push('');
    lines.push('**Allowed final text**:');
    lines.push('- ✅ "Completed X, N/M deliverables done" (specific progress + plan_close)');
    lines.push('- ✅ "Stuck: <reason> + already tried <method>" (plan_close(failure))');
    lines.push('- ✅ askUserQuestion (genuinely missing user input)');
  }
  lines.push('');

  // ── Recent cross-channel uploaded files ──────────────────────────────────────
  // Solves the reference ambiguity problem: "user uploads a PDF on WeChat + says 'the one I just uploaded' on web-ui":
  // K0 timeline is global, but the retriever does keyword recall; pronouns ("this"/"the recent one") have no semantic signal and frequently miss.
  // Always-on here: exposes the 3 most recent attachments within 1h at the top of the prefix so the LLM can see their paths at a glance.
  const fresh = recentAttachments({ limit: 3, ttlMs: 60 * 60_000 });
  if (fresh.length > 0) {
    lines.push('## Recently uploaded files (cross-channel)');
    const now = Date.now();
    for (const att of fresh) {
      const ageMin = Math.max(1, Math.round((now - att.ts) / 60_000));
      const channelLabel = att.channel.split(':')[0]; // wechat / webui …
      lines.push(`  · ${att.filename} @ ${att.path} (${channelLabel}, ${ageMin} min ago)`);
    }
    lines.push('When the user says "the file I just uploaded / this file", it most likely refers to one of the above. Do not glob the entire filesystem.');
    lines.push('');
  }

  // ── Phase 10 M2 (2026-05-15): cross-turn / cross-session fetched resources ─────────
  // Fixes heartbeat scheduled task bug: guide.md fetched by webFetch in the main session was stored in
  // FetchedResourceStore, but the scheduled task session could not see it → LLM guessed the API
  // endpoint → 404 wall-loop. Always-on: renders top 5 within 7 days in the prefix, cross-session.
  try {
    const FETCHED_TTL_MS = 7 * 24 * 60 * 60_000;
    const fetched = fetchedStore.listRecent({
      sinceTs: Date.now() - FETCHED_TTL_MS,
      limit: 5,
    });
    if (fetched.length > 0) {
      lines.push('## Resources I have previously fetched (cross-turn / cross-session, within 7 days)');
      const now = Date.now();
      for (const r of fetched) {
        const ageMin = Math.max(1, Math.round((now - r.fetchedAt) / 60_000));
        const ageLabel =
          ageMin < 60
            ? `${ageMin} min ago`
            : ageMin < 24 * 60
              ? `${Math.round(ageMin / 60)} hr ago`
              : `${Math.round(ageMin / 1440)} days ago`;
        const sizeLabel = r.isBinary
          ? `${Math.round(r.byteSize / 1024)}K binary`
          : `${r.charSize ?? r.byteSize}c`;
        const binTag = r.isBinary ? ' [binary]' : '';
        lines.push(
          `  · ${r.sourceRef}${binTag}\n` +
            `    → local: ${r.localPath} (${sizeLabel}, ${ageLabel}, via ${r.sourceTool})`,
        );
      }
      lines.push(
        '**readFile the local path before using** — do not re-fetch the same URL with webFetch.' +
          ' When you need guide / API doc content: if a relevant resource is listed here, readFile the full text (more reliable than guessing endpoints from memory).',
      );
      lines.push('');
    }
  } catch (e) {
    console.warn('[memory-prefix] fetched-store render failed, skipped:', e);
  }

  // 2026-05-23: project facts use top-N by recency cap; user facts are not capped.
  //
  // Design rationale:
  // - user.* are mostly "identity/config-type" facts (name / role / timezone / locale / preferences);
  //   written once and used permanently, rarely updated. Sorting by createdAt would push critical facts
  //   like timezone down as new "behavioral user.* facts" (e.g. user.recent_interest) are written — unacceptable.
  //   user count is usually small (< 30 entries); not capping is only ~10K total.
  // - project.* are frequently written as new research/context by the LLM / extractor; they need a cap.
  //   top-20 by createdAt prioritizes the most recently relevant context; the LLM can call listFacts for older entries.
  //
  // Fallback: user.* also has a "100-entry ceiling" to prevent pathological cases; not triggered under normal use.
  //
  // 2026-07-21 — recurring-series collapse. The two rules above interact badly with a recurring
  // scheduled task: each run stores one record ("checkin-2026-07-21-13-11", "…-13-17", "…-13-23"), and
  // because storeFact bumps lastAccessedAt, each new record lands at the head of the recency order. A
  // 6-minute heartbeat therefore owns all 20 slots within two hours, evicting every durable project
  // fact — and the section's growth (prod: 3356 → 10335 chars in 80 minutes, +600 per run, still
  // climbing) is what pushed the whole prefix over its cap turn after turn. The knowledge content of a
  // series is its latest member; the rest stay in the DB and remain reachable via listFacts.
  const PROJECT_FACTS_TOP_N = 10;
  const USER_FACTS_SAFETY_CAP = 100;
  const renderFactsSection = (
    ns: 'user' | 'project',
    headingLabel: string,
    topN: number,
  ) => {
    const all = memory.facts.listFacts(ns);
    if (all.length === 0) return;
    // 2026-05-23: sort key is lastAccessedAt desc (fallback to createdAt for old DBs with NULL).
    // "Accessed = explicitly read by getFact / written by storeFact", reflecting actual usage patterns. Better than
    // pure createdAt at preserving identity/config-type facts that are "written once but read often".
    const key = (f: Fact) => f.lastAccessedAt ?? f.createdAt;
    const ranked = [...all].sort((a, b) => key(b) - key(a));
    // 2026-07-21: collapse recurring series before taking top-N (see collapseFactSeries). A scheduled
    // task that writes one record per run owns a slot per run, and since every write also bumps
    // lastAccessedAt the series monopolises the whole top-N within a couple of hours.
    const { kept, collapsed } = collapseFactSeries(ranked);
    const candidates = kept.slice(0, topN);
    const top: typeof candidates = [];
    let sectionChars = 0;
    for (const f of candidates) {
      const rendered = `  ${ns}.${f.key} = ${truncateForInjection(
        JSON.stringify(f.value), FACT_VALUE_INJECT_CAP, `${ns}.${f.key}`,
      )}`;
      if (top.length > 0 && sectionChars + rendered.length > FACT_SECTION_INJECT_CAP) break;
      top.push(f);
      sectionChars += rendered.length;
    }
    lines.push(`## ${headingLabel}`);
    for (const f of top) {
      const valueStr = truncateForInjection(
        JSON.stringify(f.value),
        FACT_VALUE_INJECT_CAP,
        `${ns}.${f.key}`,
      );
      lines.push(`  ${ns}.${f.key} = ${valueStr}`);
    }
    const withheld = all.length - top.length;
    if (withheld > 0) {
      lines.push(
        `  ... (${withheld} more fact(s) not injected` +
          (collapsed > 0 ? `, incl. ${collapsed} older entr(ies) of recurring series shown above` : '') +
          ` — use \`listFacts({namespace:"${ns}"})\` to retrieve all when needed)`,
      );
    }
    lines.push('');
  };
  renderFactsSection('user', 'Known user information', USER_FACTS_SAFETY_CAP);
  renderFactsSection('project', 'Known project information', PROJECT_FACTS_TOP_N);

  // Skill index: only injects name + one-line description; minimal token cost.
  // The LLM calls use_skill(name) itself to get details when needed.
  // positive and negative are injected separately: positive via index (use_skill to pull details);
  // negative are hard constraints ("do not do this again") that the LLM must see every time,
  // so the key section of action_template is injected directly (rather than just listing the name).
  // ── Extended capabilities section (above the regular skill index; visual priority) ──
  //
  // Separate clawhub / github-skills from the regular index, rendering them as an independent "meta-skill" section.
  // This fix is based on observed production behavior:
  //   1) clawhub's triggerKeywords are generic descriptions ("user asks about something unfamiliar");
  //      FTS5 keyword search in search_skills cannot find it for any specific domain query → LLM thinks clawhub
  //      is "irrelevant" and ignores it.
  //   2) Even when it appears in the regular index, buried among 20 lines the LLM tends to "skim past it and use search_skills
  //      to find the next skill", never forming the reflex of "use use_skill to go outside".
  //   3) When the user explicitly says "try using clawhub", the agent still calls search_skills — showing the LLM
  //      does not distinguish "clawhub-the-meta-skill" vs "a search_skills index entry"; an explicit
  //      mental model clarification is needed.
  //
  // Design: always-render (not affected by top-20 ranking), standalone H2 section, explicitly stating:
  //   - entry action (use_skill not search_skills)
  //   - 5 specific trigger conditions (covering the LLM's common "I don't know how" branches)
  //   - mental model ("clawhub is a meta-skill for finding new skills, not a regular domain skill")
  const clawhubSkill = memory.skills.getByName('clawhub');
  const githubSkill = memory.skills.getByName('github-skills');
  if (clawhubSkill || githubSkill) {
    lines.push('## Extended capabilities — use these when local skills are insufficient');
    lines.push('');
    lines.push('Entry points (call directly, do NOT search_skills first):');
    if (clawhubSkill) {
      lines.push(`  - \`use_skill('clawhub')\` → install a new skill from the ClawHub public skill library`);
    }
    if (githubSkill) {
      lines.push(`  - \`use_skill('github-skills')\` → install SKILL.md from a GitHub repository`);
    }
    lines.push('');
    lines.push('When to use (any match triggers, **no user prompt needed**):');
    lines.push('  - search_skills returns empty, or results are unsuitable / failed when tried');
    lines.push('  - User asks about an unfamiliar domain not covered by the local skill library');
    lines.push('  - A tool call fails and a different approach is needed (network blocked / no permission / unsupported)');
    lines.push('  - You are about to say "I can\'t / can\'t find / unfamiliar with / temporarily unable / no ready-made X"');
    lines.push('  - User hints "is there another way / look at others / try X"');
    lines.push('');
    lines.push('Mental model: these two are meta-skills for "learning new capabilities externally". **Invoke with use_skill**');
    lines.push('(not ordinary skills in the search_skills index). Takes effect immediately after loading, no user consent required.');
    lines.push('This is the standard way to extend your capabilities — not overstepping, not a burden.');
    lines.push('');
  }

  // Regular skill index: exclude meta-skills already shown in the "extended capabilities" section to avoid duplication
  const META_SKILL_NAMES = new Set(['clawhub', 'github-skills']);
  const SKILL_INDEX_MAX_LINES = 15;
  // P1: relevance-recall flag. When OFF (default), the four skill selections below stay byte-identical
  // to the historical global-top-N behavior. When ON (and a non-empty recall query is available), each
  // section is selected by jaccard relevance to the current task at SMALLER caps to fight context bloat.
  const relevanceOn = recallRelevanceEnabled() && recallQuery.trim().length > 0;
  // Positive skill index: caps 15 (OFF) → 6 (ON).
  const POSITIVE_CAP = relevanceOn ? 6 : SKILL_INDEX_MAX_LINES;
  const positiveFallback = () =>
    memory.skills
      .listAll(40)
      .filter((s) =>
        s.kind !== 'negative'
        && !META_SKILL_NAMES.has(s.name)
        // 2026-05-11: playbooks go in their own dedicated section "## Lessons I've Learned Before", not mixed into the skill index.
        // Otherwise playbooks would be sorted by useCount too; always 0 → ranked last, never making top-15, effectively invisible.
        && s.maturity !== 'playbook'
      );
  const rankedSel = relevanceOn
    ? selectRelevantSkillsDetailed(memory.skills, recallQuery, {
        pool: 'positive',
        k: POSITIVE_CAP,
        // META filter baked into fallback; selector result is already pool-filtered (positive predicate).
        fallback: positiveFallback,
      })
    : null;
  const ranked = rankedSel
    ? rankedSel.skills.filter((s) => !META_SKILL_NAMES.has(s.name))
    : positiveFallback().slice(0, SKILL_INDEX_MAX_LINES);
  // ONE slot of the index is reserved for a draft nobody has been shown yet.
  //
  // Without it the ladder cannot turn at all. Production offered the SAME six mature skills on every turn,
  // across completely unrelated queries, for as long as the funnel has been logged: ranking is by
  // use_count × success-rate × recency, which a never-used draft is at the bottom of by construction, and
  // relevance cannot break the tie because a Chinese query tokenizes to nothing to match on. So
  // offered_count stayed 0 forever, "never shown" and "shown and declined" stayed indistinguishable, and
  // the creation-side bound added on 2026-07-23 turned that standstill into a permanent freeze — the
  // reflector stops minting until untested drafts drain, and they could not drain.
  //
  // Exactly one slot, and it comes out of the cap rather than adding to it: context budget is a hard
  // constraint, and the point is to let the pool ROTATE, not to promote drafts over things that work.
  const explore = memory.skills
    .untestedDraftsForExploration(1)
    .filter((s) => !META_SKILL_NAMES.has(s.name) && !ranked.some((r) => r.name === s.name));
  // The aux selector's picks come FIRST when it had an opinion — it is the only layer in this stack that
  // can tell a Chinese task from an English skill name. The exploration slot survives beside it: a
  // selector that only ever picks what it recognises would freeze the ladder exactly as the lexical
  // ranker did. See skill_relevance_llm.
  const auxPicks = signalBus?.skillRelevanceNames ?? [];
  const auxSkills = auxPicks
    .map((n) => memory.skills.getByName(n))
    .filter((s): s is NonNullable<typeof s> => !!s && !META_SKILL_NAMES.has(s.name));
  const rankedWithAux =
    auxSkills.length > 0
      ? [...auxSkills, ...ranked.filter((r) => !auxSkills.some((a) => a.name === r.name))]
      : ranked;
  const positives = explore.length > 0
    ? [...rankedWithAux.slice(0, Math.max(0, POSITIVE_CAP - 1)), ...explore]
    : rankedWithAux;
  if (positives.length > 0) {
    // SKILL FUNNEL VISIBILITY (2026-07-14). Measured over 7 days / 462 turns: 64 skills, use_skill called
    // 10 times, validated=0, draft pinned at exactly the prune cap (40). The maturity ladder's ONLY rung is
    // recordSkillOutcome, which fires only for actions tagged linkedSkill, which is set only after a
    // use_skill call. So a skill that is never CHOSEN can never be credited, never promoted, and is
    // eventually pruned for the low score of a race it never ran. Nobody could see which half of that was
    // failing, because the offer (this index) was never logged — only the (rare) acceptance was.
    // Log what we OFFER, so the next production log can answer "does it not see them, or not want them?"
    // Persist the offer for distribution diagnostics only. Offered/matched counts must never be treated
    // as efficacy evidence; only linked execution outcomes can promote or prune a skill.
    const matchedNames = new Set<string>(auxSkills.map((s) => s.name));
    if (rankedSel && rankedSel.matchedByRelevance > 0) {
      for (const s of ranked.slice(0, rankedSel.matchedByRelevance)) matchedNames.add(s.name);
    }
    memory.skills.recordSkillsOffered(positives.map((s) => s.name), [...matchedNames]);
    // Say what relevance DID, not merely that it is enabled: "on" while contributing zero matches is how
    // an identical six-skill list went unquestioned for a week. See selectRelevantSkillsDetailed.
    const relevanceNote = auxSkills.length > 0
      ? `aux(picked ${auxSkills.length})`
      : !relevanceOn
        ? 'off'
        : rankedSel && rankedSel.matchedByRelevance > 0
          ? `on(matched ${rankedSel.matchedByRelevance})`
          : 'on(matched 0 → global fallback)';
    console.log(
      `[skill-funnel] offered ${positives.length} skill(s) ` +
        `(pool=${memory.skills.count()}, relevance=${relevanceNote}): ` +
        positives.map((s) => `${s.name}(${s.maturity})`).join(', '),
    );
    // The wording lives in agent-memory/src/skill_offer.ts, where the reason for every clause is written
    // down. Short version: 7 days / 689 turns / 94 skills / use_skill called ZERO times. Every other rung
    // of the funnel works; the one made purely of prompt text did not. The old block advertised the
    // MECHANISM ("use_skill(name) to get details" — a lookup that costs a round-trip and returns details),
    // hid the evidence the store already had (a 6/6 recipe rendered identically to last night's guess),
    // and gave the exploration slot no reason to ever be picked.
    for (const line of renderSkillOffer(positives)) lines.push(line);
  }

  // 2026-05-11 (v17 complex-task protocol Phase 5.5): dedicated "❌ My previous failure patterns" section.
  // Renders playbooks distilled from plan_close('failure') (source LIKE 'plan-failure:%'),
  // complementing the "📚 Lessons I've Learned Before" section below — the former is a strong signal of "fell into the same trap last time on this task";
  // the latter is "reflection summary" ordinary lessons. Failure-pattern section comes first (higher priority) with fewer entries (top-3).
  //
  // Makes the LLM see "how the same type of task failed last time" at turn start, reducing the probability of repeating mistakes.
  // Implementation: filter the maturity='playbook' pool for source LIKE 'plan-failure:%', take top 3 by created_at DESC.
  const FAILURE_MODE_TOP_N = 3;
  // P1: when relevance is ON, pull ONE relevance-ranked playbook superset (k=6) and partition it into the
  // two playbook sections below (failure-patterns cap 3, lessons cap 3) — preserving the existing name-dedup
  // so a failure-playbook never also appears as a lesson. When OFF, both sections use the original
  // listByMaturity global ordering verbatim.
  const pbSel = relevanceOn
    ? selectRelevantSkills(memory.skills, recallQuery, {
        pool: 'playbook',
        k: 6,
        fallback: () => memory.skills.listByMaturity('playbook', 30),
      })
    : null;
  const failurePlaybooks = relevanceOn
    ? pbSel!
        .filter((p) => p.source?.startsWith('plan-failure:'))
        .slice(0, FAILURE_MODE_TOP_N)
    : memory.skills
        .listByMaturity('playbook', 30)
        .filter((p) => p.source?.startsWith('plan-failure:'))
        .slice(0, FAILURE_MODE_TOP_N);
  if (failurePlaybooks.length > 0) {
    lines.push('');
    lines.push('## ❌ My past failure patterns');
    lines.push('(Failure patterns distilled from past plan_close(failure) turns. If the current task matches a task_signature below, **read this section first** to avoid repeating the same mistakes.)');
    for (const fb of failurePlaybooks) {
      const sigMatch = fb.name.match(/^playbook-(.+?)-fail-[a-z0-9]+$/);
      const sigPrefix = sigMatch ? ` [${sigMatch[1]}]` : '';
      lines.push(`· ${fb.name}${sigPrefix}`);
      const body = fb.description.trim();
      const indented = body
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(indented);
    }
    lines.push('');
  }

  // 2026-05-11: Playbook rendered as a standalone section. A playbook is a "experience note" from reflection distillation, hint-only
  // (isCallableMaturity returns false; the LLM cannot call it via use_skill). Previously mixed into the skill index
  // sorted by useCount; playbook useCount is always 0, forever ranked last, never making top-15 — **effectively invisible**.
  // Now rendered as an independent section, complementing the routing section: routing teaches "what should be used";
  // playbook teaches "what should be avoided / watched out for".
  //
  // Exclude plan-failure playbooks already rendered in the "## ❌ My previous failure patterns" section above (avoid duplicate exposure).
  const PLAYBOOK_TOP_N = 5;
  // P1: lessons cap 5 (OFF) → 3 (ON). When ON, partition the shared relevance-ranked playbook superset.
  const LESSON_CAP = relevanceOn ? 3 : PLAYBOOK_TOP_N;
  const failureNames = new Set(failurePlaybooks.map((p) => p.name));
  const playbooks = relevanceOn
    ? pbSel!.filter((p) => !failureNames.has(p.name)).slice(0, LESSON_CAP)
    : memory.skills
        .listByMaturity('playbook', PLAYBOOK_TOP_N + failurePlaybooks.length)
        .filter((p) => !failureNames.has(p.name))
        .slice(0, PLAYBOOK_TOP_N);
  if (playbooks.length > 0) {
    memory.metrics.increment('playbook.inject.turns'); // instrumentation: lesson actually reached the prompt
    lines.push('');
    lines.push('## Lessons I have learned');
    lines.push('(These are lessons distilled from past reflections, not callable skills. When you see a matching "when" situation, remember to follow the "next time" action.)');
    for (const pb of playbooks) {
      // description has already been assembled as "lesson\napplicable: ...\nnext time: ..." in the applyReflection phase.
      // Directly indent-inject here.
      const body = pb.description.trim();
      // Extract task_signature as prefix (playbook name looks like 'playbook-<sig>-<hash>';
      // extract sig for the LLM to see).
      const sigMatch = pb.name.match(/^playbook-(.+?)-[a-z0-9]+$/);
      const sigPrefix = sigMatch ? ` [${sigMatch[1]}]` : '';
      lines.push(`· ${pb.name}${sigPrefix}`);
      const indented = body
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      lines.push(indented);
    }
    lines.push('');
  }

  // P1: negatives cap 20 (OFF) → 5 (ON, relevance-selected). Floor stays min(5,corpus) naturally.
  const negatives = relevanceOn
    ? selectRelevantSkills(memory.skills, recallQuery, {
        pool: 'negative',
        k: 5,
        fallback: () => memory.skills.listNegative(5),
      })
    : memory.skills.listNegative(20);
  if (negatives.length > 0) {
    memory.metrics.increment('antipattern.inject.turns'); // instrumentation
    lines.push('⚠️ The user has previously corrected these behaviors — avoid repeating them in the following situations:');
    for (const s of negatives) {
      lines.push(`  - ${s.name}: ${s.description}`);
      // negative templates are short (three-section format); injecting them in full is cost-manageable
      const tpl = s.actionTemplate.trim();
      if (tpl) {
        const indented = tpl
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n');
        lines.push(indented);
      }
    }
  }

  // K0: no longer specially injecting "state from the last conversation" — the LLM sees a continuous global timeline;
  // the retriever brings back relevant old fragments (including historical session-summary notes) on demand;
  // no need to hard-code the most recent summary into the prefix.

  // K7.3: interrupt-driven intrinsic-drive injection path.
  // Flow:
  //   1) Recompute all signals (commitment_pressure / service_dormancy)
  //   2) Drain accumulated fires from the drainer (triggered during idle period)
  //   3) mapper.tick(broadcast=false) to get the just-fired signals for this turn
  //   4) Render into the system section by severity bucket (not the user-role slot)
  //
  // Invariant: `messages[]` always contains only real user + real assistant + real tool messages. drive / interrupt
  // are 100% in the systemPrompt+memoryPrefix section. This fixes the class of bugs where drive mis-fires are treated by the LLM as
  // "user's words" causing a doubling-down response.
  try {
    // (1) Refresh signal state (commitment_pressure is refreshed uniformly outside mapper)
    const active = memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID);
    signalState.recomputeCommitmentPressure(active, Date.now());

    // (2) Drain idle-period accumulated fires
    const drained = interruptDrainer.drain();

    // 2026-05-06 D.2: report drain count to reflection trigger (critical+high+normal
    // > 0 means interruptDrained for this turn). low does not count — that is a harmless intrinsic-drive observation.
    if (signalBus) {
      signalBus.interruptDrainedCount =
        drained.critical.length + drained.high.length + drained.normal.length;
    }

    // (3) tick mapper without broadcasting (to avoid drainer re-sending next turn)
    const snapshot = collectSignalSnapshot();
    const justFired = interruptMapper.tick(snapshot, { broadcast: false });

    // (4) Render by severity. Both sources restore rich payload by "signal kind".
    type AnySig = { kind: string; payload: string; severity: string };
    const drainAsAny = (arr: typeof drained.critical): AnySig[] =>
      arr.map((s) => ({ kind: s.kind, payload: s.payload, severity: s.severity }));
    const justAsAny: AnySig[] = justFired.map((f) => ({
      kind: signalKindForFire(f.signal, f.level),
      payload: `${f.signal}=${f.value.toFixed(2)} → ${f.level}`,
      severity: levelToSeverityStr(f.level),
    }));

    const all = {
      critical: [...drainAsAny(drained.critical), ...justAsAny.filter((s) => s.severity === 'critical')],
      high:     [...drainAsAny(drained.high),     ...justAsAny.filter((s) => s.severity === 'high')],
      normal:   [...drainAsAny(drained.normal),   ...justAsAny.filter((s) => s.severity === 'normal')],
      low:      [...drainAsAny(drained.low),      ...justAsAny.filter((s) => s.severity === 'low')],
    };

    // CRITICAL → pinned at top
    if (all.critical.length > 0) {
      const sigBreakdown = signalState.getCommitmentBreakdown();
      const dorm = computeServiceDormancy({ lastAssistantTs: lastAssistantTs(), now: Date.now() });
      lines.unshift(''); // visual spacer
      for (const s of all.critical) {
        if (s.payload.startsWith('service_dormancy')) {
          lines.unshift(`## ⚠️ I have not served you for ${dorm.hoursSinceLastServe.toFixed(1)} hours`);
          if (sigBreakdown && sigBreakdown.contributors.length > 0) {
            lines.push('Open items (by urgency):');
            for (const c of sigBreakdown.contributors.slice(0, 3)) {
              const ageStr = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
              lines.push(`  - ${c.title} (pending ${ageStr})`);
            }
          }
          lines.push('What might you need? Or should we handle these first?');
        } else {
          lines.unshift(`## ⚠️ Must handle immediately: ${s.kind}(${s.payload})`);
        }
      }
    }

    // HIGH → middle section "## Needs Attention"
    if (all.high.length > 0) {
      lines.push('## Needs attention');
      for (const s of all.high) {
        if (s.payload.startsWith('commitment_pressure')) {
          const sb = signalState.getCommitmentBreakdown();
          lines.push(`  · My outstanding commitments (urgency ${sb?.pressure.toFixed(2) ?? '?'}):`);
          if (sb) {
            for (const c of sb.contributors.slice(0, 3)) {
              const ageStr = c.ageHours < 24 ? `${Math.round(c.ageHours)}h` : `${Math.round(c.ageHours / 24)}d`;
              lines.push(`    - ${c.title} (pending ${ageStr}, stake ${c.stakeWeight}/10)`);
            }
          }
        } else if (s.payload.startsWith('service_dormancy')) {
          const dorm = computeServiceDormancy({ lastAssistantTs: lastAssistantTs(), now: Date.now() });
          lines.push(`  · I have not truly served you for ${dorm.hoursSinceLastServe.toFixed(1)} hours`);
        } else {
          lines.push(`  · ${s.kind}: ${s.payload}`);
        }
      }
    }

    // NORMAL → bottom "## Intrinsic-drive observation"
    if (all.normal.length > 0) {
      lines.push('## Intrinsic-drive observation');
      for (const s of all.normal) {
        if (s.payload.startsWith('commitment_pressure')) {
          const sb = signalState.getCommitmentBreakdown();
          lines.push(`  · ${sb?.activeCount ?? 0} open items, urgency ${sb?.pressure.toFixed(2) ?? '?'}`);
        } else {
          lines.push(`  · ${s.kind}: ${s.payload}`);
        }
      }
    }

    // LOW → audit only, not rendered
    if (all.low.length > 0) {
      internalAudit.append('self_domain_write', {
        source: 'interrupt_drainer',
        origin: 'Internal',
        toolName: 'interrupt_drained_low',
        count: all.low.length,
      });
    }

    // Also write an audit record for each fired signal
    if (justFired.length > 0) {
      for (const f of justFired) {
        internalAudit.append('self_domain_write', {
          source: 'interrupt_mapper',
          origin: 'Internal',
          toolName: 'signal_threshold_crossed',
          signal: f.signal,
          severity: f.level,
          prevSeverity: f.prevLevel,
          value: f.value,
          firedAtMs: f.firedAtMs,
          source_path: 'render',
        });
      }
    }
  } catch (e) {
    console.error('[interrupt] prefix render path error', e);
  }

  // K3: self-awareness (self.* facts by SelfReflector) — lets the agent read "what I have become".
  // This is not a role assignment; it is a mirror of emergent identity. The agent can read but not write.
  const selfFact = memory.facts.getFact('self', 'summary');
  if (selfFact) {
    const val = selfFact.value as { content?: string | string[] };
    if (typeof val.content === 'string' && val.content.trim()) {
      lines.push('## Who I am now (self-knowledge from past experience)');
      lines.push(val.content);
      const strengthsFact = memory.facts.getFact('self', 'strengths');
      if (strengthsFact) {
        const s = strengthsFact.value as { content?: string | string[] };
        if (Array.isArray(s.content) && s.content.length > 0) {
          lines.push('My strengths: ' + s.content.join(', '));
        }
      }
      const edgesFact = memory.facts.getFact('self', 'growth_edges');
      if (edgesFact) {
        const e = edgesFact.value as { content?: string | string[] };
        if (Array.isArray(e.content) && e.content.length > 0) {
          lines.push('Still learning: ' + e.content.join(', '));
        }
      }
    }
  }

  // WS4 (selfhood_closure): behavioral tendencies aggregated from the ledger (obs.* self facts).
  // Unlike the K3 self-description above (LLM-phrased identity), these are pure counters with
  // evidence refs — the agent reads how it ACTUALLY behaves and corrects course mid-turn.
  if (selfObservationsEnabled()) {
    try {
      const observations = listSelfObservations(memory.facts, 5);
      if (observations.length > 0) {
        lines.push('## What I know about my own tendencies (evidence-backed, auto-aggregated)');
        for (const o of observations) lines.push(`- ${o.content}`);
      }
    } catch (e) {
      console.error('[prefix] self-observations render failed', e);
    }
  }

  // WS3 (selfhood_closure): surface at most ONE pending constitution proposal per 24h. The agent
  // relays it to the owner in its reply; only an explicit owner approval/rejection may be followed
  // by decide_constitution_proposal. Never decide on the owner's behalf.
  if (constitutionProposalsEnabled()) {
    try {
      const proposal = constitutionProposals.nextToSurface(BOOTSTRAP_ROOT_PURSUIT_ID);
      if (proposal) {
        constitutionProposals.markSurfaced(proposal.id);
        lines.push('## Constitution amendment proposal (awaiting the OWNER\'s decision)');
        lines.push(renderProposalCard(proposal));
        lines.push(
          'Relay this proposal to the owner in your reply (their language), with the id. ' +
            `If — and only if — the owner explicitly approves or rejects it, call ` +
            `decide_constitution_proposal(id="${proposal.id}", decision="approve"|"reject"). ` +
            'If they ignore it, drop the subject; it must not be re-raised this turn.',
        );
      }
    } catch (e) {
      console.error('[prefix] constitution proposal render failed', e);
    }
  }

  // K8 proactivity layer: display outputs produced by the autonomous loop since the last user message.
  // Two parallel sections:
  //   1. K7→K8 bridge review section — agent self-correction records (higher signal, placed first)
  //   2. General autonomous research section — proactive output from Gap/Curiosity etc. (placed second)
  // Either section contributes zero characters when empty; entire block omitted when both are empty.
  try {
    const lastUserMsg = memory.raw.getLastMessageByRole('user');
    const sinceTs = lastUserMsg ? lastUserMsg.timestamp - 60_000 : 0;

    const reviewSection = buildK7BridgeReviewSection(autonomousLoop.initiatives, {
      sinceTs,
      topK: 3,
      maxChars: 800,
    });
    if (reviewSection) {
      lines.push('');
      lines.push(reviewSection);
    }

    const progressSection = buildAutonomousProgressInjection(autonomousLoop.initiatives, {
      sinceTs,
      topK: 3,
      maxChars: 800,
    });
    if (progressSection) {
      lines.push('');
      lines.push(progressSection);
    }

    // Proactive research "request permission": background executor requested a gated tool → render "## Pending Background Research Approvals",
    // guiding the user to call grant_research_tool to approve. Data source = pursuit.openQuestions[].pendingTool.
    const researchRoot = memory.pursuits.getDefaultRoot();
    if (researchRoot) {
      const grantSection = buildResearchPendingGrantSection(memory.pursuits, researchRoot.id, {
        topK: 5,
        maxChars: 1000,
      });
      if (grantSection) {
        lines.push('');
        lines.push(grantSection);
      }
    }

    // Deep reasoning subsystem: informs the next turn that an active reasoning session exists and can be continued.
    // When env flag is off, the reasoning table is empty → listActiveSessions is empty → returns empty string, zero cost.
    const reasoningSection = buildReasoningProgressSection(memory.reasoning, { maxChars: 800, ownerSessionId: currentSessionId() });
    if (reasoningSection) {
      lines.push('');
      lines.push(reasoningSection);
    }
  } catch (e) {
    console.warn('[autonomous] progress inject failed, skipped', e);
  }

  // 2026-05-07 path 7: user behavior observation candidate — render "Patterns I've Observed" section;
  // the LLM responds with "learn/decline" when it sees it on the next user turn.
  try {
    const pending = listPendingPatterns(memory.facts);
    if (pending.length > 0) {
      const observation = buildUserPatternObservationSection(pending, { maxPatterns: 2 });
      if (observation.matched) {
        lines.push('');
        lines.push(observation.text);
      }
    }
  } catch (e) {
    console.warn('[user-pattern] inject failed, skipped', e);
  }

  // S1 anchor: computed once, appended AFTER the cap logic (never truncated) and OUTSIDE the memory-layer
  // block. Empty string ⇒ byte-identical to before (flag off / no active session).
  const ledger = buildExecutionLedger();
  const ledgerTail = ledger.length ? '\n' + ledger.join('\n') : '';

  if (lines.length === 0) return ledgerTail;

  const raw =
    '\n\n[Memory layer — the following is already known; no need to ask or query again]\n' +
    lines.join('\n') +
    '\n[End of memory layer]';

  // When over the limit (or when PHILONT_PREFIX_TRACE=1 is explicitly set), split by `## heading` and output the char count
  // of each section to assist diagnosing "which section is bloating". Trace is not re-emitted — only runs on warn / explicit trace.
  const shouldTrace =
    raw.length > MEMORY_PREFIX_TOTAL_CAP || process.env.PHILONT_PREFIX_TRACE === '1';
  if (shouldTrace) {
    try {
      const segments = splitPrefixBySection(raw);
      const summary = segments
        .slice(0, 10) // top 10 segments is enough to identify the culprit
        .map((s) => `${s.title}=${s.chars}`)
        .join(', ');
      console.warn(`[memory-prefix] segments total=${raw.length} chars: ${summary}`);
    } catch (e) {
      console.warn('[memory-prefix] segment trace failed, ignored', (e as Error)?.message ?? e);
    }
  }

  // Total limit gate — even when each section was truncated, the sum can still exceed the limit.
  // Exceeding the total limit necessarily indicates a bug (too many facts? a section truncation not effective?); this is the last line of defense.
  if (raw.length > MEMORY_PREFIX_TOTAL_CAP) {
    const { text, trimmed } = trimPrefixToCap(raw, MEMORY_PREFIX_TOTAL_CAP, { query: recallQuery });
    console.warn(
      `[memory-prefix] over cap ${raw.length} → ${text.length} chars, trimmed: ` +
        (trimmed.length > 0
          ? trimmed.map((t) => `${t.title}(-${t.cut})`).join(', ')
          : 'blunt tail cut (no trimmable sections)'),
    );
    return text + ledgerTail;
  }
  console.log(`[memory-prefix] size=${raw.length} chars`);
  return raw + ledgerTail;
}

/**
 * In-flight compaction check: when the **current turn's working context** (messages array) grows beyond the threshold,
 * summarize the middle section while preserving the head and tail.
 *
 * After K0, messages are per-turn fresh; this compaction mainly protects a single turn's tool loop
 * from being blown up by oversized tool_results. Long-term compaction of the raw global timeline is delegated to
 * an offline path outside idle_consolidator (K0.5+ future work: compactTimelineRange + TimelineRetriever detecting
 * "this period is covered by a summary stand-in" and replacing with the summary). Currently raw only stores text
 * not tool_use/tool_result blocks, and TimelineRetriever has its own token budget,
 * so the LLM window will not blow up from long-tail messages in the near term.
 *
 * Note: mutates the original array (length + splice) for compatibility with existing callers.
 */
/**
 * Context compaction scheduling. Two modes:
 *   - 'soft' (default, used at turn-entry "quiet period"): compacts when thresholdTokens is reached.
 *     The user message has just arrived and the LLM has not started; plan/tool chain is not mid-execution;
 *     summarizing the middle section at this point does not corrupt precise IDs.
 *   - 'hard' (used inside the turn tool loop): only compacts when hardThresholdTokens is reached,
 *     as a safety net to prevent the LLM context window from truly overflowing. Below this threshold
 *     **no compaction** within the turn — protects plan_id / tool_result chain in the tail protectLastN
 *     entries from being compressed, avoiding corruption of precise protocol IDs.
 *
 * evictOldToolResults runs in both modes (idempotent; only replaces early tool_result with placeholders,
 * keeps the most recent K entries intact, does not touch the tool_use block containing plan_id).
 */
async function maybeCompact(
  messages: NativeMessage[],
  sessionId: string,
  mode: 'soft' | 'hard' = 'soft',
): Promise<void> {
  const shouldCompact =
    mode === 'hard'
      ? compactor.needsHardCompaction(messages as unknown as { role: string; content: unknown }[])
      : compactor.needsCompaction(messages as unknown as { role: string; content: unknown }[]);

  // Incompressible-context latch (prod 2026-07-13). Compaction only summarizes the MIDDLE — the tail
  // (protectLastN: 10) is verbatim by design, to protect plan_id / tool_result chains. In a turn whose
  // tail holds huge tool_results (a 38KB readFile of an HTML file, a 44KB writeFile of a script), the
  // middle is already summarized and there is nothing left to squeeze: observed
  // `314831 → 314242` — a 0.2% gain. But the context is still over the hard cap, so the very next
  // tool-loop iteration calls compact() again... ~12 LLM summarize calls in 10 minutes, all no-ops,
  // context stuck at 314k. Once a compaction fails to make MEANINGFUL progress, stop paying for it
  // this turn; eviction below still runs (it is cheap and idempotent).
  if (shouldCompact && !incompressibleTurns.has(sessionId)) {
    const result = await compactor.compact(
      messages as unknown as { role: string; content: unknown }[],
      sessionId,
    );
    if (result.didCompact) {
      console.log(
        `[memory] compress session=${safeSessionId(sessionId)} mode=${mode}: ${result.tokensBefore} → ${result.tokensAfter} tokens (note=${result.summaryNoteId})`,
      );
      messages.length = 0;
      messages.push(...(result.compactedMessages as unknown as NativeMessage[]));
      const gained = result.tokensBefore - result.tokensAfter;
      if (gained < result.tokensBefore * COMPACT_MIN_GAIN_RATIO) {
        incompressibleTurns.add(sessionId);
        console.warn(
          `[memory] compress session=${safeSessionId(sessionId)} freed only ${gained} tokens ` +
            `(<${Math.round(COMPACT_MIN_GAIN_RATIO * 100)}%) — the tail is incompressible (oversized tool_results). ` +
            `Suppressing further compaction this turn; relying on tool_result eviction.`,
        );
      }
    }
  }

  // Capacity eviction: replace old tool_result content with placeholders, keeping the most recent K
  // intact. Idempotent; multiple calls are no-op. Runs in both modes.
  //
  // 2026-07-13: the budget used to be the 700K default while the compactor's hard cap is 250K, so between
  // 250K and 700K we would compact on every tool-loop iteration while the ONLY mechanism that can actually
  // shrink an oversized tail never ran. Prod sat at 314K–470K — squarely in that dead zone. Once we have
  // decided the context is too big (the hard cap), eviction must be allowed to act at the same point.
  const eviction = evictOldToolResults(messages, { budgetTokens: COMPACT_HARD_THRESHOLD_TOKENS });
  if (eviction.didEvict) {
    console.log(
      `[memory] evict old tool_result session=${safeSessionId(sessionId)}: ${eviction.tokensBefore} → ${eviction.tokensAfter} tokens (${eviction.evictedCount} items)`,
    );
  }
}

/**
 * Hard timeout (milliseconds) for a single LLM call. The Anthropic SDK usually throws on network errors,
 * but occasionally socket hangs or stream stops advancing — await would never return,
 * the turn loop silently hangs, and the frontend spins forever. This provides a fallback timeout for each call;
 * when exceeded, LlmTimeoutError is thrown so the outer layer takes the error path and emits final to the client.
 */
// 2026-05-07: 60s → 90s. Anthropic stream occasionally waits 30-90s before first token;
// 60s was too sensitive, causing false-positive timeouts when upstream genuinely needs a slow response → retry also waits 60s,
// total 120s = 40% of the 5-min hard deadline. 90s allows most slow responses to complete without retry.
//
// 2026-05-27 round 1: 90s → 180s, adjustable by env (after Phase 18 lazy gate LLM probes more data)
// 2026-05-27 round 2: 180s → 300s (Medical production saw 180s × 2 retries not enough)
// 2026-05-27 round 3: **changed to adaptive**. Medical still frequently hits 300s; root cause = LLM single-call output is large
//   (writing a 6KB Python script ~2300 tokens + reasoning + summary ~1000 tokens = 3000+
//    token output); a slow provider at 10 t/s needs 300s+ per call; 300s is not enough.
//
// Adaptive formula (based on LLM_MAX_OUTPUT_TOKENS budget size):
//   timeout = base_overhead + max_tokens × per_token_estimate
//          = 30s + 4096 × 100ms (assuming worst-case rate of 10 t/s) = 440s
//
// Direct Sonnet 4.6 (~50 t/s) in practice only uses ~80s; giving 440s is redundant but harmless (only an upper bound).
// Slow relay (10 t/s) uses it fully. env override retained (for precise control when needed).
//
// PHILONT_LLM_CALL_TIMEOUT_MS: overrides the entire computed result (clamped to 30s-600s)
// PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN: overrides per_token_estimate (default 100ms = 10 t/s)
// Linked to PHILONT_LLM_MAX_TOKENS in llm-adapter.ts: when the reasoning model budget is set large (16000+),
// output budget grows → single generation takes longer → timeout must scale accordingly.
const LLM_MAX_OUTPUT_TOKENS = (() => {
  const raw = process.env.PHILONT_LLM_MAX_TOKENS;
  if (!raw) return 4096;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 256 && n <= 32768) return n;
  return 4096;
})();
const LLM_BASE_OVERHEAD_MS = 30_000; // fixed overhead: network + input processing + time to first token
const LLM_TIMEOUT_CLAMP_MIN_MS = 60_000;
// Cap raised to 15min: reasoning model 16000 tokens × ~40ms/token (production deepseek ~27 t/s)
// ≈ 640s, with thinking headroom. Note: when single LLM call is ≤ 15min, multi-step tasks need a larger
// task_timeout (benchmark harness task-timeout, e.g. 3600s).
const LLM_TIMEOUT_CLAMP_MAX_MS = 900_000;

function computeLlmCallTimeoutMs(): number {
  // Explicit env override takes priority
  const raw = process.env.PHILONT_LLM_CALL_TIMEOUT_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= LLM_TIMEOUT_CLAMP_MIN_MS && n <= LLM_TIMEOUT_CLAMP_MAX_MS) {
      return n;
    }
    console.warn(
      `[llm] PHILONT_LLM_CALL_TIMEOUT_MS=${raw} invalid (allowed ${LLM_TIMEOUT_CLAMP_MIN_MS}-${LLM_TIMEOUT_CLAMP_MAX_MS}), using adaptive`,
    );
  }
  // Adaptive: base + max_tokens × per_token_estimate
  const rawRate = process.env.PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN;
  let msPerToken = 100; // default 100ms/token = 10 t/s (worst-case assumption for slow proxy)
  if (rawRate) {
    const r = parseFloat(rawRate);
    if (Number.isFinite(r) && r >= 5 && r <= 500) {
      msPerToken = r;
    } else {
      console.warn(`[llm] PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN=${rawRate} invalid (allowed 5-500), using default 100`);
    }
  }
  const computed = LLM_BASE_OVERHEAD_MS + LLM_MAX_OUTPUT_TOKENS * msPerToken;
  return Math.max(LLM_TIMEOUT_CLAMP_MIN_MS, Math.min(LLM_TIMEOUT_CLAMP_MAX_MS, computed));
}

const LLM_CALL_TIMEOUT_MS = computeLlmCallTimeoutMs();
console.log(
  `[llm] call timeout: ${LLM_CALL_TIMEOUT_MS}ms` +
    ` (formula: ${LLM_BASE_OVERHEAD_MS}ms base + ${LLM_MAX_OUTPUT_TOKENS} tokens × ${
      process.env.PHILONT_LLM_TOKEN_RATE_MS_PER_TOKEN ?? '100'
    }ms/token, clamp [${LLM_TIMEOUT_CLAMP_MIN_MS}, ${LLM_TIMEOUT_CLAMP_MAX_MS}],` +
    ` env override: ${process.env.PHILONT_LLM_CALL_TIMEOUT_MS ?? 'no'})`,
);

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call exceeded ${ms}ms timeout`);
    this.name = 'LlmTimeoutError';
  }
}

/**
 * Hard deadline for an entire turn. In extreme cases runToolLoop may repeatedly cycle tool_use → failure → tool_use again;
 * even with maxIterations=10, slow individual LLM calls can stretch total time to hours. This adds a hard deadline
 * for the entire turn; when reached, forcibly interrupts and emits a timeout outcome so the user can continue rather than watching a spinner.
 */
// 2026-05-07: 5 min → 10 min. Production logs show 5 min frequently hit — complex tasks
// (especially planAndExecute with 6 sub-tasks × 8 iter) + occasional LLM timeout retries +
// memory compaction + skill hotreload + tool calls (shell python large files can take 30-60s)
// accumulate to more than 5 min. 10 min gives genuine complex tasks room; simple tasks still return in seconds to tens of seconds,
// impact is minimal.
// 2026-05-24: 10 min → 20 min. Benchmark testing of bibtex / scp_crawl-type multi-page
// web scraping tasks showed the LLM tends to fetch N URLs in a single turn loop; hitting the 10-min wall directly fails the task.
// Extended to 20 min to let the LLM finish. Simple tasks are unaffected (naturally a few seconds to tens of seconds).
const TURN_HARD_DEADLINE_MS = 20 * 60_000;

/**
 * Stop taking NEW tool calls this long before the hard deadline, and spend what is left writing the user
 * a reply.
 *
 * The hard deadline is a Promise.race at the top of the turn: it rejects, the error propagates, and
 * everything the turn accumulated is discarded. Production 2026-08-04 20:39:33, `durationMs=1200011`
 * — a real deadline, not a suspended host, on a turn the owner had explicitly approved ("继续lrc证明"
 * → OK). After the z3 version check at 20:19:35 it ran for twenty minutes without a single further tool
 * call and delivered a 46-character error. Whatever it had worked out is gone, and there is nothing to
 * continue from.
 *
 * runToolLoop already knows how to end well — the maxIterations fallback forces a text-only reply that
 * narrates what was tried. The iteration cap gets that treatment and the clock does not, which is the
 * whole defect: two ways to run out, one graceful exit. So the clock now stops the loop with headroom
 * and lands on the same fallback.
 *
 * Three minutes: an LLM text call under this config can take minutes (call timeout is 7.3 min), and a
 * wrap-up that itself blows the deadline would be worse than useless. The hard deadline stays as the
 * backstop behind it.
 */
const TURN_WRAPUP_HEADROOM_MS = 3 * 60_000;

/**
 * When does this session's current turn run out of time?
 *
 * The wrap-up above is worthless on its own, and the turn that prompted it proves why: the loop can only
 * check its watch when control comes back to the top of the loop, and on 2026-08-04 it did not come back
 * for twenty minutes. It was inside ONE logical LLM call.
 *
 * The arithmetic nobody had done: the per-call timeout is adaptive (30s + 4096 tokens x 100ms = 439.6s),
 * and sendLlmWithRescue retries once on timeout, so a single call can legitimately occupy 2 x 7.3 = 14.6
 * minutes of a 20-minute turn. Add the tool calls before it and the turn is dead with nothing delivered.
 * 20:19:35 + 439.6s lands at 20:26:54, which is exactly where the log shows the retry firing.
 *
 * Neither number was wrong on its own; they were chosen in different files with no reference to each
 * other. So the call budget is now derived from what the TURN has left, and the loop is guaranteed to get
 * control back before the hard deadline instead of being killed inside an await.
 *
 * Background callers (autonomous ticks, idle consolidation) have no turn and get Infinity — unchanged.
 */
const turnDeadlines = new Map<string, number>();

/** A small margin so the call returns BEFORE the budget it was given is fully gone. */
const LLM_BUDGET_SAFETY_MS = 20_000;
/** Log any LLM call at least this slow — the evidence a latency death needs and never had. */
const LLM_SLOW_CALL_LOG_MS = 30_000;
/** Never shrink a call below this: a budget too small to answer in is the same as no call at all. */
const LLM_BUDGET_FLOOR_MS = 45_000;

export function turnRemainingMs(sessionId: string, now: number = Date.now()): number {
  const deadline = turnDeadlines.get(sessionId);
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now;
}

/** The timeout one LLM call may take, given how much of the turn is left. Exported for testing. */
export function llmCallBudgetMs(
  remainingMs: number,
  callTimeoutMs: number = LLM_CALL_TIMEOUT_MS,
): number {
  if (!Number.isFinite(remainingMs)) return callTimeoutMs;
  return Math.max(LLM_BUDGET_FLOOR_MS, Math.min(callTimeoutMs, remainingMs - LLM_BUDGET_SAFETY_MS));
}

/** Is there room for another full-length attempt after one already timed out? */
export function hasRoomForTimeoutRetry(remainingMs: number): boolean {
  if (!Number.isFinite(remainingMs)) return true;
  return remainingMs - LLM_BUDGET_SAFETY_MS >= LLM_BUDGET_FLOOR_MS;
}

export class TurnDeadlineError extends Error {
  constructor(ms: number) {
    super(`turn exceeded ${ms}ms hard deadline`);
    this.name = 'TurnDeadlineError';
  }
}

/** Promise.race with timeout — note the underlying request is still running; only the main loop is unblocked. */
function withTimeout<T>(p: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    timeout,
  ]);
}

/**
 * 2026-06-07: Main-turn reasoning was previously implicit-always-on (the provider defaulted thinking on for
 * every turn). It is now made EXPLICIT so it can be tuned per channel and, importantly, so we always send a
 * concrete reasoning config — which also avoids DeepSeek's reasoning_content echo-400 trap (an absent config
 * let stale reasoning_content leak back into the request). Tunable via PHILONT_CHAT_REASONING ∈
 * {off,low,medium,high,max}; default `high` preserves the prior implicit-on quality. Cheap channels can set `off`.
 */
function mainTurnReasoning(userText?: string | null): ReasoningConfig {
  // Trivial turn downshift (2026-07-16): a bare greeting/opener ("hi", "你好") does not need deep thinking —
  // prod: a single "hi" took 48s of high-effort reasoning to produce "Hi!". Give openers 'low' effort so a
  // greeting is fast. Only the unambiguous opener case is downshifted; every real message keeps full effort,
  // so quality is untouched. PHILONT_CHAT_REASONING still sets the ceiling for real turns.
  if (userText && isConversationOpener(userText)) return { enabled: true, effort: 'low' };
  const raw = (process.env.PHILONT_CHAT_REASONING ?? 'high').trim().toLowerCase();
  if (raw === 'off') return { enabled: false };
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
    return { enabled: true, effort: raw };
  }
  // Unrecognised value → fall back to the default (high).
  return { enabled: true, effort: 'high' };
}

/**
 * Wrapper around llm.send:
 *   1. Each call is wrapped with a LLM_CALL_TIMEOUT_MS hard timeout (prevents socket hang from deadlocking the entire turn).
 *   2. If the provider throws ContextTooLargeError (400/413 + "too large"), trigger
 *      full tool_result eviction + one retry (retry also wrapped with timeout).
 *
 * If retry still fails / times out, throw; the outer handleChatSend try/catch rolls back this turn and
 * feeds back to the user, preventing the session from permanently stalling.
 */
async function sendLlmWithRescue(
  messages: NativeMessage[],
  tools: ToolDefinition[],
  sessionId: string,
  /**
   * 2026-05-19 three-stream separation: sendLlmWithRescue only produces Tier 4 system events (timeout retry /
   * context eviction), not Tier 1 results. Fourth parameter changed from onDelta to optional onTrace.
   */
  onTrace?: TraceFn,
): Promise<LLMResponse> {
  // Interrupt teeth: if this turn is stopped by the user, signal is passed to the underlying LLM HTTP to cancel the in-flight call.
  const signal = turnAbortSignal(sessionId);
  // 2026-06-07: send an explicit per-turn reasoning config (see mainTurnReasoning) instead of relying on the
  // provider's implicit always-on thinking; tunable via PHILONT_CHAT_REASONING.
  const reasoning = mainTurnReasoning(findLastUserText(messages));
  // The budget is what the TURN has left, not a constant computed in isolation. See turnDeadlines.
  const budgetMs = () => llmCallBudgetMs(turnRemainingMs(sessionId));
  const call = async () => {
    const ms = budgetMs();
    const startedAt = Date.now();
    try {
      return await withTimeout(llm.send(messages, tools, { signal, reasoning }), ms, () => new LlmTimeoutError(ms));
    } finally {
      // How long did THIS call take? The 2026-08-04 20:19-20:39 turn burned its entire 20-minute budget
      // with zero tool calls, and the log cannot say why: there is no `[llm] timeout` line, so nothing
      // exceeded the per-call timeout — several calls simply took a long time each, and not one of them
      // is recorded anywhere. A turn that dies of accumulated latency must leave the latency behind.
      const took = Date.now() - startedAt;
      if (took >= LLM_SLOW_CALL_LOG_MS) {
        const left = turnRemainingMs(sessionId);
        console.warn(
          `[llm] slow call session=${safeSessionId(sessionId)} took ${Math.round(took / 1000)}s ` +
            `(budget ${Math.round(ms / 1000)}s, turn left ${Number.isFinite(left) ? Math.round(left / 1000) + 's' : 'n/a'})`,
        );
      }
    }
  };
  try {
    return await call();
  } catch (e) {
    // User mid-turn stop cancelled the in-flight LLM call → propagate directly; do not record noisy api_error audit.
    // handleChatSend catch will map it to interrupted outcome.
    if (isAbortError(e)) throw e;
    if (e instanceof LlmTimeoutError) {
      // Real scenario: Anthropic stream occasionally returns only after waiting tens of seconds for the first token.
      // After the first 60s timeout fires, retry once directly — the dangling old request is GC'd by the SDK;
      // the new request returns in a second or two in most cases. Only when both timeout does it propagate to the outer layer.
      // The retry is what turns one slow call into 14.6 minutes of a 20-minute turn. Only take it when
      // the turn can still afford a full attempt; otherwise give the remaining time back to the loop,
      // which will spend it writing the user a reply instead of on a second wait.
      if (!hasRoomForTimeoutRetry(turnRemainingMs(sessionId))) {
        console.warn(
          `[llm] timeout session=${safeSessionId(sessionId)} after ${LLM_CALL_TIMEOUT_MS}ms — NOT retrying, ` +
            `${Math.round(turnRemainingMs(sessionId) / 1000)}s left of the turn (wrap-up needs it)`,
        );
        throw e;
      }
      console.warn(`[llm] timeout session=${safeSessionId(sessionId)} after ${LLM_CALL_TIMEOUT_MS}ms — retrying once`);
      onTrace?.({
        kind: 'system-event',
        tier: 4,
        text: `LLM call timed out (${LLM_CALL_TIMEOUT_MS / 1000}s), retrying`,
      });
      try {
        const r = await call();
        console.log(`[llm] timeout retry session=${safeSessionId(sessionId)} succeeded`);
        return r;
      } catch (e2) {
        if (e2 instanceof LlmTimeoutError) {
          console.warn(`[llm] timeout retry session=${safeSessionId(sessionId)} also failed after ${LLM_CALL_TIMEOUT_MS}ms — giving up`);
          internalAudit.append('task_failure_mode', {
            sessionId,
            kind: 'llm_timeout',
            ts: Date.now(),
            detail: `LLM call timed out twice (${LLM_CALL_TIMEOUT_MS}ms each)`,
          });
        }
        throw e2;
      }
    }
    if (!(e instanceof ContextTooLargeError)) {
      // Other API errors (e.g. 400 "Improperly formed request" / 5xx upstream) — also counted as task failure
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'llm_api_error',
        ts: Date.now(),
        detail: String((e as Error)?.message ?? e).slice(0, 200),
      });
      throw e;
    }
    const before = estimateTotalTokens(messages);
    console.warn(
      `[llm] ContextTooLargeError session=${safeSessionId(sessionId)} tokens≈${before}: ${e.message.slice(0, 200)} — emergency evict retry`,
    );
    onTrace?.({
      kind: 'system-event',
      tier: 4,
      text: 'Context exceeded model window; evicting old tool results and retrying (keeping last 2 tool results)',
    });
    const r = evictForEmergency(messages);
    console.log(
      `[llm] emergency evict session=${safeSessionId(sessionId)}: ${r.tokensBefore} → ${r.tokensAfter} tokens (${r.evictedCount} items, keep recent ${BUDGET.emergencyKeepRecent})`,
    );
    try {
      return await call();
    } catch (e3) {
      // Still fails after emergency eviction → record task failure (api_error type, details include ContextTooLarge context)
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'llm_api_error',
        ts: Date.now(),
        detail: `ContextTooLarge eviction retry failed: ${String((e3 as Error)?.message ?? e3).slice(0, 150)}`,
      });
      throw e3;
    }
  }
}

/**
 * Session end: batch extraction (facts) + reflection (skills) + backfill session summary
 *
 * Three independent LLM calls (failures are isolated from each other):
 *   1. extractor.extractFromSession → facts
 *   2. reflector.reflectFromSession → skills
 *   3. backfillSessionSummary       → session-summary note (if Compactor has not written one yet)
 */
export async function finalizeSession(sessionId: string): Promise<void> {
  if (!activeSessions.has(sessionId)) return;
  activeSessions.delete(sessionId);
  await runFinalize(sessionId);
  sessionSkillsRevision.delete(sessionId);
}

/**
 * Core steps of finalize (does not check activeSessions); orphan scan also reuses this path.
 */
async function runFinalize(sessionId: string): Promise<void> {
  memory.raw.endSession(sessionId);

  try {
    const result = await extractor.extractFromSession(sessionId);
    console.log(
      `[memory] session=${safeSessionId(sessionId)} fact extraction: ${result.factsStored} facts, ${result.notesStored} notes`,
    );
  } catch (e) {
    console.error(`[memory] fact extraction failed session=${safeSessionId(sessionId)}:`, e);
  }

  try {
    const result = await reflector.reflectFromSession(sessionId);
    console.log(
      `[memory] session=${safeSessionId(sessionId)} skill reflection: ${result.skillsCreated} created, ${result.skillsUpdated} updated`,
    );
  } catch (e) {
    console.error(`[memory] skill reflection failed session=${safeSessionId(sessionId)}:`, e);
  }

  // v7: pursuit proposal (shadow state) — independent LLM pass; failure does not affect other steps
  try {
    const result = await pursuitExtractor.extractFromSession(sessionId);
    if (result.pursuitsProposed > 0) {
      console.log(
        `[pursuit] session=${safeSessionId(sessionId)} created shadow pursuit: ${result.pursuitsProposed}`,
      );
    }
  } catch (e) {
    console.error(`[pursuit] proposal failed session=${safeSessionId(sessionId)}:`, e);
  }

  // v7: drive reflection — scans unscored outcomes to backfill utility + adjusts drive_config parameters.
  // No LLM involved; purely heuristic + EWMA, so it can run after any session ends.
  try {
    const result = await driveReflector.reflect();
    if (result.outcomesScored > 0 || result.driveParamsTuned > 0) {
      console.log(
        `[drive-reflect] scored=${result.outcomesScored}, ewma_updated=${result.driveEwmaUpdated}, tuned=${result.driveParamsTuned}, skipped_oob=${result.tuneSkippedOutOfBounds}`,
      );
    }
  } catch (e) {
    console.error(`[drive-reflect] reflection failed:`, e);
  }

  // K3: self-description reflection — synthesizes skills/pursuits to produce a first-person self-description with sourceRefs,
  // writes to memory_facts['self.*']. Next session's buildMemoryPrefix will inject it into the LLM.
  try {
    const result = await selfReflector.reflect();
    if (result.updated) {
      console.log(
        `[self-reflect] session=${safeSessionId(sessionId)} summary updated (sourceIntegrity=${result.sourceIntegrity.toFixed(2)}, strengths=${result.strengths.length}, edges=${result.growthEdges.length})`,
      );
    }
  } catch (e) {
    console.error(`[self-reflect] self-reflection failed session=${safeSessionId(sessionId)}:`, e);
  }

  try {
    await backfillSessionSummary(sessionId);
  } catch (e) {
    console.error(`[memory] session summary backfill failed session=${safeSessionId(sessionId)}:`, e);
  }
}

/**
 * If this session has no session-summary note yet (meaning Compactor has not compacted it),
 * run a short LLM call to generate one, for the next session to pick up.
 * Sessions already written by Compactor are no-op here (getNoteById hits).
 */
async function backfillSessionSummary(sessionId: string): Promise<void> {
  const existing = memory.notes.getNoteById(`session-summary-${sessionId}`);
  if (existing) return;

  const messages = memory.raw.getMessages(sessionId);
  if (messages.length < 2) return;

  const dialogue = messages
    .map((m) => {
      const content =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${m.role}] ${content}`;
    })
    .join('\n');

  const prompt =
    'Below is a completed conversation. Summarize it in 3-5 sentences: the main task, what was completed, any open items or threads to continue next time.\n' +
    'Output narrative prose — no markdown headings or lists. If there are unanswered user questions or promised deliverables, name them explicitly.\n\n' +
    dialogue +
    '\n\nSummary:';

  const resp = await extractorLlm.complete(prompt);
  const summary = resp.text.trim();
  if (!summary) return;

  const note = memory.notes.upsertNote(`session-summary-${sessionId}`, {
    content: summary,
    importance: 1.0,
    sessionId,
  });
  internalAudit.append('self_domain_write', {
    source: 'finalize_session',
    origin: 'Internal',
    toolName: 'store_note',
    sessionId,
    noteId: note.id,
  });
}

/**
 * Orphan session cleanup: when the server restarts / crashes / WebSocket closes abnormally, the session's
 * ended_at is not written and extractor/reflector have not run. On a new WebSocket connection,
 * scan the most recent sessions with ended_at IS NULL that "appear dead" and finalize them.
 *
 * Strategy:
 *   - Finalize the most recent 1 orphan synchronously so its summary can enter the current buildMemoryPrefix
 *   - Finalize the rest asynchronously in the background to avoid blocking the first message response
 */
const ORPHAN_IDLE_MS = 30 * 60 * 1000;

async function scanOrphanSessions(): Promise<void> {
  const candidates = memory.raw
    .listSessions({ limit: 5 })
    .filter((s) =>
      s.endedAt === null &&
      !activeSessions.has(s.id) &&
      // K0: the GLOBAL timeline is never treated as an orphan for extraction — its "full message set" is
      // the agent's entire lifetime; batch-finalizing it once drains all history, overloading the LLM and cost.
      // Instead it is advanced by idle_consolidator (K0.6) with a time window.
      s.id !== GLOBAL_TIMELINE_SESSION_ID,
    );
  if (candidates.length === 0) return;

  const now = Date.now();
  const stale: string[] = [];
  for (const s of candidates) {
    const msgs = memory.raw.getMessages(s.id);
    if (msgs.length === 0) continue;
    let lastTs = 0;
    for (const m of msgs) if (m.timestamp > lastTs) lastTs = m.timestamp;
    if (now - lastTs < ORPHAN_IDLE_MS) continue;
    stale.push(s.id);
  }
  if (stale.length === 0) return;

  const [first, ...rest] = stale;
  try {
    await runFinalize(first);
    console.log(`[memory] orphan finalized (blocking): ${first}`);
  } catch (e) {
    console.error(`[memory] orphan finalize failed ${first}:`, e);
  }

  for (const id of rest) {
    runFinalize(id)
      .then(() => console.log(`[memory] orphan finalized (background): ${id}`))
      .catch((e) => console.error(`[memory] orphan finalize failed ${id}:`, e));
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────────

/**
 * K0: reconstruct working context before each LLM call.
 * Do not cache the messages array across turns — that is a websocket connection artifact that
 * slices the agent's "self" into protocol fragments. Each turn recalls fragments from the raw global timeline and assembles systemPrompt + memoryPrefix.
 */
function buildFreshMessages(
  userMessageForRecall: string,
  sessionId: string,
  signalBus?: TurnSignalBus,
): NativeMessage[] {
  const memoryPrefix = buildMemoryPrefix(userMessageForRecall, signalBus);
  // 2026-05-09: autonomous turns (system:scheduled:*) only look at their own sessionId's
  // history. K0 timeline is global by default, but cross-session recall pulls other sessions'
  // (e.g. wechat) conversations into messages, misused by short_answer_binding / LLM reasoning
  // (observed in production: mycox heartbeat killed itself — the agent treated wechat's previous
  // turn "I'll switch for you" as the current turn's intent, and the first tool was cancel_schedule).
  // See plan misty-juggling-mist.md for details.
  const isAutonomous = sessionId.startsWith('system:scheduled:');
  const restrictToSessionIds = isAutonomous ? [sessionId] : undefined;

  const tz = process.env.AGENT_TIMEZONE || 'UTC';
  const nowIso = new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
  const timeContext =
    `\nCurrent time: ${nowIso} (${tz}).` +
    ` To get real-time time, call the time tool with timezone=${tz}.`;

  // philont's charter (constitution) — injected into the identity prompt every turn so it actually
  // shapes behaviour. Source of truth is the pursuit-root constitution (frozen at load); falls back to
  // the version-controlled defaults when the live root's fields are still NULL (e.g. an older DB), so the
  // charter takes effect without a DB migration. See agent-memory/src/constitution_defaults.ts.
  const charterValues = constitution?.values ?? DEFAULT_CONSTITUTION_VALUES;
  const charterRedLines =
    constitution?.redLines && constitution.redLines.length
      ? constitution.redLines
      : DEFAULT_CONSTITUTION_RED_LINES;
  const charterBlock =
    `\n\n## Your charter — who you are and how you serve (constitution)\n${charterValues}` +
    (charterRedLines.length
      ? `\n\nRed lines — never cross these:\n${charterRedLines.map((r) => `- ${r}`).join('\n')}`
      : '');

  // Capability manifest — generated from live runtime state (flags + registered drivers + tool count),
  // NOT hand-authored, so the agent self-assesses against the current build instead of a stale memory of
  // itself (prod 2026-07-11: reported just-shipped self-repair/versioning/trajectory features as ❌).
  const capabilityBlock = capabilityManifestInjectEnabled()
    ? '\n\n' + renderCapabilityManifest(buildCapabilityState(tools.list().length))
    : '';

  // The owner's compass — their authored voice + declared focus areas. This is how "what I care about"
  // reaches the model (Phase 1). Empty when there is no compass.md.
  const compassRendered = renderCompassForPrompt(loadedCompass);
  const compassBlock = compassRendered ? `\n\n## From my owner (compass)\n${compassRendered}` : '';

  const init: NativeMessage[] = [
    {
      role: 'user',
      content:
        DEFAULT_IDENTITY_SELF_DESCRIPTION +
        ` You stay with one user across channels (WeChat, Telegram, web) and act through a broad, permission-gated toolset` +
        ` — files, shell, web, persistent memory, skills, vision, and mounted MCP servers. Working directory: ${process.cwd()}.` +
        charterBlock +
        compassBlock +
        capabilityBlock +
        `\n\nTool-use principles:` +
        `\n- Do not call tools for ordinary chit-chat. (Exception: persisting a durable fact the user just revealed is never "chit-chat" — store_fact it even mid-conversation; see the proactive-memory principle below.)` +
        `\n- When the user asks you to "remember / note down / set" any fact (name, preference, role, project info, etc.),` +
        ` you MUST immediately call store_fact to persist it. Put things about the user under namespace=user, project-related under project, role/identity under user.role.` +
        `\n\n**Proactive-memory principle** — because you persist over time and build up an understanding of your user, call store_fact immediately (even without "remember") whenever the user reveals something durable about themselves or their work:` +
        `\n  1) **Preferences**: "I prefer X over Y / I'd rather not / I always ..."` +
        `\n     → store_fact(namespace=user, key=preferences.<topic>, value={likes:[...], dislikes:[...]})` +
        `\n     Example: "I prefer concise answers and metric units" → user.preferences.style = {likes:["concise","metric units"]}` +
        `\n     **First get_fact the existing value, merge, then store_fact to overwrite** (otherwise you lose info)` +
        `\n  2) **Constraints**: "no meetings before 10am / never force-push to main / keep this repo private"` +
        `\n     → user.constraints.<topic> (a hard rule to respect in future work — must record)` +
        `\n  3) **Attributes/identity**: "I'm in Beijing / I'm a backend engineer / my timezone is UTC+8"` +
        `\n     → user.location / user.role / user.timezone` +
        `\n  4) **Plans/events**: "shipping the release next Tuesday" / "reviewing the draft tonight"` +
        `\n     → fact_kind=event, occurred_at as ISO8601 absolute time` +
        `\n  5) **Negative preferences and constraints matter most**: when the user rejects or rules something out, almost always record it — ignoring it later breaks trust.` +
        `\n- When the user asks "who am I / do you remember", first list_facts or get_fact, then answer.` +
        `\n- Before giving advice or recommendations, list_facts(user) to honor the user's recorded preferences/constraints and avoid suggesting something they ruled out.` +
        `\n- Use webSearch when you need to search the web or get up-to-date info; use webFetch to read a specific page.` +
        `\n- Saying "ok, got it" without calling the tool = not remembered. You must go through the tool.` +
        `\n- Reminders schedule_reminder: when the user says "every X minutes / every X / daily" you MUST pass interval_ms (milliseconds),` +
        ` not at; use at only for "after X / at a specific time". Same-named tasks auto-replace, so don't worry about duplicates.` +
        `\n- To cancel a reminder you MUST use cancel_schedule (pass name for fuzzy match);` +
        ` never use schedule_reminder to "cancel" — that only creates another pointless task.` +
        `\n\n**Task-start priority (strict order)**:` +
        `\n  1. **First search_skills + use_skill** — for any task, check for an existing skill first.` +
        ` Bundled skills (service-onboarding / skill-creator / clawhub / web-research / git-workflow, etc.) cover common domains.` +
        ` **If a "When to Use" matches, use_skill — don't planAndExecute around the skill.**` +
        `\n  2. **Simple tasks: call the tool directly** — single-step or ≤3-step clear flows: readFile / writeFile / shell / http / get_fact, etc.` +
        `\n  3. **Complex multi-step with no existing skill** → use \`planAndExecute({task: "..."})\` to auto-plan + dispatch.` +
        `\n` +
        `\n**Counter-example (hit in production)**: the user says "register per the <service> guide" (any external-service doc) → calling planAndExecute to break it into 5 steps bypasses the \`service-onboarding\` skill,` +
        ` and you miss step 5 (create the heartbeat schedule). **Correct**: use_skill('service-onboarding'), which teaches all 6 steps including the heartbeat.` +
        ` **Generic process docs** (SOP / runbook / API manual, no-credential + periodic-heartbeat) similarly should be turned into a reusable skill via use_skill('doc-to-skill') rather than run from memory.` +
        `\n` +
        `\n**When to use planAndExecute**:` +
        `\n  - **When**: the task needs ≥5 tool steps and no skill matches. E.g.:` +
        ` cross-file refactors, read→write→verify chains, bulk source conversion, research reports.` +
        `\n  - **Mechanism**: it first uses an LLM to break the task into sub-tasks, then runs an isolated sub-loop per sub-task;` +
        ` **from the parent turn's view it completes in 1 iter**, so it won't hit the main loop cap (default 20).` +
        `\n  - **When not**: a skill matches / single-step / tasks needing mid-way user input / clearly ≤3-step small tasks.` +
        `\n\n**Reply-format contract (applies to all channels)**: your final text reply MUST use this two-section markdown:\n` +
        `\n## For User\n` +
        `<content for the user-facing client. WeChat and similar terminals push **only** this section — anything outside it is NEVER delivered. Default concise (≤ ~200 chars, conclusion + necessary progress). **BUT when the user asked for an analysis / report / detailed answer, this section must carry the COMPLETE deliverable** — never a one-line conclusion with the substance left in Work Log (the user cannot see it; they will rightly complain the analysis is missing).>\n` +
        `\n## Work Log\n` +
        `<full reasoning / table restatement / tool-result dump / self-check. Goes **only** to the timeline, not pushed to the user. May be detailed.>\n` +
        `\nThe two-section format applies only to the **final natural-language reply**; during tool-calling, emit tool_use as usual without these headings.\n` +
        `If there is no work to log, the "## Work Log" section may just say "none". But the "## For User" section MUST have content,` +
        ` otherwise the fallback mechanism may take the last section and accidentally expose it to the user.` +
        // i18n: prompt language (English) is decoupled from reply language — the user-facing "## For User"
        // section follows the channel/user language (WeChat → Chinese). See response_language.ts (and docs/i18n/glossary.md for terminology).
        buildLanguageDirective(
          resolveResponseLanguage({ channel: sessionId, userLocale: readUserLanguage() }),
        ) +
        timeContext +
        memoryPrefix,
    },
    { role: 'assistant', content: 'Understood. I\'ll use the two-section format: ## For User + ## Work Log. For User carries EVERYTHING the user should read — concise (≤ ~200 chars) for status updates, but the COMPLETE deliverable when they asked for an analysis / report / detailed answer (they never see Work Log). Work Log keeps process and tool-result detail only. I\'ll follow the store_fact / list_facts memory principles too.' },
  ];

  // Timeline recall: user turns use the global continuous history; autonomous turns strictly limit to this session
  const recalled = timelineRetriever.retrieve({
    recentBudgetTokens: TIMELINE_RECENT_BUDGET,
    recallBudgetTokens: TIMELINE_RECALL_BUDGET,
    recallQuery: userMessageForRecall,
    restrictToSessionIds,
    // "Recent", in a chat, means THIS chat. Recall stays global so cross-channel continuity survives,
    // but foreign lines arrive labelled instead of impersonating the live thread. See timeline.ts.
    homeSessionId: sessionId,
  });
  for (const m of recalled.messages) {
    init.push({ role: m.role, content: m.content });
  }
  console.log(
    `[timeline] retrieved ${recalled.recencyCount} recent + ${recalled.recallCount} recall msgs (~${recalled.totalTokens} tokens${
      isAutonomous ? `, scoped to ${safeSessionId(sessionId)}` : `, recent scoped to ${safeSessionId(sessionId)}`
    })`,
  );

  return init;
}

/**
 * Tool authorization request structure (2026-05-19 WeChat-side UX refactor):
 *   - chat-handler no longer formats a human-readable string; instead passes a struct to the channel
 *   - the channel decides how to render it (WeChat uses formatToolForAuth to expand parameter details;
 *     web-ui keeps backward compatibility with the existing string text UX)
 *   - clarification non-empty = "previous response was not understood, ask again" (original line 3887 path)
 */
export type AuthRequest = {
  /** Stable id of the suspended tool call; channels echo it when the auth card is delivered. */
  requestId?: string;
  toolName: string;
  capability: string;
  domain: string;
  input: unknown;
  clarification?: string;
};

/**
 * Tier 3/4 detail events (2026-05-19 three-stream separation architecture).
 *
 * Three-stream separation: onDelta=Tier1 result / onStatus=Tier2 progress / onTrace=Tier3 detail + Tier4 internal.
 * onTrace is consumed only by debug / observability panels (web-ui debug panel). Channels may not implement
 * onTrace at all (WeChat does not) — does not affect the main flow; `onTrace?.(...)` optional chaining is zero-cost.
 */
export interface ChannelTraceEvent {
  /** Event category. Determines the icon / grouping in the frontend collapsible panel. */
  kind:
    | 'tool-invocation'   // pre-invocation tool detail (Tier 3)
    | 'tool-result'       // tool result detail (Tier 3)
    | 'internal-gate'     // internal-drive gate fired: Honesty/EmptyConclusion/... (Tier 4)
    | 'system-event'      // system event: LLM timeout / context window exceeded / fallback degradation (Tier 4)
    | 'auth-decision'     // authorization result: granted / denied (Tier 4)
    | 'loop-control';     // turn control: iter-warning / plan degradation / same-root-cause (Tier 4)
  /** Human-readable single-line text. Final display form; rendered directly by the frontend. */
  text: string;
  /** Tier marker. 3 = detail, 4 = internal (frontend may render darker). */
  tier: 3 | 4;
  /** Structured extra info; frontend may optionally use for chip / tooltip. All fields optional. */
  meta?: {
    toolName?: string;
    success?: boolean;
    gateName?: string;
    severity?: string;
    iteration?: number;
    evidenceLevel?: string;
    successfulTools?: string[];
  };
}

/** onTrace callback type. Optional — if the channel does not pass it, no trace overhead is incurred. */
export type TraceFn = (ev: ChannelTraceEvent) => void;

/**
 * Learning judge — Phase 1 SHADOW wiring (self_learning_redesign). Scores the turn and LOGS the verdict;
 * drives NOTHING. Its whole purpose right now is to accumulate a real production distribution so the
 * Phase-2 kill gate can decide whether the judge is trustworthy (agrees with honesty_gate on clear cases,
 * not ~100% could_not_verify) before it is ever wired to promotion/crystallization. Default on — shadow is
 * safe because it only logs. PHILONT_LEARNING_JUDGE=0/off disables it.
 */
function learningJudgeEnabled(): boolean {
  const v = (process.env.PHILONT_LEARNING_JUDGE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * Which text the learning judge should score this turn against.
 *
 * Returns null when the turn cannot be judged at all — a pending-auth resume whose original message is no
 * longer recoverable. See shadowLearningJudge for why scoring the approval word is worse than not scoring.
 */
/**
 * How long an unanswered question stays bindable. A reply arriving minutes later is answering it; a reply
 * arriving the next morning is starting the day. See the site below for what the 12-hour bind cost.
 */
export const SHORT_ANSWER_BINDING_TTL_MS = (() => {
  const raw = Number(process.env.PHILONT_SHORT_ANSWER_BINDING_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000;
})();

export function resolveJudgeGoal(
  carriedGoal: string | undefined,
  userMessage: string | undefined,
  resumedFromAuth: boolean,
  lastRoutedGoal?: string,
  activeWorkGoal?: string,
  turnAdvancedActiveWork = false,
): string | null {
  // A concrete machine-facing step is a better judging target than an owner's directional
  // instruction ("continue the proof"). Production 2026-08-22 had real Lean artifacts and
  // verifier calls in every turn, yet 5/5 samples were labelled not_applicable because the
  // judge only saw "继续做 lrc 证明". Prefer the active plan/tree leaf when one exists.
  const msg = (userMessage ?? '').trim();
  // A fresh, self-contained owner request is the goal of THIS turn. Neither a carried exploration
  // goal nor a stale plan/tree leaf may confiscate a new instruction. Short status questions are
  // treated as self-contained only when the turn remained observational; if the turn actually ran an
  // execution/verifier, score the concrete plan/tree step it advanced instead.
  const shortSelfContainedStatus =
    /^(?:总结|概括|列出|解释|分析|检查|查看|告诉我)/.test(msg) ||
    /(?:有进展|下一步|下面怎么做|怎么做|如何|为什么|是什么|吗)[？?]?$/.test(msg);
  if (!resumedFromAuth && (messageIsSelfContainedGoal(msg) || (!turnAdvancedActiveWork && shortSelfContainedStatus))) {
    return msg;
  }
  const activeWork = (activeWorkGoal ?? '').trim();
  if (activeWork) return activeWork;
  const carried = (carriedGoal ?? '').trim();
  if (carried) return carried;
  const lastRouted = (lastRoutedGoal ?? '').trim();
  // An auth resume with no carried explore goal used to emit NOTHING. Honest, but it left the judge blind
  // on exactly the turns most worth judging: an execute-class tool is what raises an auth card, so resumed
  // turns carry the most tool evidence in the sample. Production 2026-07-25: four skips in one evening, one
  // of them the best-grounded turn of the day (downloaded the House of Graphs 4-critical set and verified
  // all 80 graphs) — while the day's judge total stood at 1. The session's last routed substantive message
  // IS the goal those turns are executing; judging against it is right, and it is nothing like judging
  // against the word "ok" that the 07-22 fix removed. With no such goal, still emit nothing.
  if (resumedFromAuth) return lastRouted.length >= 12 ? lastRouted : null;
  // A bare continuation word sent as a FRESH message — "ok", "继续" — is not a goal either; the auth-resume
  // fix did not cover it, and the judge duly burned an aux call concluding 'The goal "ok" is too vague to
  // determine what constitutes success' (2026-07-24 16:50, the second appearance of that exact sentence).
  // The session's last routed substantive message is what such a turn is actually continuing. Length-based
  // on purpose: a WORD LIST of continuation tokens is the trap this repo keeps documenting, and a real
  // 4-character task is rare enough that judging it against the prior goal is the better error.
  if (msg.length > 0 && msg.length <= 4 && (lastRoutedGoal ?? '').trim().length > msg.length) {
    return lastRoutedGoal!.trim();
  }
  return msg;
}

/** Nodes that require an owner/manual action are acceptance chores, not work the current agent turn can achieve. */
export function isExternalAcceptanceNode(claim: string): boolean {
  const text = claim.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return (
    /^(?:验收|人工验收|用户验收)[：:]/i.test(text) ||
    /(?:用户|你|owner|user)\s*(?:在本机)?\s*(?:执行|运行|run|execute)/i.test(text) ||
    /(?:等待|请)\s*(?:用户|你).{0,12}(?:确认|执行|运行|验收)/i.test(text) ||
    /\b(?:manual|owner|user)\s+(?:acceptance|verification|run|execution)\b/i.test(text)
  );
}

/** Same value/depth ranking used by the deep-explore final report, excluding external chores. */
export function selectJudgeFrontierGoal(nodes: ReasoningNode[]): string | undefined {
  return [...computeFrontier(nodes)]
    .filter((n) => !isExternalAcceptanceNode(n.claim))
    .sort((a, b) => (b.value ?? 0.5) - (a.value ?? 0.5) || a.depth - b.depth)[0]
    ?.claim.trim() || undefined;
}

/** Query used by memory/skill relevance: continuations inherit the concrete active step. */
export function resolveRecallInput(
  userMessage: string,
  activeWorkGoal?: string,
  carriedGoal?: string,
): string {
  return messageIsSelfContainedGoal(userMessage)
    ? userMessage
    : (activeWorkGoal?.trim() || carriedGoal?.trim() || userMessage);
}

/** Current concrete work target shared by skill recall and the learning judge. */
function activeWorkGoalForSession(sessionId: string): string | undefined {
  try {
    const plan = memory.plans.listBySession(sessionId, { limit: 1 })[0];
    if (plan && (plan.status === 'draft' || plan.status === 'executing')) {
      const step = plan.steps.find((s) => s.status === 'doing')
        ?? plan.steps.find((s) => s.status === 'pending' || s.status === 'blocked');
      if (step?.description.trim()) return `Complete plan step: ${step.description.trim()}`;
    }
    const reasoningSession = focusedReasoningSession(sessionId);
    if (!reasoningSession) return undefined;
    const leaf = selectJudgeFrontierGoal(memory.reasoning.getNodes(reasoningSession.id));
    return leaf ? `Prove or refute the active reasoning node: ${leaf}` : undefined;
  } catch (e) {
    console.warn(`[active-work] lookup failed (ignored):`, e);
    return undefined;
  }
}

/** Last-resort channel text when the model stays empty after the one regeneration attempt. */
export function renderEmptyConclusionFallback(
  records: ReadonlyArray<{ toolName: string; success: boolean }>,
  lang: 'zh' | 'en' = 'zh',
): string {
  const ok = records.filter((r) => r.success).length;
  const failed = records.length - ok;
  if (lang === 'en') {
    return `This turn ran ${records.length} tool call(s): ${ok} succeeded and ${failed} failed, but no usable conclusion was generated. Please continue and I will resume from the recorded results.`;
  }
  return `本轮执行了 ${records.length} 次工具调用：${ok} 次成功、${failed} 次失败，但未能生成可用结论。请回复“继续”，我会从已记录的结果接着处理。`;
}

function shadowLearningJudge(
  sessionId: string,
  userMessage: string | undefined,
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  bus:
    | {
        inTurnRecords?: Array<{ toolName: string; success: boolean; resultText?: string }>;
        honesty?: unknown;
        carriedExploreGoal?: string;
      }
    | undefined,
  resumedFromAuth = false,
): void {
  if (!learningJudgeEnabled()) return;
  try {
    const records = bus?.inTurnRecords ?? [];
    if (records.length === 0) return; // nothing ran this turn — no verdict worth logging
    // On a pending-auth RESUME the turn's userMessage is the approval word — "ok" — not the task. Judging
    // "did this turn achieve the goal 'ok'?" can only ever come back could_not_verify, and the judge said
    // so in as many words in production ("The goal \"ok\" is too vague to determine what constitutes
    // success"). The damage is directional: an execute-class tool is exactly what raises an auth card, so
    // resumed turns are the ones carrying the MOST tool evidence — the highest-signal sample, poisoned
    // wholesale. Phase 2 is gated on this distribution being trustworthy, so the gate could never open.
    // carriedIntent already stashes the original message for the router; reuse it here.
    const lastRouted = carriedIntent.get(sessionId);
    const lastRoutedFresh =
      lastRouted && Date.now() - lastRouted.ts <= INTENT_CARRY_TTL_MS ? lastRouted.goal : undefined;
    const activeWorkGoal = activeWorkGoalForSession(sessionId);
    const resolved = resolveJudgeGoal(
      bus?.carriedExploreGoal,
      userMessage,
      resumedFromAuth,
      lastRoutedFresh,
      activeWorkGoal,
      turnDidExecute(records),
    );
    if (!resolved) {
      // Nothing recoverable: emit no verdict rather than a meaningless one. A skipped sample is honest;
      // a could_not_verify about the word "ok" is noise that looks like data.
      console.log(`[learning-judge] shadow session=${safeSessionId(sessionId)} skipped (auth resume, original goal not recoverable)`);
      return;
    }
    const goal = resolved;
    const trace: JudgeToolRecord[] = records.map((r) => ({
      toolName: r.toolName,
      ok: r.success,
      summary: (r.resultText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    }));
    const claim = lastAssistantText(messages as unknown as NativeMessage[]).slice(0, 1000);
    void judgeRun({
      goal,
      trace,
      assistantClaim: claim,
      honestyFired: bus?.honesty !== undefined,
    })
      .then((v) => {
        console.log(
          `[learning-judge] shadow session=${safeSessionId(sessionId)} verdict=${v.outcome} basis=${v.basis} "${v.evidence}"`,
        );
        // ...and count it, so "0 verified out of 12" is a number something can read rather than one a
        // human has to tally off a pasted log. Twice, deliberately: in-memory for the rolling /autonomy
        // window, and day-keyed in the metrics store so the daily self-check still sees the day's verdicts
        // after a restart — the boot-time check runs 8s in, when every in-memory window is empty.
        recordJudgeVerdict(v.outcome);
        try {
          const ymd = utcDateString(Date.now());
          memory.metrics.increment(`judge.day.total.${ymd}`);
          if (v.outcome === 'success') memory.metrics.increment(`judge.day.verified.${ymd}`);
          // Counted separately, not skipped: `judge.day.total` stays the raw count of verdicts so the
          // learning-stats dump keeps its meaning, and the daily report subtracts this to get the turns
          // that actually had a checkable goal. A turn whose goal was "继续" was never a learning sample.
          if (v.outcome === 'not_applicable') memory.metrics.increment(`judge.day.na.${ymd}`);
        } catch { /* counting must never affect the turn */ }
        // Carry an unconfirmed goal into the next run's outcome row (see JUDGE_GOAL_UNMET_SIGNATURE).
        // The judge stays shadow-only: this changes no control flow, it only makes a recurring
        // "goal not met" visible to the same detector that already watches for recurring blocks.
        const scheduleId = extractScheduleIdFromSession(sessionId);
        if (!scheduleId) return;
        if (v.outcome === 'failure' || v.outcome === 'could_not_verify') {
          lastJudgeGoalUnmet.set(scheduleId, (v.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 240));
        } else {
          lastJudgeGoalUnmet.delete(scheduleId); // a confirmed run breaks the streak
        }
      })
      .catch(() => {});
  } catch {
    // Shadow must never affect the turn.
  }
}

export async function handleChatSend(
  sessionId: string,
  userMessage: string,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  /**
   * 2026-05-07 addition: intermediate progress status push (optional). Unlike onDelta —
   * onDelta is the LLM's final reply token stream (channels typically buffer until turn end),
   * onStatus is an instantaneous "what the agent is doing right now" event (should be pushed
   * immediately to reduce user wait anxiety).
   *
   * After 2026-05-19 three-stream separation: onStatus content is unified as semantic progress
   * phrases ("searching the web…"); no longer contains tool names / internal counts.
   *
   * Channel implementations include their own throttling logic (same tool not re-pushed within
   * 5s on the same channel, etc.). Not provided = no intermediate status pushed (backward-compatible).
   */
  onStatus?: (text: string) => void,
  /**
   * 2026-05-19 three-stream separation addition: Tier 3/4 detail events (optional).
   * Tool invocation/result details + internal-drive gate / system events / auth ack / turn degradation markers.
   * Not passed for WeChat (naturally shielded); passed for web-ui → debug panel.
   */
  onTrace?: TraceFn,
  /** Channel metadata about when the user actually sent this message (not when polling delivered it). */
  inbound?: { sentAtMs?: number },
) {
  // ALS wraps the entire turn body — lets channel-aware tools (e.g. replyWithMedia)
  // retrieve the current sid from currentSessionId(); the registry routes to the corresponding
  // channel's peer based on that sid. All existing handleChatSendInner / runToolLoop paths
  // run inside this scope, so sid does not need to be passed individually.
  return runInTurnContext(sessionId, async () => {
  const audit = new AuditLog();

  // Observe the language the user actually writes in and persist it (`user.locale`). This is what lets a
  // PROACTIVE push — a turn with no user message at all, nothing to mirror — still reach them in their own
  // language, without guessing it from the channel they happen to use.
  refreshUserLanguage(userMessage);

  // First time seeing this ws sid → run orphan scan + register active session for finalize tracking
  if (!activeSessions.has(sessionId)) {
    await scanOrphanSessions();
    activeSessions.add(sessionId);
    sessionSkillsRevision.set(sessionId, skillsRevision);
  }

  // WS6 (selfhood_closure): first-contact auto-subscribe for push-capable DM channels. Without a
  // subscription row the PushDispatcher drops every digest/urgent push, so the proactive layer was
  // silent by default. One store SELECT per session (in-memory guard); notice delivered via
  // onStatus in the same turn, so we only act when the channel can show it.
  if (onStatus && !autoSubscribeCheckedSessions.has(sessionId)) {
    autoSubscribeCheckedSessions.add(sessionId);
    try {
      const notice = maybeAutoSubscribe(
        memory.pushSubscriptions,
        sessionId,
        process.env,
        resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }),
      );
      if (notice) onStatus(notice);
    } catch (e) {
      console.warn('[push] first-contact auto-subscribe failed', e);
    }
  }

  // The OFF-SWITCH we promised. The auto-subscribe notice tells the owner "reply 取消推送 to turn it off at
  // any time" — and until 2026-07-14 NOTHING matched that phrase, while PushSubscriptionStore.unsubscribe(),
  // sitting right there in the store, had ZERO callers anywhere in the server. We opt people IN
  // automatically on first contact, tell them how to opt out, and did not listen. There was no way for a
  // person to make us stop messaging them through the channel we told them to use — and the web-ui gate fix
  // in this same release is what makes those pushes actually start flowing. Handled deterministically here,
  // BEFORE the model, because an off-switch that depends on the model noticing is not an off-switch.
  {
    const ctl = classifyPushControlReply(userMessage);
    if (ctl) {
      const lang = resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() });
      const dm = parseDmPeerFromSessionId(sessionId);
      let reply: string;
      if (!dm) {
        reply =
          lang === 'en'
            ? 'This chat does not receive proactive messages, so there is nothing to change.'
            : '这个对话不接收主动消息,无需改动。';
      } else if (ctl === 'unsubscribe') {
        let ok = false;
        try {
          ok = memory.pushSubscriptions.unsubscribe(dm.channel, dm.peer);
        } catch (e) {
          console.warn('[push] unsubscribe failed', e);
        }
        console.log(`[push] owner asked to STOP pushes (session=${safeSessionId(sessionId)}) → unsubscribed=${ok}`);
        reply = ok
          ? lang === 'en'
            ? 'Done — proactive messages are off. I will not message you unprompted again. Reply "resume pushing" if you ever want them back.'
            : '好的,主动消息已关闭。我不会再主动给你发消息了。想恢复的话回复"恢复推送"。'
          : lang === 'en'
            ? 'Proactive messages were already off for this chat — nothing to turn off.'
            : '这个对话本来就没开主动消息,无需关闭。';
      } else {
        try {
          memory.pushSubscriptions.subscribe({ channel: dm.channel, peer: dm.peer });
        } catch (e) {
          console.warn('[push] resubscribe failed', e);
        }
        console.log(`[push] owner asked to RESUME pushes (session=${safeSessionId(sessionId)})`);
        reply =
          lang === 'en'
            ? 'Proactive messages are back on. Reply "stop pushing" to turn them off again.'
            : '主动消息已恢复。想再关掉的话回复"取消推送"。';
      }
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: 0 };
    }
  }

  // deep_explore session control — the words the follow-up / auto-advance cards printed. 放弃 / 全清 /
  // 自动推进 / 停 had NO listener anywhere: the phrases existed only in the cards that printed them, while
  // the verbs they name (setSessionStatus('abandoned'), setAutoAdvance) sat fully built and unplumbed.
  // Handled here, before the model, so the exact words we PRINTED always work. 继续 is deliberately left to
  // the existing force-continue path — it already works, and a second owner of it is pure regression risk.
  //
  // HIJACK GUARD. This runs before the model on EVERY turn, and 停 / 放弃 / stop are ordinary words a person
  // says for ordinary reasons ("stop what you're doing", "give up on that idea"). So a match is NOT enough:
  // the world must also be in the state the card described. No open exploration → this was never about an
  // exploration → fall through to the model SILENTLY, do not answer.
  //
  // 2026-07-15: "停/暂停" applies to ANY open exploration, auto-advancing OR manual. It used to require an
  // auto-advancing session; production showed a user say "暂停" to a MANUAL deep_explore, which fell through
  // to the model — which then ran a whole 400s round and fabricated a citation instead of pausing. If there
  // is an open exploration and the owner says stop, pause it deterministically and acknowledge; nothing
  // advances a manual session until "继续" anyway, so "pausing" it is just an honest acknowledgment + the
  // resume word.
  {
    const ec = classifyExploreControlReply(userMessage);
    const openSessions = ec ? memory.reasoning.listActiveSessions(sessionId) : [];
    const autoOn = openSessions.filter((x) => x.autoAdvance);
    const applies = !!ec && openSessions.length > 0;

    if (ec && applies) {
      const lang = resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() });
      const en = lang === 'en';
      const focus = memory.reasoning.getMostRecentActiveSession(sessionId) ?? openSessions[0];
      let reply: string;

      if (ec.kind === 'stop_auto') {
        // Turn off any auto-advance, and acknowledge the pause for manual sessions too (they were never
        // going to advance without "继续", so this is an honest ack, not a state change).
        for (const x of autoOn) memory.reasoning.setAutoAdvance(x.id, false);
        console.log(
          `[explore-control] owner paused exploration (auto-off ${autoOn.length} of ${openSessions.length} open)`,
        );
        reply = en
          ? `Paused. I won't advance ${openSessions.length > 1 ? 'them' : 'it'} on my own — reply "continue" to resume, or "abandon" to archive.`
          : `好的,已暂停。我不会自己往下推了——想继续回"继续",想归档回"放弃"。`;
      } else if (ec.kind === 'auto_advance') {
        deepExploreAutoAdvance.rearm(focus.id);
        console.log(`[explore-control] owner granted another batch to ${focus.id}`);
        reply = en
          ? `Another batch granted — I will keep advancing "${focus.goal.slice(0, 40)}" in the background. Reply "stop" to pause.`
          : `好的,再给「${focus.goal.slice(0, 40)}」加一批,我在后台接着推进。想停回"停"。`;
      } else if (ec.kind === 'abandon_all') {
        for (const x of openSessions) memory.reasoning.setSessionStatus(x.id, 'abandoned');
        console.log(`[explore-control] owner abandoned ALL ${openSessions.length} session(s)`);
        reply = en
          ? `Archived all ${openSessions.length} open exploration(s).`
          : `已归档全部 ${openSessions.length} 个探索。`;
      } else {
        const hit = resolveExploreTarget(openSessions, ec.target, focus);
        if (hit && 'session' in hit) {
          memory.reasoning.setSessionStatus(hit.session.id, 'abandoned');
          console.log(`[explore-control] owner abandoned ${hit.session.id}`);
          reply = en
            ? `Archived "${hit.session.goal.slice(0, 50)}". Say the word and I will reopen it.`
            : `已归档「${hit.session.goal.slice(0, 50)}」。要的话随时说一声,我给你重开。`;
        } else if (hit && 'ambiguous' in hit) {
          // Never guess: silently archiving the WRONG line of reasoning is far worse than asking again.
          const list = hit.ambiguous.map((x) => `「${x.goal.slice(0, 40)}」`).join(' / ');
          reply = en
            ? `That matches more than one exploration (${list}) — which one?`
            : `匹配到不止一个探索(${list})——是哪个?`;
        } else {
          const list = openSessions.map((x) => `「${x.goal.slice(0, 40)}」`).join(' / ');
          reply = en
            ? `No open exploration matches that. Currently open: ${list}`
            : `没有匹配的探索。当前开着的:${list}`;
        }
      }
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: 0 };
    }
  }

  // '/autonomy' status command (WS6 §8): answered straight from the stores, zero LLM calls —
  // works identically on WeChat / Telegram / web-ui / CLI. Not recorded to the timeline (it is
  // telemetry about the agent, not conversation).
  if (isAutonomyStatusCommand(userMessage)) {
    try {
      onDelta(
        renderSelfhoodStatusText(
          autonomySelfhoodStatus(),
          Date.now(),
          resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }),
        ),
      );
    } catch (e) {
      console.error('[autonomy] status command failed', e);
      onDelta('autonomy status unavailable: ' + (e as Error).message);
    }
    return { outcome: { outcomeType: 'response' }, auditEvents: 0 };
  }

  // The owner answering the /autonomy panel's amendment card. Handled HERE, deterministically, rather than
  // hoping the model notices and calls decide_constitution_proposal: nothing in the repo matched these words
  // at all until 2026-07-14, and the model could not have supplied the id anyway — the panel prints 8 chars
  // and the store did exact-id lookup. An owner following our own printed instructions could never approve a
  // constitution amendment. We printed the words; we listen for them.
  {
    const pr = classifyProposalReply(userMessage);
    if (pr) {
      const lang = resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() });
      let reply: string;
      try {
        if (pr.decision === 'approve') {
          const applied = approveAndApply(
            constitutionProposals,
            memory.pursuits,
            pr.idPrefix,
            internalAudit,
          );
          reply =
            lang === 'en'
              ? `Constitution amended per proposal ${applied.id.slice(0, 8)} (${applied.kind}). Append-only and hash-audited.`
              : `已按提案 ${applied.id.slice(0, 8)} (${applied.kind}) 修正宪法。修正是只追加、带哈希审计的。`;
        } else {
          const rejected = constitutionProposals.decide(pr.idPrefix, 'rejected');
          reply = rejected
            ? lang === 'en'
              ? `Proposal ${rejected.id.slice(0, 8)} rejected. I will not amend the constitution.`
              : `已拒绝提案 ${rejected.id.slice(0, 8)}。宪法不作修改。`
            : lang === 'en'
              ? `No pending proposal matches "${pr.idPrefix}" (it may be ambiguous or already decided). Run /autonomy to see the open ones.`
              : `没有匹配「${pr.idPrefix}」的待决提案(可能不唯一或已决定)。发 /autonomy 看当前待决列表。`;
        }
      } catch (e) {
        reply =
          lang === 'en'
            ? `Could not apply that decision: ${(e as Error).message}`
            : `无法执行该决定: ${(e as Error).message}`;
      }
      console.log(`[autonomy] proposal ${pr.decision} via owner reply (prefix=${pr.idPrefix})`);
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: 0 };
    }
  }
  const grants = globalGrants;

  // 2026-05-06 D.2: turn-local signal container created in the outer layer; the drain path
  // inside buildFreshMessages / buildMemoryPrefix writes interruptDrainedCount into it,
  // and the inner honesty / K7-bridge paths also write to it. Inner finally block consumes all at once.
  const signalBus: TurnSignalBus = { inboundSentAtMs: inbound?.sentAtMs };

  // v19 (2026-05-13): plan_close close-time strict validation needs to read the current turn's
  // signalBus (honesty fired? sameRootCause?) at the instant the LLM calls the plan_close tool.
  // createPlanTools is one-time at module load and cannot capture a per-turn bus — use a
  // session→bus map + currentSessionId() to look it up on demand inside tool execute.
  activeSignalBuses.set(sessionId, signalBus);
  // Per-turn latch: a tail that was incompressible last turn may be compressible now (the huge
  // tool_results have since been evicted / the turn's messages are rebuilt). Re-arm each turn.
  incompressibleTurns.delete(sessionId);

  // ── WHO IS THIS REPLY FOR ────────────────────────────────────────────────────────────────────
  //
  // Resolved once, here, before any module reads its own map. Four kinds of card used to be consulted
  // in a fixed code order — deep-explore ask, tool authorization, research, question — so a reply went
  // to whichever came first in this file rather than to the card the owner was looking at. A "同意"
  // typed at a research card could approve a `git push` asked later.
  //
  // At most one decision comes out of one message. When the address is not determined nothing is
  // consumed at all: the cards stay up and the owner is asked which they meant. Guessing here does
  // not mislabel — it spends the answer on the wrong authorization and strands the other request.
  const outstandingDecisions = pendingDecisions.list(sessionId);
  // A server-queued message cannot answer a decision card created after the owner sent it. Keep the
  // newer card outstanding, but exclude it from routing this inbound as an answer. Generic decisions
  // currently have no channel delivery receipt, so createdAt is intentionally a conservative lower
  // bound rather than pretending it is deliveredAt. Effectful research tools additionally require an
  // explicit quoted/card address, which an unseen card cannot supply.
  const addressableDecisions = signalBus.inboundSentAtMs === undefined
    ? outstandingDecisions
    : outstandingDecisions.filter((d) => d.createdAt <= signalBus.inboundSentAtMs!);
  if (addressableDecisions.length !== outstandingDecisions.length) {
    memory.metrics.increment('pending.decision_predates_card');
    console.warn(
      `[pending] session=${safeSessionId(sessionId)} inbound predates ` +
        `${outstandingDecisions.length - addressableDecisions.length} decision card(s); treating it as a normal request`,
    );
  }
  // "待办" — the owner asking to see what is waiting. Rendering the list also snapshots it, which is
  // what makes the numbers in the next reply mean these items and not whatever arrives meanwhile.
  if (/^\s*(待办|待办事项|pending|todo)\s*$/i.test(userMessage)) {
    const lang: 'zh' | 'en' =
      resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }) === 'en' ? 'en' : 'zh';
    if (outstandingDecisions.length === 0) {
      onDelta(lang === 'en' ? 'Nothing is waiting on you.' : '没有等你决定的事。');
    } else {
      pendingDecisions.snapshot(sessionId, outstandingDecisions);
      const lines = outstandingDecisions
        .map((d, i) => `${i + 1}. ${d.title}${d.detail ? `\n   ${d.detail}` : ''}`)
        .join('\n');
      onDelta(
        lang === 'en'
          ? `Waiting on you:\n${lines}\n\nReply "1 yes" / "2 no", or quote the card you mean.`
          : `等你决定的有：\n${lines}\n\n回复「1 同意」或「2 拒绝」，也可以直接引用对应卡片回复。`,
      );
    }
    return { outcome: { outcomeType: 'response' }, auditEvents: 0 };
  }
  const decisionLang: 'zh' | 'en' =
    resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }) === 'en' ? 'en' : 'zh';
  let resolvedDecision: { decision: PendingDecision; verdictText: string } | null = null;
  if (addressableDecisions.length > 0) {
    const { quoted, reply } = splitQuotedReply(userMessage);
    const routed = routeReply(reply || userMessage, addressableDecisions, {
      now: Date.now(),
      quotedText: quoted,
      snapshot: pendingDecisions.lastSnapshot(sessionId),
    });

    if (routed.kind === 'ambiguous' || routed.kind === 'needs-address') {
      const shown = routed.kind === 'ambiguous' ? routed.candidates : [routed.decision];
      pendingDecisions.snapshot(sessionId, shown);
      const text =
        routed.kind === 'ambiguous'
          ? renderAmbiguityPrompt(shown, decisionLang)
          : renderNeedsAddressPrompt(routed.decision, decisionLang);
      console.log(
        `[pending] session=${safeSessionId(sessionId)} ${routed.kind}: ` +
          `${shown.length} outstanding, nothing consumed`,
      );
      onDelta(text);
      return { outcome: { outcomeType: 'question_pending' }, auditEvents: 0 };
    }

    if (routed.kind === 'addressed') {
      const decision = outstandingDecisions.find((d) => d.id === routed.id)!;
      if (needsVerdict(decision, routed.verdictText)) {
        // Which one was answered; whether they agree was not. Pointing is not agreeing.
        pendingDecisions.snapshot(sessionId, [decision]);
        onDelta(renderVerdictPrompt(decision, decisionLang));
        return { outcome: { outcomeType: 'question_pending' }, auditEvents: 0 };
      }
      // Addressed. Whether anything HAPPENS is the owning module's to report — see auditDecisionApplied.
      resolvedDecision = { decision, verdictText: routed.verdictText };
      signalBus.resolvedDecisionId = decision.id;
      signalBus.resolvedVerdictText = routed.verdictText;
      auditDecisionAddressed(sessionId, decision, routed.how, routed.verdictText);
    }
  }

  // Ask-tier deep_explore routing: resolved only when the address above says this message is for it.
  // 进/好/yes → restore the original goal and force the engine; 直接/不/no → restore the goal and run
  // flat; anything else → this is a new message, and the offer STAYS (it used to be deleted before the
  // reply was even read, so "帮我看下日志" silently discarded a question the owner had been asked).
  {
    const exploreAsk = pendingExploreAsk.get(sessionId);
    const addressedToAsk =
      exploreAsk?.decisionId !== undefined &&
      resolvedDecision?.decision.id === exploreAsk.decisionId;
    if (exploreAsk && addressedToAsk) {
      if (Date.now() - exploreAsk.ts > EXPLORE_ASK_TTL_MS) {
        pendingExploreAsk.delete(sessionId);
        pendingDecisions.resolve(sessionId, exploreAsk.decisionId!);
        auditDecisionApplied(sessionId, exploreAsk.decisionId!, 'expired', 'ask-tier offer timed out');
      } else {
        const askVerdictText = signalBus.resolvedVerdictText ?? userMessage;
        // Match the vocabulary the ask itself offered ("进" / "直接") BEFORE consulting the generic
        // authorisation classifier — that classifier only knows "did the user authorise?", so it read
        // our own DENY word 直接 as assent and logged ask-tier APPROVED on an explicit refusal
        // (prod 2026-07-13). See classifyExploreAskReply.
        const askIntent =
          classifyExploreAskReply(askVerdictText) ??
          (await classifyAuthIntent(
            askVerdictText,
            'Enter the deep reasoning engine (deep_explore) for the research goal just proposed',
          ));
        if (askIntent === 'grant' || askIntent === 'auto') {
          pendingExploreAsk.delete(sessionId);
          pendingDecisions.resolve(sessionId, exploreAsk.decisionId!);
          signalBus.exploreAskApproved = true;
          signalBus.exploreAskAuto = askIntent === 'auto';
          signalBus.intentDecision = exploreAsk.decision;
          userMessage = exploreAsk.goal;
          auditDecisionApplied(sessionId, exploreAsk.decisionId!, 'granted', 'deep_explore entry');
          console.log(`[intent-router] session=${safeSessionId(sessionId)} ask-tier APPROVED → deep_explore on restored goal`);
        } else if (askIntent === 'deny') {
          pendingExploreAsk.delete(sessionId);
          pendingDecisions.resolve(sessionId, exploreAsk.decisionId!);
          signalBus.exploreAskDeclined = true;
          signalBus.intentDecision = exploreAsk.decision;
          userMessage = exploreAsk.goal;
          auditDecisionApplied(sessionId, exploreAsk.decisionId!, 'denied', 'flat run instead');
          console.log(`[intent-router] session=${safeSessionId(sessionId)} ask-tier declined → flat run on restored goal`);
        } else {
          // ONLY A VERDICT CONSUMES. Naming the card is not answering it: "d3 这是什么意思？" is
          // addressed, has a non-empty verdict text, and means nothing terminal — and it used to
          // destroy the offer, because the delete ran at the top of this branch before anything had
          // been read. That narrowed the original bug (any message destroyed the ask) instead of
          // ending it. The offer stands, the message runs as an ordinary turn that can answer the
          // question, and the tail reminds them it is still waiting.
          console.log(
            `[intent-router] session=${safeSessionId(sessionId)} ask-tier addressed without a verdict → offer stands`,
          );
        }
      }
    }
  }

  // Interrupt teeth: one new AbortController per turn. ws `chat.stop` fires abortActiveTurn
  // to trigger it, canceling in-flight LLM calls + letting runToolLoop stop early at a boundary. Deleted in finally.
  activeTurnAborters.set(sessionId, new AbortController());

  // K0: rebuild messages fresh each turn — prefer the inflight saved in pending-auth /
  // pending-question state (those carry tool_use that must have matching tool_result to resume),
  // otherwise recall from the global timeline.
  let intentDecision: IntentDecision | null = null;
  // EXPIRY IS DECIDED BEFORE THE CONTEXT IS BUILT, NOT AFTER.
  //
  // handleChatSendInner also checks this TTL — but by the time it runs, `messages` below has already
  // been seeded from pending.inflightMessages. On an expired pending that branch does NOT resume: it
  // drops the pending and falls through to a normal turn, leaving the suspended assistant tool_use
  // blocks in the message array with no tool_result behind them. The adapter then repairs the pairing
  // to avoid a 400, and the model gets a turn whose recent history has holes in it.
  //
  // Production 2026-08-09 shows the correlation with nothing else in it. `[llm-adapter] tool_result
  // pairing repair: missing=2` appears exactly twice, at 09:09:46 and 12:43:29 — the only two resumes
  // that arrived after the TTL (58 min and 35.6 min). Every resume inside the window (8.6, 8.2, 0.5,
  // 0.2 min …) is clean. And `missing=2` is literally the count of what was suspended: the paused call
  // plus one queued sibling. The first of those two turns then read five files, spent 224s in the model
  // and emitted `writeFile({})` — a call with no arguments at all, which cost the owner another nine
  // minutes before it failed. Required-field validation now blocks that call, but this is where the
  // damaged context it was generated from comes from.
  //
  // `running` / `uncertain` are exempt: those describe a call that may already have touched the world,
  // and their inflight messages are what the retry/skip decision resumes into. Age must not decide them.
  //
  // The choice of message source is made by selectTurnContextSource, which re-derives staleness
  // itself, so the guarantee does not rest on this block running before the build below. If the two
  // are ever separated again, the selector still refuses a stale pending's inflight.
  const authAtTurnStart = pendingAuth.get(sessionId);
  const authInboundDisposition = pendingAuthInboundDisposition(authAtTurnStart, signalBus.inboundSentAtMs);
  signalBus.authInboundDisposition = authInboundDisposition;
  const questionAtTurnStart = pendingQuestion.get(sessionId);
  const bypassQuestion = questionAtTurnStart !== undefined &&
    signalBus.inboundSentAtMs !== undefined && signalBus.inboundSentAtMs < questionAtTurnStart.createdAt;
  signalBus.bypassPendingQuestion = bypassQuestion;
  const turnContext = selectTurnContextSource(
    authAtTurnStart,
    questionAtTurnStart,
    Date.now(),
    authInboundDisposition !== 'resume',
    bypassQuestion,
  );
  {
    const stale = pendingAuth.get(sessionId);
    if (stale && turnContext.dropAuth) {
      pendingAuth.delete(sessionId);
      persistContinuation(sessionId);
      signalBus.droppedExpiredAuth = {
        toolName: stale.toolName,
        ageMinutes: Math.round((Date.now() - (stale.deliveredAt ?? stale.ts)) / 60_000),
      };
      console.log(
        `[continuation] session=${safeSessionId(sessionId)} dropped expired pending auth for ${stale.toolName} ` +
          `(age=${signalBus.droppedExpiredAuth.ageMinutes}m > ${Math.round(PENDING_AUTH_TTL_MS / 60_000)}m) → fresh context`,
      );
      onTrace?.({
        kind: 'system-event', tier: 4,
        text: `Authorization request for ${stale.toolName} expired (${signalBus.droppedExpiredAuth.ageMinutes} min); handling this message as a new turn`,
      });
    }
  }
  const pending = pendingAuth.get(sessionId);
  const pendingQ = pendingQuestion.get(sessionId);
  if (pendingQ?.goal) {
    const carried = carriedIntent.get(sessionId);
    signalBus.carriedExploreGoal = pendingQ.goal;
    carriedIntent.set(sessionId, {
      decision: carried?.decision ?? null,
      selfReferentialMeta: carried?.selfReferentialMeta ?? false,
      goal: pendingQ.goal,
      ts: Date.now(),
    });
  }
  if (pending) {
    const carried = carriedIntent.get(sessionId);
    const pendingGoal = pending.goal || carried?.goal || userMessage;
    signalBus.carriedExploreGoal = pendingGoal;
    carriedIntent.set(sessionId, {
      decision: carried?.decision ?? null,
      selfReferentialMeta: carried?.selfReferentialMeta ?? false,
      goal: pendingGoal,
      ts: Date.now(),
    });
    intentDecision = carried?.decision ?? null;
    signalBus.intentDecision = carried?.decision ?? null;
    signalBus.selfReferentialMeta = carried?.selfReferentialMeta ?? false;
    if (carried?.decision) {
      console.log(
        `[intent-router] session=${safeSessionId(sessionId)} auth-resume: carried route=${carried.decision.route} conf=${carried.decision.confidence} (router skipped on resume)`,
      );
    }
  }

  // 2026-05-12 Phase 7 hardened 1: automatic task mode classifier.
  // Evaluated before buildFreshMessages so that the "task mode self-assessment" section
  // inside buildMemoryPrefix sees the correct mode (slow → renders "plan not yet created, call plan_draft now").
  //
  // Skip conditions:
  //   - pending / pendingQ: mid-turn resume, not a new task entry point
  //   - already slow: do not re-classify (keep what the LLM explicitly set)
  //   - PHILONT_AUTO_TASK_MODE=0: disabled by env
  //
  // Misclassify fast→slow = soft cost (turn runs longer); misclassify slow→fast = impossible (one-directional).
  // intentDecision (aux-LLM 3-way router) is computed in the same gate and survives to the messages[0]
  // injection below, where a deep_explore route adds its nudge. plan route reuses this slow→plan path.
  // Per-task re-classification (2026-07-01): the classifier + auto-plan-on-slow used to run ONLY on the first
  // fast→slow transition. But taskModeStore is sticky-slow, so once a session went slow a genuine multi-step
  // task arriving later (prod: mycox "read guide then register") skipped classification entirely and got NO
  // placeholder plan → no checklist → guide MUST-items silently dropped. Worsened by terminalPlanClosedThisTurn,
  // which correctly stops a stale failed placeholder from downgrading to fast, so the session stays STUCK slow
  // with the classifier permanently skipped. Fix: also re-enter at a clean TASK BOUNDARY — mode is slow but the
  // last plan is terminal (completed/failed) or absent (previous task done, a new one starting).
  const modeAtEntry = taskModeStore.get(sessionId);
  let planEntryAllowsReclassify = false;
  if (modeAtEntry === 'slow') {
    try {
      const lp = memory.plans.listBySession(sessionId, { limit: 1 })[0];
      planEntryAllowsReclassify = slowSessionAtTaskBoundary(lp?.status);
    } catch {
      /* plan lookup failure → keep the old fast-only behavior (no re-classification) */
    }
  }
  if (
    process.env.PHILONT_AUTO_TASK_MODE !== '0' &&
    !pending &&
    !pendingQ &&
    (modeAtEntry === 'fast' || planEntryAllowsReclassify) &&
    !classifierSkipPatterns.some((p) => sessionId.startsWith(p))  // Phase 8 M2: DB can add skip patterns
  ) {
    const sig = quickTaskSignatureHash(userMessage);
    const cls = autoClassifyTaskMode({
      userMessage,
      taskSignatureCandidate: sig,
      plans: memory.plans,
    });
    // Aux-LLM 3-way router: returns null when disabled / unconfigured / trivial / aux fails → behavior is
    // exactly today's. plan with enough confidence joins the existing slow→plan path; deep_explore is
    // applied as a system-prefix nudge once messages[0] exists.
    intentDecision = await classifyIntent(userMessage);
    signalBus.intentDecision = intentDecision; // carried to handleChatSendInner for the deep_explore nudge
    signalBus.selfReferentialMeta = isSelfReferentialMetaQuestion(userMessage);
    // Stash for a possible pending-auth resume: if the model reaches for an execute tool before it ever
    // answers flat, this turn ends in auth_pending and the resumed turn re-enters with userMessage="ok"
    // and the router skipped. Without this the route (and the real goal) are lost. See carriedIntent.
    // A CONTINUATION WORD MUST NOT ERASE THE GOAL IT IS CONTINUING.
    //
    // This map is the only surviving record of what a session is working on once an auth card splits a
    // task across turns, and it was overwritten by every fresh turn — including "同意", "ok", "B". Then
    // resolveJudgeGoal correctly refuses those as goals (a 12-character floor), and the learning judge
    // skips. Prod 2026-07-28: "同意" at 14:49:42 replaced the real goal, and the two turns that followed
    // — 65s and 453s of real work, 19 tool calls, pariGp and z3Verify — were both logged
    // `skipped (auth resume, original goal not recoverable)`. The judge is blind on precisely the turns
    // that carry the most evidence, which is the reason the daily report keeps reading 9 轮 1 轮.
    //
    // `messageIsSelfContainedGoal` is the same predicate force-start already uses to decide whether a
    // message stands on its own. The DECISION is still overwritten every turn: a stale route must never
    // force-start a later unrelated turn, and with decision=null force-start cannot fire at all — so
    // keeping the goal alone is the safe half to keep.
    const priorCarried = carriedIntent.get(sessionId);
    carriedIntent.set(sessionId, {
      decision: intentDecision,
      selfReferentialMeta: !!signalBus.selfReferentialMeta,
      goal: messageIsSelfContainedGoal(userMessage) ? userMessage : (priorCarried?.goal ?? userMessage),
      ts: Date.now(),
    });
    if (intentDecision) {
      console.log(`[intent-router] session=${safeSessionId(sessionId)} route=${intentDecision.route}${intentDecision.domain ? `:${intentDecision.domain}` : ''} conf=${intentDecision.confidence}`);
      // Three-tier deep_explore routing, ASK tier: mid-confidence reasoning task → one question,
      // zero LLM turn cost; the next reply decides (grant → force engine, deny → flat). Only for
      // interactive sessions with a self-contained goal and no recently-active session.
      const askTier =
        deepExploreRouteTier(intentDecision) === 'ask' &&
        !isSelfReferentialMetaQuestion(userMessage) &&
        !sessionId.startsWith('system:') &&
        !signalBus.exploreAskApproved &&
        !signalBus.exploreAskDeclined &&
        messageIsSelfContainedGoal(userMessage) &&
        !hasRecentlyActiveExploreSession(sessionId);
      if (askTier) {
        const askDecisionId = `d${Math.random().toString(36).slice(2, 6)}`;
        pendingExploreAsk.set(sessionId, {
          goal: userMessage,
          decision: intentDecision,
          ts: Date.now(),
          decisionId: askDecisionId,
        });
        pendingDecisions.add(sessionId, {
          id: askDecisionId,
          kind: 'deep_explore_entry',
          // The offered words are its own: 1/2 answer THIS card, and only a freshly shown list turns
          // numbers into positions instead. A routing choice costs a round if misread, so a bare
          // reply may settle it when it is the only thing outstanding.
          title: `要为「${userMessage.slice(0, 24)}」进入深度推理吗`,
          offered: ['1', '2', '进', '进入', '深入', '深度推理', '直接', '平铺', '快速', '不用'],
          resolutionPolicy: 'unique_bare_reply_allowed',
          createdAt: Date.now(),
          expiresAt: Date.now() + EXPLORE_ASK_TTL_MS,
        });
        onDelta(buildDeepExploreAskText(intentDecision));
        console.log(`[intent-router] session=${safeSessionId(sessionId)} ask-tier question sent (conf=${intentDecision.confidence})`);
        return { outcome: { outcomeType: 'question_pending' }, auditEvents: 0 };
      }
    }

  // Cleanup-turn scoping: (1) flag the turn so runToolLoop rejects external write http (clear
    // turns drifted into re-registering the service being cleared); (2) soft-pause schedules that
    // mention the cleanup target so a scheduled check-in can't fire mid-clear and resurrect the
    // half-deleted state (prod: check-in raced the clear three runs in a row).
    if (looksLikeCleanupIntent(userMessage)) {
      const targets = extractCleanupTargets(userMessage);
      signalBus.cleanupIntent = { targets };
      // Wiping a direction's state is the strongest possible fresh-start signal, so it anchors a new episode.
      // same_root_cause is a GLOBAL 24h ledger by design (it has to span deep_explore into raw shell
      // grinding), and the existing doom-reset only fires once doom has accumulated in THIS session — so a
      // brand-new session's FIRST turn is judged on a previous day's failures with nothing to bound it.
      // Prod 2026-07-21: a clear ran 18 tools with zero failures and still fired stop_and_report, telling the
      // owner "11 same-root failures accumulated", every one of them from the night before — and caused by a
      // race that had since been fixed. Whatever those failures were about, they were against state the user
      // has just deleted; the next attempt deserves to be judged on its own.
      episodeAnchorTs.set(sessionId, Date.now());
      if (targets.length > 0) {
        try {
          const until = Date.now() + CLEANUP_SCHEDULE_PAUSE_MS;
          const paused: string[] = [];
          const aborted: string[] = [];
          for (const s of memory.schedules.list({ enabledOnly: true })) {
            if (!matchesCleanupTarget(s, targets)) continue;
            if (memory.schedules.pauseUntil(s.id, until)) paused.push(s.name);
            // Pausing only blocks FUTURE fires. A run already in flight keeps going and then has the very
            // resources it is using deleted out from under it: prod 2026-07-20, a check-in started 13s before
            // the clear, lost its credential mid-turn, and hammered `Unknown credential` 11 times into the
            // circuit breaker — a whole heartbeat wasted, caused by the mechanism itself.
            //
            // Aborting is the right reading of the request, not merely the convenient one: "clear this
            // service" means stop doing this service's work. Waiting for the run instead would leave it
            // posting and voting for the several minutes such a turn takes — actively producing more of what
            // is being cleared. The abort must also happen HERE, before the turn's deletions run.
            //
            // Scheduled turns are keyed by schedule NAME (see the autonomous_turn dispatch), not id; passing
            // an id would return false and silently do nothing.
            if (abortActiveTurn(`system:scheduled:${s.name}`)) aborted.push(s.name);
          }
          if (aborted.length > 0) {
            console.log(
              `[cleanup-scope] session=${safeSessionId(sessionId)} aborted ${aborted.length} in-flight scheduled run(s) ` +
                `before deleting: ${aborted.join(', ')}`,
            );
          }
          if (paused.length > 0) {
            console.log(
              `[cleanup-scope] session=${safeSessionId(sessionId)} paused ${paused.length} schedule(s) matching [${targets.join(',')}] ` +
                `for ${Math.round(CLEANUP_SCHEDULE_PAUSE_MS / 60000)}min: ${paused.join(', ')}`,
            );
            internalAudit.append('self_domain_write', {
              source: 'cleanup_scope',
              origin: 'Internal',
              toolName: 'schedules_paused',
              targets,
              paused,
              pauseMs: CLEANUP_SCHEDULE_PAUSE_MS,
            });
          }
        } catch (e) {
          console.warn('[cleanup-scope] schedule pause failed (ignored)', e);
        }
      }
    }
    // A deep_explore route is AUTHORITATIVE: do NOT let the legacy slow heuristic upgrade it to the plan
    // protocol (observed: "深度探索…技术栈和解决方案" routed deep_explore:0.95 but the heuristic's 建设/生产
    // keywords forced slow→plan_draft, hijacking the reasoning task into the build pipeline). Reasoning tasks
    // go to deep_explore (via the nudge below); only plan/direct routes (or no router) keep the heuristic.
    const intentSaysExplore = intentDecision?.route === 'deep_explore';
    // A confident `direct` route (esp. the cleanup/cancel short-circuit) overrides the keyword
    // classifier's slow verdict — a bare deletion must not be dragged into the placeholder-plan path.
    const intentSaysDirect = directRouteWantsFast(intentDecision);
    if (!intentSaysExplore && !intentSaysDirect && (cls.isSlow || planRouteWantsSlow(intentDecision))) {
      taskModeStore.set(
        sessionId,
        'slow',
        cls.isSlow
          ? `auto:heuristic:${cls.reasons.join(',')}`
          : `auto:intent:plan:${intentDecision?.confidence ?? ''}`,
      );
      audit.append('self_domain_write', {
        source: 'auto_task_mode',
        origin: 'Internal',
        toolName: 'task_mode_auto_slow',
        sessionId,
        reasons: cls.reasons,
        signatureCandidate: sig,
      });
      // When the heuristic list is empty the escalation came from the intent router — say so
      // (prod 2026-07-09 logged "fast→slow reasons=[]", which read like an unexplained switch).
      const reasonLabel = cls.reasons.length > 0
        ? cls.reasons.join(',')
        : `intent:plan:${intentDecision?.confidence ?? '?'}`;
      console.log(
        `[auto-task-mode] session=${safeSessionId(sessionId)} ${modeAtEntry}→slow reasons=[${reasonLabel}]` +
        (modeAtEntry === 'slow' ? ' (re-plan for new task at boundary)' : ''),
      );

      // 2026-05-12 Phase 8.5: **auto-create a placeholder plan** at the same time as upgrading to slow.
      // Production (mycox) revealed: after seeing a gate reject, the LLM chose to "try a different tool"
      // instead of calling plan_draft. Fix: **the mechanism layer pre-creates the plan template** so the
      // LLM enters the turn already seeing an existing plan and can only do plan_review/revise — no bypass.
      //
      // Disabled by env PHILONT_AUTO_PLAN_ON_SLOW=0.
      // Dedup: skip when there is already an active plan (draft/reviewed/executing).
      if (process.env.PHILONT_AUTO_PLAN_ON_SLOW !== '0') {
        try {
          const existingPlans = memory.plans.listBySession(sessionId, { limit: 1 });
          const last = existingPlans[0];
          // When the mechanism plan-loop will own this turn (flag on + route=plan + guide URL), do
          // NOT also create a placeholder — the loop drives the plan store itself (double machinery
          // would leave an orphan placeholder that auto-fails at turn end).
          const planLoopWillOwn =
            planLoopEnabled() &&
            intentDecision?.route === 'plan' &&
            /https?:\/\//.test(userMessage);
          const needsNewPlan =
            !planLoopWillOwn &&
            (!last ||
              last.status === 'completed' ||
              last.status === 'failed');
          if (needsNewPlan) {
            // Extract URL: using \S+ greedily includes trailing punctuation (",。;:'""<>()`)
            // causing a mismatch with the URL actually requested by webFetch → fetched-store findByUrl fails.
            // Fix: disallow these common punctuation characters inside the URL.
            const guideUrlRaw = userMessage.match(/https?:\/\/[^\s,;:'"<>()`，。；：、]+/)?.[0];
            // Strip trailing period once more (a URL at end of sentence may have a trailing "." causing visual confusion)
            const guideUrl = guideUrlRaw?.replace(/[.,;:!?]+$/, '') || guideUrlRaw;
            const taskSig = `auto-slow-${sig}`;
            // Phase 13.5 (2026-05-17): classifier infers project name → pre-fills persistedTo,
            // so plan.md starts even when the LLM does not proactively pass persist:true —
            // mechanism layer as fallback. Only triggered by heavy-keyword strong project intent, reducing false positives.
            //
            // Phase 14 (2026-05-18): for scheduled sessions (user message contains no URL),
            // the placeholder now inherits schedule.project — so the placeholder created by
            // scheduled fires + Recent Runs / Lessons automatically flows back into mycox/plan.md.
            let projectHint = cls.projectHint ?? null;
            if (!projectHint) {
              const schedId = extractScheduleIdFromSession(sessionId);
              if (schedId) {
                try {
                  const sched = memory.schedules.findByName(schedId);
                  if (sched?.project) {
                    projectHint = sched.project;
                    console.log(
                      `[auto-plan-on-slow] inherit project=${projectHint} from schedule "${schedId}"`,
                    );
                  }
                } catch (e) {
                  console.warn('[auto-plan-on-slow] schedule.project lookup failed:', e);
                }
              }
            }
            const placeholder = memory.plans.create({
              sessionId,
              taskSignature: taskSig,
              guideRef: guideUrl ?? `user-msg:${userMessage.slice(0, 80)}`,
              persistedTo: projectHint,
              // M3 / Phase 11 (2026-05-15): placeholder plan marked isPlaceholder=true.
              // M4 spec-coverage check R1 skips the deliverables ≥ 1 enforcement (allows empty).
              // The LLM must provide new_deliverables via plan_revise to convert it before a success close.
              isPlaceholder: true,
              // Generic protocol skeleton (2026-05-12 correction): do NOT hardcode any domain-specific actions
              // (mycox / SOUL / heartbeat / posting / register / heartbeat etc. are domain knowledge
              // that the LLM must identify from the user message + referenced documents).
              // This only describes the **protocol contract**: understand → find existing → decompose → execute → close.
              steps: [
                {
                  id: 'understand',
                  description:
                    'deliverables = actions **literally** mentioned in the user message. ' +
                    'guides / reference documents are **reference manuals** for later steps, not deliverable sources — a document saying "how to X" does not mean you must do X. ' +
                    'Execution order = literal order in the user message (follow explicit ordering keywords like "then" / "and then" / "next").' +
                    '\n\n**Phase 16: operational-handoff is mandatory** (if the task involves persistent behavior):' +
                    '\nIf the task / guide contains keywords like `schedule_reminder` / `periodic` / `routine` / `heartbeat` / `check-in`:' +
                    '\n→ deliverables **must** include an `operational-handoff` entry:' +
                    '\n   "**After the first successful call to each business endpoint**, immediately call `plan_knowledge(project, entry, section)` to write each endpoint\'s ' +
                    'method + path + headers + auth scheme into plan.md Operational Knowledge"' +
                    '\n→ **Reason**: scheduled fires are fresh sessions (no onboarding-turn context); they can only find the correct endpoint+auth from the plan.md cookbook. Without this entry, subsequent fires will hit 401 loops.' +
                    '\n→ The mechanism layer\'s plan_close will verify this section is non-empty; missing it will reject a success close.',
                },
                {
                  id: 'find-existing',
                  description:
                    'Call search_skills to find reusable existing solutions; if a match is found and when_to_use matches → use_skill to follow the template; ' +
                    'if no match or not applicable → continue to the next steps.',
                },
                {
                  id: 'decompose',
                  description:
                    'Call plan_revise to replace this placeholder plan with a task-specific plan (pass new_deliverables + new_steps + reason). ' +
                    'Requirements: each deliverable is a concrete output of a **literal action from the user message**; each step.covers links to a deliverable; ' +
                    'things inferred from a guide ("should also do X") **do not count as deliverables** (those are the manual, not the task).',
                },
                {
                  id: 'execute',
                  description:
                    'Execute the revised plan step by step: each step starts with plan_update_step(doing) (plan automatically becomes executing), ' +
                    'and is completed with plan_update_step(done, evidence). If the same root cause fails ≥ 2 times → call plan_revise to change approach.',
                },
                {
                  id: 'close-with-persistence',
                  description:
                    'When all steps are done → call plan_close(outcome, summary, deliverable_status). ' +
                    '**Critical**: before closing, if the task requires **any persistent behavior** (periodic execution / monitoring / check-in etc.), ' +
                    'you must call schedule_reminder to set the appropriate cadence (otherwise the task is left half-done). ' +
                    'Close a failed task with plan_close(failure); this distills a failure-mode playbook for future similar tasks.',
                },
              ],
            });
            audit.append('self_domain_write', {
              source: 'auto_plan_on_slow',
              origin: 'Internal',
              toolName: 'auto_plan_created_on_slow',
              sessionId,
              planId: placeholder.id,
              taskSignature: taskSig,
              guideUrl: guideUrl ?? null,
              stepCount: placeholder.steps.length,
              projectHint: projectHint ?? null,
            });
            console.log(
              `[auto-plan-on-slow] session=${safeSessionId(sessionId)} created placeholder plan ${placeholder.id} (${placeholder.steps.length} steps, guideUrl=${guideUrl ?? 'none'}, project=${projectHint ?? 'none'})`,
            );
            // Phase 13.5: projectHint matched → mechanism layer loadOrCreate plan.md;
            // the LLM no longer needs to pass persist:true; plan_revise/update/close hooks
            // check that persistedTo is non-empty and append accordingly.
            if (projectHint) {
              try {
                memory.planFiles.loadOrCreate(projectHint, {
                  goal: `(auto-derived from guide URL) ${userMessage.slice(0, 160)}`,
                });
                console.log(
                  `[plan-files] auto-loadOrCreate project=${projectHint} (heavy-keyword + URL-path heuristic)`,
                );
              } catch (e) {
                console.error('[plan-files] auto-loadOrCreate failed (ignored):', e);
              }
            }
          }
        } catch (e) {
          console.error('[auto-plan-on-slow] failed (ignored):', e);
        }
      }
    } else if (modeAtEntry === 'slow' && planEntryAllowsReclassify && !intentSaysExplore) {
      // At a clean task boundary the classifier deems this NEW task fast (a one-shot, e.g. delete/list). Demote
      // the sticky-slow session back to fast — MECHANISM-driven (never the LLM), and ONLY here at a task
      // boundary (previous plan terminal/absent). This un-sticks a session left slow by a prior task, and stops
      // one-shot tasks inheriting a stale placeholder or getting a spurious one (the over-classification churn).
      // The deliberate "no slow→fast" invariant guards against the LLM self-demoting to bypass the protocol;
      // this path is unreachable by the LLM, so it does not weaken that guard.
      taskModeStore.set(sessionId, 'fast', 'auto:reclassify-fast-at-task-boundary');
      audit.append('self_domain_write', {
        source: 'auto_task_mode',
        origin: 'Internal',
        toolName: 'task_mode_reclassify_fast',
        sessionId,
        reasons: cls.reasons,
      });
      console.log(
        `[auto-task-mode] session=${safeSessionId(sessionId)} slow→fast (new task classified fast at task boundary)`,
      );
    }
  }

  const recallInput = resolveRecallInput(
    userMessage,
    activeWorkGoalForSession(sessionId),
    signalBus.carriedExploreGoal,
  );

  // Ask the aux model which stored skills this fresh turn is about BEFORE buildFreshMessages consumes
  // signalBus.skillRelevanceNames. Resumed inflight contexts deliberately skip this: their prompt is a
  // frozen tool-use chain and must not be rebuilt or augmented.
  if (turnContext.source === 'fresh') {
    try {
      // listAllForMaintenance deliberately includes deprecated rows for audit/delete workflows. This
      // path surfaces candidates to an LLM, so terminal skills must be removed before they enter the
      // prompt (and before offered-count attribution can touch them).
      const pool = memory.skills.listForRecommendation(400);
      const picked = await selectSkillsByAux(
        recallInput,
        pool.map((s) => ({ name: s.name, description: s.description, whenToUse: s.whenToUse })),
        6,
        {
          onOutcome: (outcome) => {
            if (outcome.result === 'fallback') {
              console.log(
                `[skill-relevance] result=fallback reason=${outcome.reason} candidates=${pool.length}` +
                  (outcome.error ? ` error=${JSON.stringify(outcome.error)}` : ''),
              );
            }
          },
        },
      );
      if (picked && picked.length > 0) {
        signalBus.skillRelevanceNames = picked;
        console.log(`[skill-relevance] aux picked ${picked.length}: ${picked.join(', ')}`);
      }
    } catch (e) {
      console.warn('[skill-relevance] selector failed, keeping lexical ranking:', (e as Error)?.message);
    }
  }
  // Driven by turnContext, not by re-reading the maps: an expired pending can never reach this line
  // as a message source, whatever else moves around it.
  const messages: NativeMessage[] =
    turnContext.source === 'auth-inflight' && pending
      ? [...pending.inflightMessages]
      : turnContext.source === 'question-inflight' && pendingQ
      ? [...pendingQ.inflightMessages]
      : buildFreshMessages(recallInput, sessionId, signalBus);

  // Phase 11 (2026-05-14): per-turn messages reference for plan_review tool to check
  // "most recent assistant text" when detecting the self-review section.
  activeSessionMessages.set(sessionId, messages);

  // Layer 0 global timeline appends user message (placed in outer to ensure pending paths are also persisted)
  memory.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'user',
    content: userMessage,
    // Which conversation said it. The bucket above is shared by every channel; this is the only field
    // that can later answer "was this said in this chat" — see schema v40.
    originSessionId: sessionId,
  });

  // Helpful for locating turn boundaries during testing: start log includes user message preview + whether it resumes pending
  const turnStartedAt = Date.now();
  turnDeadlines.set(sessionId, turnStartedAt + TURN_HARD_DEADLINE_MS);

  // plan_protocol_gate reads this to distinguish a terminal plan closed THIS turn (same-task follow-up →
  // auto-fast ok) from a STALE terminal plan left by a prior task (must not downgrade a new slow task).
  signalBus.turnStartedAt = turnStartedAt;
  signalBus.userMessage = userMessage;
  const userPreview = userMessage.length > 80 ? userMessage.slice(0, 80) + '…' : userMessage;
  console.log(
    `[turn] session=${safeSessionId(sessionId)} start ${pending ? '(resume pending auth)' : '(fresh)'} user="${userPreview.replace(/\n/g, ' ')}"`,
  );

  try {
    const result = await withTimeout(
      handleChatSendInner(
        sessionId, userMessage, audit, messages, grants, onDelta, onAuthRequest,
        signalBus, onStatus, onTrace,
      ),
      TURN_HARD_DEADLINE_MS,
      () => new TurnDeadlineError(TURN_HARD_DEADLINE_MS),
    );
    const dur = Date.now() - turnStartedAt;
    const textPreview = (result.outcome as any).text
      ? `text="${String((result.outcome as any).text).slice(0, 80).replace(/\n/g, ' ')}…"`
      : '';
    // 2026-05-27: add tool summary on turn done, replacing the wall of tool call logs (original [tool] log lines remain;
    // this gives ops an at-a-glance view of "what was called in this turn overall").
    const toolSummary = summarizeTurnTools(signalBus.inTurnRecords ?? []);
    console.log(
      `[turn] session=${safeSessionId(sessionId)} done outcome=${result.outcome.outcomeType} durationMs=${dur} auditEvents=${result.auditEvents} ${toolSummary} ${textPreview}`,
    );

    // Phase 12 cont (2026-05-17): scheduled sessions automatically capture the current turn outcome to
    // ScheduleOutcomeStore. On the next fire of the same schedule, buildMemoryPrefix reads the most recent
    // N entries and injects them at the top — a mechanism-layer "lesson accumulation" channel that does not depend on the reflection distillation chain.
    // Failures do not affect the main flow.
    //
    // Phase 14: scheduled success signal is also computed here — using the summary result. Passed downstream
    // to trigger the reflection plan_knowledge distillation path.
    let scheduledSuccessTurn = false;
    try {
      const scheduleId = extractScheduleIdFromSession(sessionId);
      if (scheduleId) {
        const records = signalBus.inTurnRecords ?? [];
        const traces: ToolCallTrace[] = records.map((r) => {
          const trace: ToolCallTrace = {
            toolName: r.toolName,
            success: r.success,
          };
          if (r.toolName === 'http') {
            const input = r.toolInput ?? {};
            const method = String((input as Record<string, unknown>).method ?? 'GET');
            const url =
              typeof (input as Record<string, unknown>).url === 'string'
                ? ((input as Record<string, unknown>).url as string)
                : undefined;
            trace.httpMethod = method;
            trace.httpUrl = url;
            // http tool error format: "HTTP <STATUS> <METHOD> <URL>" (securedHttp.ts)
            if (!r.success && r.resultText) {
              const m = r.resultText.match(/HTTP (\d+)/);
              if (m) trace.httpStatus = parseInt(m[1], 10);
              const sig = extractFailureSignature('http', r.resultText);
              if (sig) trace.errorSignature = sig;
            } else if (r.success) {
              trace.httpStatus = 200; // successful http defaults to 200 (exact status not parsed; sufficient for aggregation)
            }
          }
          return trace;
        });
        const summary = summarizeTurnTrace(traces);
        // Carry blacklist rejections into the persisted signatures. summarizeTurnTrace only derives
        // signatures from http failures, so a call the mechanism refused left no trace at all — which is
        // why "blocked on every run" stayed invisible. These rows are also rendered into the scheduled
        // turn's own prefix, so the agent sees its own history of being blocked, not just the owner.
        const blockedSignatures = [...(signalBus.blockedTools ?? [])].map(blockedToolSignature);
        const judgeEvidence = lastJudgeGoalUnmet.get(scheduleId);
        const structuralSignatures = judgeEvidence
          ? [...blockedSignatures, JUDGE_GOAL_UNMET_SIGNATURE]
          : blockedSignatures;
        const failureSignatures = [...new Set([...summary.failureSignatures, ...structuralSignatures])];
        const priorOutcomes = memory.scheduleOutcomes.recent(scheduleId, UNSATISFIABLE_GOAL_WINDOW);
        memory.scheduleOutcomes.record({
          scheduleId,
          firedAt: turnStartedAt,
          durationMs: dur,
          outcome: summary.outcome,
          httpOkCount: summary.httpOkCount,
          httpFailCount: summary.httpFailCount,
          httpStatusCounts: summary.httpStatusCounts,
          failureSignatures,
          textSummary: summary.textSummary,
        });
        // Phase 14: scheduled session has ≥ 1 successful http + outcome is not fail → trigger
        // plan_knowledge distillation path (reflection prompt guides LLM to extract endpoints from ✓ TOOL OK)
        scheduledSuccessTurn =
          (summary.outcome === 'ok' || summary.outcome === 'partial') &&
          summary.httpOkCount >= 1;
        console.log(
          `[schedule-outcomes] session=${safeSessionId(sessionId)} scheduleId=${scheduleId} ` +
            `outcome=${summary.outcome} httpOk=${summary.httpOkCount} ` +
            `httpFail=${summary.httpFailCount} sigs=[${failureSignatures.join(',')}]`,
        );
        reportUnsatisfiableGoal(scheduleId, sessionId, structuralSignatures, priorOutcomes, judgeEvidence);
        // Progress verdict for the scheduler's circuit breaker (see scheduledTurnProgress + the pure
        // rule in schedule_progress.ts). No real external progress (writes attempted, all failed —
        // the all-401 avalanche shape) must count as a failure so the 1h auto-pause can arm, even
        // though the turn returned an honest report rather than throwing.
        const madeProgress = scheduledTurnMadeProgress(records);
        scheduledTurnProgress.set(sessionId, { madeProgress, at: Date.now() });
        if (!madeProgress) {
          console.warn(
            `[schedule-progress] session=${safeSessionId(sessionId)} NO real external progress ` +
              `(writes attempted, all failed) → counts as a failure for auto-pause`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `[schedule-outcomes] capture failed (ignored):`,
        (e as Error)?.message ?? e,
      );
    }

    // Reflection trigger (fire-and-forget): evaluated only when the turn reaches a natural end (response / question_pending /
    // stop_and_report); not evaluated for interrupted states like auth_pending / question_timeout. Failures never affect the main flow.
    // Phase 18 WS2: stop_and_report is a natural, high-value end (a deliberate concede) — reflection should run so it can
    // distil a routing_rule ("goal X is barrier-blocked via method Y, don't re-attack that way").
    const outcomeType = result.outcome.outcomeType;
    // Stage A (2026-06-22): could_not_verify is a natural HONEST end (the agent admitted it lacked
    // tool backing instead of fabricating) — reflection should run on it like response/stop_and_report
    // so the system can distil "this needs a working compute path" rather than treating it as failure.
    if (outcomeType === 'response' || outcomeType === 'stop_and_report' || outcomeType === 'could_not_verify') {
      // 2026-05-06 sameRootCauseFailures integration: scans up to 30 failed tool calls within the last 24h,
      // clusters by (toolName + errorClass) signature, and takes the count of the largest same-signature group.
      // This is a cross-turn signal (memory_actions global timeline) implementing "repeated same-wall collision"
      // detection — e.g. shell `command not found: rg` across 5 different turns = signal=5;
      // triggers reflection to have the LLM write a "rg unavailable → switch to grep" routing rule.
      let sameRootCauseFailures = 0;
      try {
        const sinceTs = Date.now() - 24 * 60 * 60_000;
        const recent = memory.actions.listRecentFailures({ sinceTs, limit: 30 });
        sameRootCauseFailures = countSameRootCauseFailures(recent);
      } catch (e) {
        console.warn('[reflection] sameRootCauseFailures computation failed, ignored', e);
      }

      // Phase 18 WS4: arm the NEXT turn's ViabilityGate with reflection's cross-turn judgment. If the owner
      // reasoning session is still active but stalled (noProgressRounds ≥ 3) AND failing the same way repeatedly
      // (sameRootCauseFailures ≥ 2), persist a recommend_stop marker for this chat session. The next turn reads it
      // into signalBus.recommendStop (+3 score) — closing the loop where reflection's same_root_cause insight, which
      // historically only wrote a future routing hint, now also actuates the stop decision.
      try {
        const os = memory.reasoning.getMostRecentActiveSession(sessionId);
        if (os && os.status === 'active' && os.noProgressRounds >= 3 && sameRootCauseFailures >= 2) {
          viabilityRecommendStop.set(sessionId, Date.now());
          console.log(
            `[viability] session=${safeSessionId(sessionId)} reflection recommend_stop armed (noProgressRounds=${os.noProgressRounds}, sameRootCause=${sameRootCauseFailures})`,
          );
        }
      } catch {
        /* advisory signal; ignore lookup failure */
      }

      // 2026-05-11 Phase 3: routing rule outcome backflow.
      // If routing inject hit a rule at the start of this turn (signalBus.activeRuleIds), determine the outcome
      // based on strong turn-close signals and feed back to the routing_rules state machine.
      //
      // Determination principle: **prefer false negatives over false positives** — only strong failure signals
      // mark failure; others default to success.
      //   Strong failure signals — SAME-TURN events only (see the 2026-07-13 / 2026-07-21 notes below;
      //   every cross-turn signal admitted here has eventually become always-on and broken promotion):
      //     - HonestyGate fired (honesty issue)
      //     - emptyConclusionFired (empty conclusion regen)
      //   Removed: interruptDrained (2026-07-13), sameRootCauseFailures (2026-07-21) — both cross-turn.
      //
      // If any strong failure signal triggered → record NOTHING (ambiguous — we cannot attribute a
      // turn-level failure to a specific rule). Otherwise → mark all as success (turn closed normally).
      //
      // This is the key step from routing_rules.recordRuleOutcome having 0 callers to a true closed loop:
      // without outcome backflow, the 5-tier confidence state machine is dead data.
      if (signalBus.activeRuleIds && signalBus.activeRuleIds.length > 0) {
        // 2026-07-13: interruptDrained REMOVED from the strong-failure set. It counts K7 signals that
        // accumulated during the IDLE PERIOD BEFORE this turn and were drained into it (see the drain at
        // the top of the turn) — it is a statement about pre-existing system state, so it cannot be
        // evidence that THIS turn's injected rule was wrong. And it is on nearly every turn, so it made
        // "the turn closed clean" almost unreachable: prod 7d showed success=4 vs ambiguous_skipped=32,
        // and with promotion needing 3 consecutive successes (provisional→tentative→validated) the result
        // was 1022 stored rules and validated=0 (0%) — the confidence machine could only ever demote.
        // The 2026-07-05 attribution fix was aimed at exactly this and left the one always-on signal in.
        //
        // 2026-07-21: sameRootCauseFailures REMOVED for the identical reason — it is the same defect
        // wearing a different name, and removing interruptDrained simply promoted it into the vacancy.
        // It counts failures clustered by (toolName + errorClass) over a 24h GLOBAL window, so it is a
        // statement about the last day of system-wide state, not about this turn. Once any failure
        // recurs — prod 2026-07-21: a scheduled task whose goal required writeFile while heartbeat
        // turns forbid writeFile, so the same blocked call recurred every 6 minutes forever — it is
        // pinned ≥2 permanently and no turn can ever close clean again: success=12 vs
        // ambiguous_skipped=106, validated 3 of 1094 rules.
        //
        // The invariant this keeps re-learning: an always-on signal in the strong-failure set turns the
        // confidence machine into a demote-only machine. Both survivors are strictly same-turn events.
        const strongFailure =
          signalBus.honesty !== undefined ||
          signalBus.emptyConclusionFired === true;
        const outcome = !strongFailure;
        // 2026-07-05 attribution fix: a hard turn is NOT evidence against the injected rules — the
        // gate signals (honesty / same-root-cause / interrupt / empty-conclusion) fire for reasons
        // unrelated to routing, yet EVERY injected rule was blame-marked failure (prod stream:
        // success=1 / failure=48 → no rule could ever collect the 2 consecutive successes that
        // promotion to 'validated' requires; the confidence machine only ever demoted). We cannot
        // attribute a turn-level failure to a specific rule, so: record SUCCESS when the turn closed
        // clean (positive evidence the recommendation did not derail it), record NOTHING when it
        // failed (ambiguous — noise, not signal). Bad rules still die via unproven-decay.
        memory.metrics.increment(
          outcome ? 'routing.outcome.success' : 'routing.outcome.ambiguous_skipped',
          signalBus.activeRuleIds.length,
        ); // instrumentation: does the confidence machine actually get fed?
        for (const ruleId of outcome ? signalBus.activeRuleIds : []) {
          try {
            memory.routingRules.recordRuleOutcome(ruleId, true);
          } catch (e) {
            console.warn(
              `[routing-outcome] recordRuleOutcome(${ruleId}, true) failed, ignored:`,
              (e as Error)?.message,
            );
          }
        }
        internalAudit.append('self_domain_write', {
          source: 'routing_outcome',
          origin: 'Internal',
          toolName: outcome ? 'routing_rule_success' : 'routing_rule_failure',
          sessionId,
          ruleIds: signalBus.activeRuleIds,
          honestyFired: signalBus.honesty !== undefined,
          sameRootCauseFailures,
          interruptDrained: (signalBus.interruptDrainedCount ?? 0) > 0,
          emptyConclusionFired: signalBus.emptyConclusionFired === true,
        });
        console.log(
          `[routing-outcome] session=${safeSessionId(sessionId)} ruleIds=[${signalBus.activeRuleIds.join(',')}] outcome=${outcome ? 'success' : 'ambiguous (not attributed)'}`,
        );
      }

      // A mechanical error this turn REPAIRED is the one thing the reflection JSON has no type for:
      // routing_rule carries an avoidance clause, new_skill wants a whole workflow, playbook wants an
      // abstract principle. So 71 recurrences of pariGp:gp-syntax produced 71 ways to say "avoid it" and
      // not one repair. This runs beside reflection, gated on the trace showing a real recovery — see
      // mechanical_fix_learning.ts. Fire-and-forget: it must never delay or fail a turn close.
      void distillMechanicalFix(extractRecentToolResults(messages), memory.facts)
        .then((learned) => {
          if (learned) {
            console.log(
              `[mechanical-fix] learned a repair for ${learned.signature}: ${learned.line}`,
            );
            memory.metrics.increment('mechanical_fix.learned');
          }
        })
        .catch((e) => console.warn('[mechanical-fix] distillation failed, ignored:', (e as Error)?.message));

      // 2026-05-15: turnDegraded signal synthesis — if any mechanism-layer "forced wrap-up" signal fires,
      // reflection takes the negative distillation path and rejects new_skill / skill_refine.
      const turnDegraded =
        signalBus.planCircuitBroken === true
        || signalBus.inTurnToolBlockFired === true
        || signalBus.planAutoClosedFailure === true;

      void maybeRunReflection({
        sessionId,
        messages,
        userMessage,
        skills: memory.skills,
        routingRules: memory.routingRules,
        plans: memory.plans,
        planFiles: memory.planFiles,
        metrics: memory.metrics,
        appendAudit: (eventType, payload) => internalAudit.append(eventType, payload),
        // D.2 (2026-05-06): all 4/4 trigger inputs connected
        // Phase 14 (2026-05-18): scheduledSuccess connects to the plan_knowledge distillation path
        signals: {
          honestyFired: signalBus.honesty !== undefined,
          interruptDrained: (signalBus.interruptDrainedCount ?? 0) > 0,
          turnStartTs: turnStartedAt,
          sameRootCauseFailures,
          turnDegraded,
          scheduledSuccess: scheduledSuccessTurn,
        },
      });
    }

    // Phase 1 shadow: score this turn, log only. See shadowLearningJudge.
    shadowLearningJudge(sessionId, userMessage, messages, signalBus, !!pending);

    return result;
  } catch (e) {
    // K0: messages are fresh each turn; no rollback needed. Still must clear pendingAuth/
    // pendingQuestion, otherwise the next message will erroneously enter the grant/deny or question branch.
    pendingAuth.delete(sessionId);
    pendingQuestion.delete(sessionId);
    persistContinuation(sessionId);
    const dur = Date.now() - turnStartedAt;
    // Interrupt teeth: user mid-turn stop cancelled the in-flight LLM call → clean exit as interrupted,
    // not an error. The runToolLoop boundary-check path already returns interrupted directly and does not reach here;
    // this path specifically handles "abort hitting in-flight LLM HTTP and throwing AbortError".
    if (isAbortError(e)) {
      console.log(`[turn] session=${safeSessionId(sessionId)} stopped by user durationMs=${dur}`);
      return {
        outcome: { outcomeType: 'interrupted', reason: 'user_stop', text: 'Stopped' },
        auditEvents: audit.length,
      };
    }
    if (e instanceof TurnDeadlineError) {
      console.warn(`[turn] session=${safeSessionId(sessionId)} hit ${TURN_HARD_DEADLINE_MS}ms deadline durationMs=${dur}`);
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'turn_deadline',
        ts: Date.now(),
        detail: `turn 跑了 ${dur}ms 撞 ${TURN_HARD_DEADLINE_MS}ms 硬上限`,
      });
    } else {
      console.error(`[turn] session=${safeSessionId(sessionId)} failed durationMs=${dur}:`, (e as any)?.message ?? e);
      // Generic exception fallback audit (cases already emitted inside sendLlmWithRescue as llm_timeout / llm_api_error
      // will not reach here again; but K7-bridge failures / question flow exceptions etc. will fall here)
      internalAudit.append('task_failure_mode', {
        sessionId,
        kind: 'turn_error',
        ts: Date.now(),
        detail: String((e as Error)?.message ?? e).slice(0, 200),
      });
    }
    throw e;
  } finally {
    // v19 (2026-05-13): clean up the session mapping used for close-time signal queries to prevent memory leaks.
    activeSignalBuses.delete(sessionId);
    activeSessionMessages.delete(sessionId);
    activeTurnAborters.delete(sessionId);
  }
  }, onStatus); // end runInTurnContext (onStatus is exposed to nested tools via currentTurnStatus)
}

/**
 * Actual logic of handleChatSend; the outer layer is responsible for messages snapshot/rollback.
 */
async function handleChatSendInner(
  sessionId: string,
  userMessage: string,
  audit: AuditLog,
  messages: NativeMessage[],
  grants: GrantStore,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  signalBus: TurnSignalBus,
  onStatus?: (text: string) => void,
  onTrace?: TraceFn,
) {
  // signalBus is created and passed in by outer handleChatSend. It accumulates K7 reactive signals for this turn
  // (honesty fire / interrupt drain count), used for:
  //   1. K7→K8 bridge (finally block)
  //   2. reflection trigger input (D.2)

  // Resolve the language for user-facing status phrases (onStatus).
  // WeChat channel uses Chinese; all other channels use English.
  const statusLang: PhraseLang = resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() });

  // B (2026-06-28): flag a deep_explore STATUS/COUNT query so force-continue can't hijack it into a 6-min
  // advancing round and the fabrication gate doesn't block the snapshot answer (read by both downstream).
  signalBus.userAsksExploreStatus = userAsksExploreStatus(userMessage);

  // Skill hot-reload: if the revision has changed, inject a skill catalog update notification before this turn's message
  const seen = sessionSkillsRevision.get(sessionId) ?? 0;
  if (seen < skillsRevision) {
    const update = buildSkillUpdateMessage();
    if (update) {
      messages.push({ role: 'user', content: update });
      messages.push({ role: 'assistant', content: 'Acknowledged, skill catalog refreshed.' });
    }
    sessionSkillsRevision.set(sessionId, skillsRevision);
  }

  // Reminders no longer injected into LLM history: changed to reminderEmitter → WS pushes proactively to UI,
  // avoiding pollution of prompt cache and LLM context.
  //
  // K0: user message already persisted to the raw global timeline by outer handleChatSend; not appended again here.

  // Phase 11(2026-05-14):cross-turn-reflection trigger
  //
  // Background: production mycox heartbeat schedule — schedule fires a new turn every N minutes;
  // LLM repeatedly hits the same 404 (POST /api/comments "Post not found"). in-turn-reflection
  // only blocks remaining http calls in the current turn, but the next schedule turn resets → infinite loop.
  //
  // Fix: check sameRootCauseFailures within 24h for the same session at turn start.
  // ≥ threshold (default 3) + active plan → mechanism layer automatically:
  //   1. plan_close('failure', '[cross-turn-reflection] ...')
  //   2. Inject user-role reminder to make this turn's LLM:
  //      - Report the blocker using ## For User
  //      - In a schedule turn → call cancel_schedule to pause this schedule
  //      - Write store_note for diagnosis
  //
  // env PHILONT_CROSS_TURN_REFLECTION=0 to disable / *_THRESHOLD=N to adjust threshold (default 3).
  // pending* resume paths are skipped (user has explicitly agreed to continue).
  const _pendingForReflectCheck = pendingAuth.get(sessionId);
  const _pendingQForReflectCheck = pendingQuestion.get(sessionId);
  if (
    !_pendingForReflectCheck &&
    !_pendingQForReflectCheck &&
    process.env.PHILONT_CROSS_TURN_REFLECTION !== '0'
  ) {
    try {
      const sinceTs = Date.now() - 24 * 60 * 60_000;
      const recentSessionFails = memory.actions.listRecentFailures({
        sinceTs,
        limit: 50,
        sessionId,
      });
      const sameRoot = countSameRootCauseFailures(recentSessionFails);
      const threshold = Math.max(
        2,
        Number(process.env.PHILONT_CROSS_TURN_REFLECTION_THRESHOLD) || 3,
      );
      if (sameRoot >= threshold) {
        const groups = groupFailures(recentSessionFails);
        const topGroup = groups[0];
        const topSig = topGroup?.signature ?? 'unknown';
        const topToolName = topSig.split(':')[0] ?? 'unknown';
        const lastPlan = memory.plans.listBySession(sessionId, { limit: 1 })[0];
        const planActive =
          lastPlan &&
          (lastPlan.status === 'draft' || lastPlan.status === 'executing');
        // 1. Auto-close active plan
        if (planActive) {
          // M4 (2026-05-15): deliverable_status all marked not-attempted (mechanism-layer fallback close)
          const allNotAttempted = Object.fromEntries(
            lastPlan!.deliverables.map((d) => [d.id, 'not-attempted' as const]),
          );
          memory.plans.close(
            lastPlan!.id,
            'failure',
            `[cross-turn-reflection] 跨 turn 同根因失败 ${sameRoot} 次 (signature=${topSig}),` +
              `机制层自动 close plan 防 schedule 死循环。`,
            allNotAttempted,
          );
          console.warn(
            `[cross-turn-reflection] session=${safeSessionId(sessionId)} plan=${lastPlan!.id} → close failure (sameRoot=${sameRoot}, sig=${topSig})`,
          );
          audit.append('self_domain_write', {
            source: 'cross_turn_reflection',
            origin: 'Internal',
            toolName: 'plan_auto_close_cross_turn',
            sessionId,
            planId: lastPlan!.id,
            sameRootCauseCount: sameRoot,
            signature: topSig,
          });
        } else {
          console.warn(
            `[cross-turn-reflection] session=${safeSessionId(sessionId)} sameRoot=${sameRoot} (sig=${topSig}) but no active plan, only injecting reminder`,
          );
        }
        // 2. Inject reminder
        const isSchedule = sessionId.startsWith('system:scheduled:');
        const reminder =
          `[drive cross-turn-reflection] This session has seen **${sameRoot} same-root-cause failures in 24 h** (signature=${topSig}).` +
          `\nThis is a cross-turn loop pattern — you keep hitting the same error with the same tool. **Change direction this turn**:\n` +
          `  1. Use the \`## For User\` section to tell the user what you are stuck on (brief description of the failure pattern + how you plan to change approach / what you need)\n` +
          (isSchedule
            ? `  2. **This turn was triggered by a schedule** → strongly recommend calling cancel_schedule to pause this schedule (prevents it from firing every N minutes and burning tokens)\n`
            : '') +
          `  3. Call store_note(importance=high) to write a diagnostic note — future turns on similar tasks can look it up\n` +
          `  4. **Do not call ${topToolName} again** (same-root-cause ≥ ${threshold} times; you will not unblock yourself this way)` +
          (planActive
            ? `\n\n**The old plan ${lastPlan!.id} has been automatically closed as failure by the mechanism layer.** To continue, first draft a new plan_draft based on this reflection (with a different step direction).`
            : '') +
          `\n\nThis reminder is a mandatory mechanism-layer injection and is not surfaced to the user. Set env PHILONT_CROSS_TURN_REFLECTION=0 to disable.`;
        messages.push({ role: 'user', content: reminder });
        onTrace?.({
          kind: 'internal-gate', tier: 4,
          text: `cross-turn-reflection 触发(同根因失败 ${sameRoot} 次,${topSig})`,
          meta: { gateName: 'CrossTurnReflection' },
        });
      }
    } catch (e) {
      console.warn('[cross-turn-reflection] check failed, skipped:', (e as Error).message);
    }
  }

  // ── Check for pending authorization requests ──────────────────────────────────────────────────
  //
  // Not yet in the address book — it carries provider tool_use pairing and a continuation, and gets
  // its own pass. But it must already OBEY the book: this branch runs before the research branch, so
  // without the guard a reply the owner clearly aimed at a research card is spent here instead.
  const pending = pendingAuth.get(sessionId);
  pendingAuthBlock: if (pending && !claimedByAnotherDecision(signalBus)) {
    // WeChat used to stop polling for the whole agent turn. A reply sent during that turn could arrive
    // only after a NEW authorization card had been delivered and accidentally approve a request the
    // owner had never seen. Do not spend that message on authorization: keep the card pending, but
    // handle what the owner actually said as a normal request. Comparing with delivery (not creation)
    // also covers outbound queue delay. A known failed delivery follows the same bypass and retries the
    // card after the ordinary response.
    if (pending.deliveredAt !== undefined && signalBus.inboundSentAtMs === undefined) {
      memory.metrics.increment('auth.delivery_timestamp_missing');
      console.warn(
        `[auth] session=${safeSessionId(sessionId)} cannot compare inbound with auth delivery: ` +
          `wire sentAt missing (delivered=${pending.deliveredAt}, tool=${pending.toolName})`,
      );
    }
    if (signalBus.authInboundDisposition === 'bypass_predelivery') {
      memory.metrics.increment('auth.bypass_predelivery');
      const skewMs = signalBus.inboundSentAtMs! - pending.deliveredAt!;
      console.warn(
        `[auth] session=${safeSessionId(sessionId)} bypassed auth for delayed inbound sent before delivery ` +
          `(sent=${signalBus.inboundSentAtMs}, delivered=${pending.deliveredAt}, deltaMs=${skewMs}, tool=${pending.toolName}); ` +
          `handling inbound as a normal request`,
      );
      // The ordinary response would otherwise bury the still-pending card it just bypassed. Re-emit
      // the same request (the map entry is unchanged) so channel flush ordering restores it as the
      // final, prominent message.
      onAuthRequest(authRequestToReissue(signalBus.authInboundDisposition, pending)!);
      break pendingAuthBlock;
    }
    if (signalBus.authInboundDisposition === 'bypass_undelivered') {
      memory.metrics.increment('auth.bypass_undelivered');
      console.warn(
        `[auth] session=${safeSessionId(sessionId)} bypassed auth because the ${pending.toolName} card was not delivered; ` +
          `handling inbound as a normal request and re-sending the card`,
      );
      onAuthRequest(authRequestToReissue(signalBus.authInboundDisposition, pending)!);
      break pendingAuthBlock;
    }
    // Captured before the block below flips it back to `awaiting_auth` on an explicit retry.
    const wasUncertain = pending.executionState === 'uncertain';

    if (pending.executionState === 'uncertain') {
      const recovery = classifyUncertainToolReply(userMessage);
      // THIS QUESTION MUST BE ABLE TO END WITHOUT THE OWNER SAYING THE MAGIC WORD.
      //
      // The reply words are matched exactly on purpose — they are the words we offered, and handing our
      // own closed enum to a semantic classifier has already produced the opposite reading once. But an
      // exact match with no way out is a trap, and the trap closes on precisely this owner: in the
      // 2026-08-09 log 14 of 20 messages are "继续" or "OK", and the test for this classifier pins both
      // of them as `unknown`. Every one of them would have re-asked the same sentence, forever, with no
      // way to even change the subject.
      //
      // So the question is bounded. What the bound must NOT do is invent an answer: after two unheard
      // replies the owner has not "chosen to skip", and telling the model they did is a lie the audit
      // trail and the learning judge would both inherit. The call is recorded as UNRESOLVED — never
      // replayed, not decided — and the message that ran out the bound is then handled as what it
      // actually was: a new request. Closing the dead chain is not a reason to drop what the owner said.
      if (recovery === 'unknown') {
        const prompts = (pending.uncertainPrompts ?? 0) + 1;
        const ageMs = Date.now() - (pending.uncertainSince ?? pending.ts);
        const giveUp = prompts > UNCERTAIN_RECOVERY_MAX_PROMPTS || ageMs > UNCERTAIN_RECOVERY_TTL_MS;
        if (!giveUp) {
          pending.uncertainPrompts = prompts;
          persistContinuation(sessionId);
          onDelta(
            `服务在执行 ${pending.toolName} 期间中断，无法确认外部副作用是否已经生效。` +
            `为避免重复操作，我没有自动执行。请明确回复“重试”或“跳过”。`,
          );
          return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
        }
        console.warn(
          `[uncertain-recovery] session=${safeSessionId(sessionId)} no explicit answer for ${pending.toolName} ` +
            `(prompts=${prompts}, age=${Math.round(ageMs / 60_000)}m) → recorded UNRESOLVED (not skipped), ` +
            `never replayed; this turn continues as a normal request`,
        );
        // Close the suspended chain so every tool_use has a tool_result, then leave the auth branch.
        // The normal path below pushes this turn's real user message after these results.
        messages.push({ role: 'user', content: closeSuspendedToolChain(pending, 'unresolved') });
        pendingAuth.delete(sessionId);
        persistContinuation(sessionId);
        signalBus.unresolvedToolCall = { toolName: pending.toolName, reason: 'no_explicit_decision' };
        break pendingAuthBlock;
      }
      if (recovery === 'skip') {
        const resumed = await runToolLoop(
          sessionId, messages, grants, audit,
          [],
          closeSuspendedToolChain(pending, 'declined'),
          pending.iteration,
          onDelta, onAuthRequest,
          signalBus, onStatus, onTrace, statusLang,
        );
        if (pendingAuth.get(sessionId) === pending) pendingAuth.delete(sessionId);
        persistContinuation(sessionId);
        return resumed;
      }
      // Explicit retry is a new authorization decision. Continue through the normal grant path.
      pending.executionState = 'awaiting_auth';
      pending.ts = Date.now();
      pending.callLedger = (pending.callLedger ?? []).map((entry) =>
        entry.id === pending.toolCallId ? { ...entry, state: 'awaiting_auth' as const } : entry,
      );
      persistContinuation(sessionId);
    }

    // Expired pending → abandon it and handle the message as a normal turn. Without this, a stale
    // pending makes every later message run through the allow/deny classifier.
    //
    // handleChatSend already dropped expired entries BEFORE building this turn's messages (see the
    // continuation block there), so in practice this is now a second line of defence for entries that
    // aged out mid-turn. It is kept because the ordering, not the check, was the defect.
    const expired = pendingAuthIsStale(pending, Date.now());
    const context = `Tool "${pending.toolName}" (${pending.capability}/${pending.domain})`;
    // "retry" answers the interrupted-tool question and nothing else. Left unscoped it was a way to
    // approve ANY suspended tool — including an expired one, skipping both the TTL and the intent
    // classifier — with a word the owner was never offered for that purpose.
    const explicitRecoveryRetry =
      wasUncertain && classifyUncertainToolReply(userMessage) === 'retry';
    const intent = explicitRecoveryRetry
      ? 'grant'
      : expired
        ? 'unclear'
        : await classifyAuthIntent(userMessage, context);

    if (intent === 'grant') {
      // deep_explore runs multi-round sessions where a single round can outlast the default
      // default grant (round deadline is 12 min), forcing a re-auth every round. Give it a longer
      // window so one approval covers the session.
      // The approved tool must not expire BEFORE the tools its approval granted as a side effect.
      //
      // It did, for weeks. `undefined` here falls through to GrantStore's DEFAULT_TTL_MS = 10 min, while
      // localWorkflowGrants below hands the siblings WORKFLOW_GRANT_TTL_MS = 30 min. So approving `shell`
      // bought 10 minutes of shell and 30 minutes of writeFile/patch/pariGp — the one tool the owner
      // actually said yes to got the shortest window of all, and the workflow grant that exists to end the
      // "继续→授权→ok" treadmill kept every sibling alive while the primary died under them.
      //
      // Production 2026-07-31 shows the period exactly. shell approved 10:18:48 → auth card 10:33:20 →
      // approved 10:34:04 → card 10:44:13 → approved 10:49:26 → card 11:04:39 → approved 11:04:41 → card
      // 11:22:06. Ten-minute clockwork; the owner typed OK twelve times in one morning for a workflow he
      // had already authorised.
      // A COMMAND-GATED CALL IS APPROVED AS A COMMAND, NOT AS A CAPABILITY.
      //
      // `git push` reaches the auth card through the validator chain, which requires a COMMAND-scope
      // grant — a tool-scope one deliberately does not satisfy it. So a normal approval here would
      // grant `shell` for thirty minutes, the validator would refuse it again, and the card would come
      // straight back: approve, denied, approve, denied. The yes has to be shaped like the question.
      //
      // Which is also the safer shape. What went wrong on 2026-08-10 was not that publishing was
      // allowed; it was that publishing rode in on a shell approval given earlier for something else.
      // This grant covers that one command for five minutes and nothing else — and the workflow batch
      // below is suppressed, because "yes, push this" is not "yes, and also help yourself to the local
      // write/execute loop for half an hour".
      const gatedCommand = pendingCommandText(pending.toolName, pending.input);
      const gatedPattern = gatedCommand ? findDangerousPattern(gatedCommand) : null;
      const commandGated = gatedPattern?.defaultAction === 'grant';

      const grantTtlMs =
        pending.toolName === 'deep_explore' ? DEEP_EXPLORE_GRANT_TTL_MS : WORKFLOW_GRANT_TTL_MS;
      grants.grant(pending.toolName, pending.capability as any, pending.domain as any, userMessage, grantTtlMs);
      if (commandGated) {
        grants.grant({
          toolName: pending.toolName,
          scope: 'command',
          // Exact command. `*` / `?` inside it would read as glob wildcards — a widening confined to
          // this one command shape and this one short window, which beats not converging at all.
          pattern: gatedCommand,
          capability: pending.capability as any,
          domain: pending.domain as any,
          reason: `command-gated approval (${gatedPattern!.id}): ${userMessage.slice(0, 40)}`,
          ttlMs: SENSITIVE_COMMAND_GRANT_TTL_MS,
        });
        console.log(
          `[command-gate] session=${safeSessionId(sessionId)} approved ${gatedPattern!.id} for ONE command ` +
            `(${Math.round(SENSITIVE_COMMAND_GRANT_TTL_MS / 60_000)}min, no workflow batch): ${gatedCommand.slice(0, 60)}`,
        );
      }
      const grantMinutes = Math.round(grantTtlMs / 60_000);
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: commandGated
          ? `Granted this one ${pending.toolName} command — ${gatedPattern!.description} (${Math.round(SENSITIVE_COMMAND_GRANT_TTL_MS / 60_000)} min, this command only)`
          : `Granted ${pending.toolName} (valid for ${grantMinutes} min)`,
        meta: { toolName: pending.toolName },
      });
      // Phase 18 (2026-06-15) WS5 + 2026-06-17 fix: research-workflow grant. Approving ANY local write/execute
      // tool grants the WHOLE local research set — both write/local (writeFile, patch, moveFile) AND
      // execute/local (shell, pariGp, z3Verify) — for a longer window. A math-research push is a
      // write→run→write→run loop that needs both capabilities; the old per-capability grant still bounced a
      // fresh auth card on the first cross-capability tool (and pariGp/z3Verify were missing entirely), so the
      // user paid one "ok" per tool/capability — the "继续→授权→ok" treadmill (prod 2026-06-17: ~6 "ok"s for one
      // push). One approval now covers the loop. Network downloads (downloadFile, domain=network), destructive
      // deleteFile, and external/untrusted execution stay per-call.
      const wfGrants = commandGated
        ? []
        : localWorkflowGrants(pending.capability, pending.domain, pending.toolName);
      for (const g of wfGrants) {
        grants.grant(g.tool, g.capability as any, g.domain as any, `research workflow grant via ${pending.toolName} approval`, WORKFLOW_GRANT_TTL_MS);
      }
      if (wfGrants.length > 0) {
        console.log(
          `[workflow-grant] session=${safeSessionId(sessionId)} ${pending.capability}/${pending.domain} approval also grants [${wfGrants.map((g) => g.tool).join(',')}] for ${Math.round(WORKFLOW_GRANT_TTL_MS / 60_000)}min`,
        );
      }
      // Reconstruct the suspended tool as a call and place it back at the front of the queue, then re-enter runToolLoop with the remaining calls.
      // Must preserve it; otherwise the tool_use in the previous assistant message will have no matching tool_result,
      // and the next llm.send will be rejected by the API with "empty final user message" or structure mismatch.
      const resumeCalls = [
        { id: pending.toolCallId, name: pending.toolName, input: pending.input },
        ...pending.remainingCalls,
      ];
      // The user explicitly approved THIS call — the plan gate must not re-block it on resume.
      signalBus.authApprovedCallId = pending.toolCallId;
      // Carry the pre-pause tool ledger into this resumed segment so same-turn honesty/verdict checks
      // see what already succeeded before the auth pause (prevents a false skill_forget_claim_without_call
      // after a real forget_skill that happened before the approval gate).
      signalBus.inTurnRecords = [
        ...(pending.priorInTurnRecords ?? []),
        ...(signalBus.inTurnRecords ?? []),
      ];
      // Persist BEFORE invoking the tool. If the process dies after the side effect but before
      // recording its result, startup converts this state to `uncertain` and refuses auto-replay.
      pending.executionState = 'running';
      pending.callLedger = (pending.callLedger ?? []).map((entry) =>
        entry.id === pending.toolCallId ? { ...entry, state: 'running' as const } : entry,
      );
      persistContinuation(sessionId);
      // Do not insert an ordinary user message between an assistant tool_use and its tool_result.
      // The approval is already persisted in the raw timeline and represented by authApprovedCallId;
      // inserting it here violates the provider's pairing invariant.
      //
      // An earlier version of this comment blamed that insertion for the adapter's `missing=2` repairs.
      // The log says otherwise: those repairs are dated 2026-08-09, the insertion was written on 08-10,
      // and they occur on turns that never reach this branch. Their real source was expired pendings
      // seeding the message array before the TTL was checked (fixed in handleChatSend). Removing the
      // insertion is still right — the invariant is real — but it fixed a different thing than claimed,
      // and a fix credited with someone else's symptom is a fix nobody will re-examine.
      const resumed = await runToolLoop(
        sessionId, messages, grants, audit,
        resumeCalls,
        pending.collectedResults,
        pending.iteration,
        onDelta, onAuthRequest,
        signalBus, onStatus, onTrace, statusLang,
      );
      if (pendingAuth.get(sessionId) === pending) pendingAuth.delete(sessionId);
      persistContinuation(sessionId);
      return resumed;
    } else if (intent === 'deny') {
      pendingAuth.delete(sessionId);
      persistContinuation(sessionId);
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `已拒绝 ${pending.toolName}`,
        meta: { toolName: pending.toolName },
      });
      // Push the rejection result + placeholder results for all remaining calls together, letting the LLM give a final response directly
      const allResults = [
        ...pending.collectedResults,
        { type: 'tool_result' as const, tool_use_id: pending.toolCallId, content: `用户明确拒绝了此操作，不要重试，直接告知用户操作已被用户取消。` },
        ...pending.remainingCalls.map(c => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: `已跳过（前置工具被用户拒绝）`,
        })),
      ];
      messages.push({ role: 'user', content: allResults });
      // The owner's actual words go in too. Without this the model sees only "the user rejected it" and
      // answers "操作已被您取消。" — so a misread `deny` does not merely skip a tool, it EATS the message.
      // Production 2026-07-30: a question about the pending request came back as outcome=denied and was
      // never answered. Prompt wording alone cannot make a classifier infallible, so the mechanism is
      // built to survive being wrong: if it really was a refusal this line is the word "拒绝" and changes
      // nothing, and if it was a question the turn still answers it.
      messages.push({ role: 'user', content: userMessage });
      const resp = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
      if (resp.type === 'text') {
        messages.push({ role: 'assistant', content: resp.content });
        onDelta(resp.content);
      } else {
        // LLM still wants to call tools; force terminate and give a hint
        const fallback =
      resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }) === 'en'
        ? 'Cancelled.'
        : '操作已被您取消。';
        messages.push({ role: 'assistant', content: fallback });
        onDelta(fallback);
      }
      return { outcome: { outcomeType: 'denied' }, auditEvents: audit.length };
    }
    // unclear (or expired): the reply is not a recognizable allow/deny. Do NOT re-prompt and
    // re-arm the pending — that traps natural-language messages ("is the session still active?",
    // "give me a progress update") in an endless "please reply allow/deny" loop. Instead abandon
    // the suspended tool and fall through to a normal turn so the message is actually answered.
    // (Safe: messages are rebuilt fresh each turn — K0 — so the dropped tool_use needs no cleanup.
    // If the user really meant to run the tool, the LLM re-issues the call and re-triggers auth.)
    onTrace?.({
      kind: 'auth-decision', tier: 4,
      text: expired
        ? `Pending auth for ${pending.toolName} expired (>${Math.round(PENDING_AUTH_TTL_MS / 60_000)} min); handling message as a normal turn`
        : `Reply to ${pending.toolName} auth was not allow/deny; handling message as a normal turn`,
      meta: { toolName: pending.toolName },
    });
    pendingAuth.delete(sessionId);
    persistContinuation(sessionId);
    // fall through to normal turn processing below
  }

  // ── Proactive research "request permission": user replies "agree/deny" on WeChat against a background-pushed auth card ──────
  // Mirrors pendingAuth but lighter: no tool-chain resume (continuation is done automatically by the next autonomous tick's driver replay);
  // only needs to write a grant / revoke request.
  // unclear / expired → pass through to normal turn (pending-approval prompt section + grant_research_tool fallback).
  // By the id the entry router resolved — never "the most recent one in this conversation", which is
  // what let an answer meant for A be applied to B.
  const rg = researchPayloadFor(signalBus);
  // Only when the address resolved at message entry names THIS card. The reply reaching here used to
  // mean nothing more than "no earlier module claimed it", which is not the same as "it was meant for
  // this" — and one message must resolve at most one decision, so a reply already spent upstream is
  // not re-interpreted here.
  const addressedToResearch =
    rg?.decisionId !== undefined && signalBus.resolvedDecisionId === rg.decisionId;
  if (rg && addressedToResearch) {
    // Quick-check for expiry first (avoids unnecessary LLM intent calls); only classify intent if not expired.
    const expired = Date.now() - rg.ts > RESEARCH_GRANT_PENDING_TTL_MS;
    // The card handed the user a closed enum ("reply 同意 / 拒绝", or approve / reject). Reading our OWN
    // vocabulary back is an exact match, not a semantic-classification problem — we have already shipped a
    // bug where the user replied with one of our own offered words and the general classifier read it as the
    // opposite. Only genuinely open language reaches the classifier.
    //
    // The classifier reads the VERDICT only. Which card this is about was settled upstream by exact
    // means — a quote, an id, a position in a list the owner was shown — and a semantic classifier is
    // not allowed to pick the target.
    const verdictText = signalBus.resolvedVerdictText ?? userMessage;
    const offered = expired ? null : classifyGrantReply(verdictText);
    const intent = expired
      ? 'unclear'
      : (offered ??
        (await classifyAuthIntent(
          verdictText,
          `Background research requests use of tool "${rg.tool}" (execute/system)`,
        )));
    const action = decideResearchGrantAction(rg, intent, Date.now(), RESEARCH_GRANT_PENDING_TTL_MS);

    if (action === 'grant') {
      // STATE FIRST, THEN THE RECORD. If the grant does not get written, nothing below runs: the card
      // stays addressable, the payload stays behind it, and the owner is told plainly rather than
      // reassured by a ledger entry describing something that did not happen.
      const outcome = applyResearchDecision({ payload: rg, verdict: 'grant', effects: researchEffects });
      if (!outcome.applied) {
        auditDecisionApplied(sessionId, rg.decisionId!, 'failed', outcome.reason);
        console.error(`[research-grant] session=${safeSessionId(sessionId)} grant failed: ${outcome.reason}`);
        const failed = statusLang === 'zh'
          ? `没能完成授权（${outcome.reason}）。这张卡还在，可以再回复一次。`
          : `Could not complete the authorization (${outcome.reason}). The request is still open — reply again to retry.`;
        messages.push({ role: 'assistant', content: failed });
        onDelta(failed);
        return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
      }
      pendingResearchGrants.delete(rg.decisionId!);
      pendingDecisions.resolve(sessionId, rg.decisionId!);
      auditDecisionApplied(sessionId, rg.decisionId!, 'granted', outcome.detail);
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `Granted background research use of ${rg.tool} (research ${rg.pursuitId})`,
        meta: { toolName: rg.tool },
      });
      const reply = statusLang === 'zh'
        ? `已授权后台研究使用 ${rg.tool}，接下来会用它继续推进研究。`
        : `Granted. Background research will use ${rg.tool} to continue.`;
      messages.push({ role: 'assistant', content: reply });
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
    } else if (action === 'deny') {
      // A denial that fails to withdraw the request is not a denial — the driver keeps replaying it.
      // It used to be a console warning under a ledger entry that said `denied`.
      const outcome = applyResearchDecision({ payload: rg, verdict: 'deny', effects: researchEffects });
      if (!outcome.applied) {
        auditDecisionApplied(sessionId, rg.decisionId!, 'failed', outcome.reason);
        console.error(`[research-grant] session=${safeSessionId(sessionId)} deny failed: ${outcome.reason}`);
        const failed = statusLang === 'zh'
          ? `没能撤回这个请求（${outcome.reason}）。后台研究可能还会再问，这张卡我先留着。`
          : `Could not withdraw the request (${outcome.reason}). Background research may ask again; the card stays open.`;
        messages.push({ role: 'assistant', content: failed });
        onDelta(failed);
        return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
      }
      pendingResearchGrants.delete(rg.decisionId!);
      pendingDecisions.resolve(sessionId, rg.decisionId!);
      auditDecisionApplied(sessionId, rg.decisionId!, 'denied', outcome.detail);
      onTrace?.({
        kind: 'auth-decision', tier: 4,
        text: `Denied background research use of ${rg.tool} (research ${rg.pursuitId})`,
        meta: { toolName: rg.tool },
      });
      const reply = statusLang === 'zh'
        ? `好的，已拒绝。后台研究不会使用 ${rg.tool}。`
        : `OK, denied. Background research will not use ${rg.tool}.`;
      messages.push({ role: 'assistant', content: reply });
      onDelta(reply);
      return { outcome: { outcomeType: 'response' }, auditEvents: audit.length };
    } else if (action === 'expired') {
      pendingResearchGrants.delete(rg.decisionId!); // stale pending; clear it and pass through
      pendingDecisions.resolve(sessionId, rg.decisionId!);
      auditDecisionApplied(sessionId, rg.decisionId!, 'expired', `${rg.tool} request timed out`);
    }
    // passthrough / expired: not consumed (or already cleared); pass through to normal turn (LLM sees pending-approval section)
  }

  // ── Check for pending askUserQuestion replies ──────────────────────────────────
  // Design mirrors pendingAuth: stores inflightMessages + remainingCalls; on resume,
  // wraps the user reply as a tool_result and injects it, then continues runToolLoop.
  const pendingQ = pendingQuestion.get(sessionId);
  pendingQuestionBlock: if (pendingQ && !claimedByAnotherDecision(signalBus)) {
    if (signalBus.bypassPendingQuestion) {
      memory.metrics.increment('pending.question_predates_card');
      console.warn(
        `[pending-question] session=${safeSessionId(sessionId)} inbound predates askUserQuestion card; ` +
          `keeping the question open and handling inbound as a normal request`,
      );
      break pendingQuestionBlock;
    }

    // Timeout: treat as "give up" — return a cancelled placeholder for the current tool_call + skip
    // remaining calls; let the LLM decide how to proceed based on history.
    if (Date.now() - pendingQ.createdAt > QUESTION_TTL_MS) {
      pendingQuestion.delete(sessionId);
      persistContinuation(sessionId);
      const cancelledResults = [
        ...pendingQ.collectedResults,
        {
          type: 'tool_result' as const,
          tool_use_id: pendingQ.toolCallId,
          content: '用户长时间未回复(已超时)。请基于已有信息继续或告知用户操作未完成。',
        },
        ...pendingQ.remainingCalls.map((c) => ({
          type: 'tool_result' as const,
          tool_use_id: c.id,
          content: '已跳过(前置 askUserQuestion 超时)',
        })),
      ];
      messages.push({ role: 'user', content: cancelledResults });
      // Treat the current user message as a new turn entry point; let the LLM continue on its own
      messages.push({ role: 'user', content: userMessage });
      const resp = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
      if (resp.type === 'text') {
        messages.push({ role: 'assistant', content: resp.content });
        onDelta(resp.content);
      }
      return { outcome: { outcomeType: 'question_timeout' }, auditEvents: audit.length };
    }

    const parsed = parseQuestionAnswer(
      userMessage,
      pendingQ.question,
      pendingQ.options,
      pendingQ.allowFreeText,
    );

    if (parsed.kind === 'reprompt') {
      // Parse failed → re-send the same question and put pending back to continue waiting
      onDelta(parsed.message);
      pendingQuestion.set(sessionId, pendingQ);
      persistContinuation(sessionId);
      return { outcome: { outcomeType: 'question_pending' }, auditEvents: 0 };
    }

    // option or freetext → treat the answer as a tool_result, continue runToolLoop
    const allResults = [
      ...pendingQ.collectedResults,
      {
        type: 'tool_result' as const,
        tool_use_id: pendingQ.toolCallId,
        content: parsed.content,
      },
    ];
    const resumed = await runToolLoop(
      sessionId, messages, grants, audit,
      pendingQ.remainingCalls,
      allResults,
      pendingQ.iteration,
      onDelta, onAuthRequest,
      signalBus, onStatus, onTrace, statusLang,
    );
    if (pendingQuestion.get(sessionId) === pendingQ) pendingQuestion.delete(sessionId);
    persistContinuation(sessionId);
    return resumed;
  }

  // ── Normal message: enter the tool call loop ────────────────────────────────────────────

  // P0.2: user message references past conversations (recall verbs + past-tense adverbs) → force a system section hint
  // that the agent must first call recall_sessions, rather than saying "I have no context" and pushing back to the user.
  // Injected at the end of the messages[0] system context section, not into the user-role slot.
  const retroHit = detectTimeRetrospectiveQuery(userMessage);
  if (retroHit && messages[0]) {
    messages[0] = {
      ...messages[0],
      content:
        messages[0].content +
        `\n\n## ⚠️ 用户在引用过去对话(命中"${retroHit.snippet}")` +
        `\n用户的当前消息引用了过往对话。请**立即调用 recall_sessions**` +
        `(query 用消息里的关键名词,limit=5)查清楚再回答。**不要**说"我看不到` +
        `之前的聊天记录"——你完全有 recall_sessions 工具可用,直接用。`,
    };
    internalAudit.append('self_domain_write', {
      source: 'recall_trigger',
      origin: 'Internal',
      toolName: 'recall_trigger_fired',
      sessionId,
      snippet: retroHit.snippet,
      userMessageLength: userMessage.length,
    });
    console.log(`[recall-trigger] session=${safeSessionId(sessionId)} matched "${retroHit.snippet}", injected proactive recall hint`);
  }

  // Phase 18 WS2: if the ViabilityGate recommended stop_and_report last turn and the user now EXPLICITLY accepts
  // stopping/reframing (and is not asking to continue), abandon the reasoning session. Counsel-only: any ambiguity
  // → leave it active (the gate will counsel again). This is the only place a viability stop closes the session.
  {
    const stopRec = viabilityStopRecommended.get(sessionId);
    if (stopRec) {
      const fresh = Date.now() - stopRec.at < VIABILITY_STOP_RECOMMEND_TTL_MS;
      const accepts = fresh && VIABILITY_ACCEPT_RE.test(userMessage) && !VIABILITY_CONTINUE_RE.test(userMessage);
      if (accepts) {
        try {
          memory.reasoning.setSessionStatus(stopRec.reasoningSessionId, 'abandoned');
          internalAudit.append('self_domain_write', {
            source: 'viability_gate',
            origin: 'Internal',
            toolName: 'viability_stop_accepted',
            sessionId,
            reasoningSessionId: stopRec.reasoningSessionId,
          });
          console.log(
            `[viability] session=${safeSessionId(sessionId)} user accepted stop → reasoning session ${stopRec.reasoningSessionId} abandoned`,
          );
        } catch (e) {
          console.warn('[viability] abandon-on-accept failed (ignored):', e);
        }
      }
      // Decision made (accept / continue / moved on) → clear the one-shot marker; gate re-arms next turn if still doomed.
      viabilityStopRecommended.delete(sessionId);
    }
  }

  // Short-answer binding: if the previous assistant message has an unclosed question, hint the LLM to treat
  // this turn's user message as a reply rather than a new topic. Injected into the system section (messages[0]), not the user slot.
  // Only triggers when messages[0] already exists (not the first turn where system is absent) and there is a preceding natural-language assistant message.
  const priorAssistant = findLastAssistantText(messages);
  // 2026-06-07: only bind when the user message is plausibly a SHORT ANSWER to the prior question.
  // detectUnclosedQuestion is structural (any trailing "?" on the assistant side) and topic-blind,
  // so a NEW user question got mis-bound to an unrelated prior one — e.g. the meta-question
  // "llm适配好了吗？" was bound to a prior "…GL(2) spectral theory?" math question. If the user
  // message is itself a question (ends with ?/？), it cannot be a short answer → skip binding.
  const userIsItselfAQuestion = /[?？]\s*$/.test(userMessage.trim());
  // A bare greeting/opener ("hi", "你好") resets the conversation — it is not answering the prior question
  // (prod: "hi" bound to a stale deep_explore "回复继续"). Skip binding for it.
  // …and a question the owner walks away from is not a live question. Production 2026-07-26: "继续" was
  // bound to a menu asked 12 hours 17 minutes earlier, across an overnight gap and a process restart —
  // the menu happened to offer philont self-maintenance, so the reply meant to continue the mathematics
  // was executed as maintenance, cancelling a schedule and pruning a skill from disk. Every binding that
  // ever worked in production fired within minutes. Age is checked from the stored message, not the
  // in-memory array, because a restart empties one and not the other.
  const bindingAgeMs = (() => {
    try {
      // By ORIGIN, not by session_id: every row lives in the 'global' bucket, so asking session_id
      // returns nothing and the age comes back as 56 years. Rows predating v40 have no origin and count
      // as this conversation's — an unknown age must not silently disable a working mechanism.
      return Date.now() - (memory.raw.lastMessageAtForOrigin(sessionId, 'assistant') ?? Date.now());
    } catch {
      return Number.POSITIVE_INFINITY; // unknown age → treat as stale; a missed hint beats a wrong one
    }
  })();
  const bindingFresh = bindingAgeMs <= SHORT_ANSWER_BINDING_TTL_MS;
  if (priorAssistant && messages[0] && !userIsItselfAQuestion && !isConversationOpener(userMessage)) {
    const detected = detectUnclosedQuestion(priorAssistant);
    if (detected.hasQuestion && !bindingFresh) {
      console.log(
        `[short-answer-binding] session=${safeSessionId(sessionId)} SKIPPED — the prior question is ` +
          `${Math.round(bindingAgeMs / 60000)} min old (limit ${Math.round(SHORT_ANSWER_BINDING_TTL_MS / 60000)}); ` +
          `treating this as a new message, not an answer`,
      );
    }
    if (detected.hasQuestion && bindingFresh) {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + renderBindingContext(detected.snippet, userMessage),
      };
      internalAudit.append('self_domain_write', {
        source: 'short_answer_binding',
        origin: 'Internal',
        toolName: 'short_answer_binding_fired',
        sessionId,
        priorQuestion: detected.snippet,
        userReplyLen: userMessage.length,
      });
      console.log(
        `[short-answer-binding] session=${safeSessionId(sessionId)} matched previous turn's question "${detected.snippet.slice(0, 40)}…", injected binding hint`,
      );
    }
  }

  // An approval that expired must be visible to the owner. This turn is a normal turn — the suspended
  // tool is gone and will not run — and the owner very likely just typed the approval for it.
  if (signalBus.droppedExpiredAuth && messages[0]) {
    const { toolName, ageMinutes } = signalBus.droppedExpiredAuth;
    messages[0] = {
      ...messages[0],
      content:
        messages[0].content +
        `\n\n## Expired authorization (mechanism notice)\n` +
        `The authorization request for \`${toolName}\` timed out (${ageMinutes} min old) and was discarded, so ` +
        `**the tool did not run**. If this message was the approval, say so in one line — that the request ` +
        `expired and you are re-requesting it — then re-issue the call. Do not silently answer something else, ` +
        `and do not claim the tool ran.\n`,
    };
    console.log(`[continuation] session=${safeSessionId(sessionId)} injected expired-auth notice for ${toolName}`);
  }

  // Routing rule injection: extract keywords from the user message → match top-K active rules → inject into system section.
  // No injection if 0 rules match (0 token impact). Zero matches are expected during early rule accumulation.
  if (messages[0]) {
    memory.metrics.increment('turn.total'); // instrumentation denominator: user turns where routing was evaluated
    const inj = buildRoutingInjection(userMessage, memory.routingRules);
    if (inj.matched > 0) {
      memory.metrics.increment('routing.inject.turns');
      memory.metrics.increment('routing.inject.rules', inj.matched);
      messages[0] = {
        ...messages[0],
        content: messages[0].content + inj.text,
      };
      // 2026-05-11: store matched rule ids in signalBus; at turn close, call recordRuleOutcome based on
      // this turn's outcome to feed back (Phase 3 closes the routing confidence state machine loop).
      signalBus.activeRuleIds = inj.ruleIds;
      internalAudit.append('self_domain_write', {
        source: 'routing_rule_injection',
        origin: 'Internal',
        toolName: 'routing_rules_injected',
        sessionId,
        ruleIds: inj.ruleIds,
        matched: inj.matched,
      });
      console.log(
        `[routing-inject] session=${safeSessionId(sessionId)} injected ${inj.matched} routing rules (ids=${inj.ruleIds.join(',')})`,
      );
    }
  }

  // task_pattern_hint (keyword-triggered hardcoded tool hints) removed 2026-05-07 —
  // replaced by planAndExecute (generic plan-then-execute composite tool); the system
  // prompt already has a section teaching the LLM to prefer it for complex tasks; keyword detection is unnecessary.

  // User dissatisfaction detection: user message contains obvious complaint / retry / negation signals → write task_failure_mode
  // audit; this turn is immediately hit by failure_recovery_inject below (same audit is immediately visible).
  // Detected via regex:
  //   - Chinese "still / again / not yet" + "success / no good / failed"
  //   - "you didn't before / you didn't follow up"
  //   - "retry / redo / redo from scratch / try a different method / this time"
  //   - "right or not / wrong / not like this / not what was asked"
  //   - "failed" single word
  // This is a soft-failure signal (user expressing dissatisfaction), different from task_pattern_hint keyword detection:
  // this is a strong signal of "user has already given failure feedback" and does not trigger spuriously.
  if (detectUserDissatisfaction(userMessage)) {
    internalAudit.append('task_failure_mode', {
      sessionId,
      kind: 'user_dissatisfaction',
      ts: Date.now(),
      detail: userMessage.slice(0, 100),
    });
  }

  // 2026-05-07 path 7: user responds with "learn/decline" → mark candidate state.
  // After confirm, injects a hint in the system section for the LLM to call skill-creator; decline marks as declined.
  try {
    const response = detectPatternConfirmation(userMessage);
    if (response.kind !== 'none') {
      const pending = listPendingPatterns(memory.facts);
      if (pending.length > 0) {
        // Find target candidate: use sig if present, otherwise take the most recent 1
        const target = response.signature
          ? pending.find((p) => p.signature === response.signature) ?? pending[0]
          : pending[0];
        if (response.kind === 'confirm') {
          markPatternStatus(memory.facts, target.signature, 'confirmed');
          internalAudit.append('self_domain_write', {
            source: 'user_pattern_confirmation',
            origin: 'External',
            toolName: 'pattern_confirmed',
            sessionId,
            signature: target.signature,
          });
          // Inject hint for the LLM to immediately call skill-creator, writing the candidate as SKILL.md
          if (messages[0]) {
            const c = target.candidate;
            messages[0] = {
              ...messages[0],
              content: messages[0].content +
                `\n\n## ✅ 用户确认学习模式 ${target.signature}\n` +
                `候选信息:\n` +
                `- 关键词: ${c.keywords.slice(0, 5).join(', ')}\n` +
                `- 工具序列: ${c.toolSequence.join(' → ') || '(无)'}\n` +
                `- 出现 ${c.occurrences} 次, 示例: ${c.examples.slice(0, 2).map((e) => `"${e.userMessage}"`).join(' / ')}\n\n` +
                `**本轮请**:\n` +
                `1. use_skill('skill-creator')\n` +
                `2. 按其指引把上述模式写成 SKILL.md(name = pattern-${target.signature})\n` +
                `3. 通过 installSkill 工具持久化\n` +
                `4. 告知用户已学完`,
            };
          }
          console.log(`[user-pattern] confirmed signature=${target.signature}`);
        } else {
          markPatternStatus(memory.facts, target.signature, 'declined');
          internalAudit.append('self_domain_write', {
            source: 'user_pattern_decline',
            origin: 'External',
            toolName: 'pattern_declined',
            sessionId,
            signature: target.signature,
          });
          console.log(`[user-pattern] declined signature=${target.signature}`);
        }
      }
    }
  } catch (e) {
    console.warn('[user-pattern] confirmation check failed, skipped', e);
  }

  // Doom-reset on user override (2026-06-17): if the gate had built up doom (a pivot streak, or reflection's
  // recommend_stop armed) and the user pushes FORWARD instead of accepting the stop, clear the accumulated
  // doom and anchor a fresh episode. Without this, same_root_cause / recommend_stop / the pivot ratchet
  // carried across the redirect, and the agent re-declared the same wall on a direction it had not run — prod
  // showed 8 "继续"s producing 0 executions, each met with another "撞了 6 次". Acceptance (算了/换框架) is
  // exempt: that confirms the stop. Placed before recommend_stop is consumed so the clear actually takes hold.
  let turnAnchors = { doomReset: false, commit: false, anchor: false };
  try {
    const hadDoom = (viabilityPivotStreak.get(sessionId) ?? 0) >= 1 || viabilityRecommendStop.has(sessionId);
    turnAnchors = decideTurnAnchors({
      lastAssistantText: lastAssistantText(messages),
      userMessage,
      hadDoom,
      promptIsReplay: isScheduledPromptReplay(sessionId, userMessage),
    });
    if (turnAnchors.doomReset) {
      // User overrode an accumulated stop (push-forward or a substantive redirect): clear the carried-over
      // doom and anchor a fresh episode so the next direction is judged on its own attempts, not the prior one.
      viabilityPivotStreak.delete(sessionId);
      viabilityRecommendStop.delete(sessionId);
      signalBus.recommendStop = false;
      episodeAnchorTs.set(sessionId, Date.now());
      console.log(
        `[viability] session=${safeSessionId(sessionId)} doom-reset on user override ("${userMessage.slice(0, 20)}") — fresh episode, accumulated stop signals cleared`,
      );
    }
  } catch (e) {
    console.warn('[viability] doom-reset check failed (ignored):', e);
  }

  // Phase 18 WS4: inherit reflection's persisted recommend_stop for this session (armed at last turn close). Sets
  // signalBus.recommendStop so the ViabilityGate later this turn scores it (+3). TTL-bounded; consumed lazily.
  {
    const rs = viabilityRecommendStop.get(sessionId);
    if (rs !== undefined) {
      if (Date.now() - rs < VIABILITY_RECOMMEND_STOP_TTL_MS) {
        signalBus.recommendStop = true;
      } else {
        viabilityRecommendStop.delete(sessionId);
      }
    }
  }

  // Failure recovery injection: if there is a task_failure_mode audit within the last 30 min for this session
  // (iter cap hit / turn deadline / LLM timeout / API error / reflection triggered /
  //  tool failure burst / user dissatisfaction) → inject a strong hint for the LLM to use planAndExecute
  // or searchSkills this turn rather than repeating the same mistake. Data-driven; zero false positives (only triggers after actually hitting a wall).
  if (messages[0]) {
    const recovery = buildFailureRecoveryInjection(internalAudit, sessionId, userMessage);
    if (recovery.matched) {
      messages[0] = {
        ...messages[0],
        content: messages[0].content + recovery.text,
      };
      internalAudit.append('failure_recovery_injected', {
        sessionId,
        failureCount: recovery.recentFailures.length,
        kinds: recovery.recentFailures.map((f) => f.kind),
      });
      console.log(
        `[failure-recovery] session=${safeSessionId(sessionId)} injected ${recovery.recentFailures.length} failure hints (kinds=${recovery.recentFailures.map((f) => f.kind).join(',')})`,
      );
    }
  }

  // Unattended-turn capability note: what this turn CAN do, stated before it picks a tool rather than after
  // it picks a forbidden one. See autonomousCapabilityNote.
  if (messages[0] && sessionId.startsWith('system:scheduled:')) {
    messages[0] = { ...messages[0], content: messages[0].content + autonomousCapabilityNote() };
    console.log(`[unattended-turn] session=${safeSessionId(sessionId)} injected capability note (appendJournal / store_note)`);
  }

  // Commit-to-execution + stay-on-target (2026-06-17). Two prompt anchors for the prod failures where the
  // agent (a) answered "继续" with another wall-report instead of running the proposed step, and (b) on a
  // redirect, substituted a previously-closed direction. Appended to the system prompt (messages[0]) like the
  // failure-recovery injection. env PHILONT_COMMIT_EXEC=0 disables.
  if (messages[0] && process.env.PHILONT_COMMIT_EXEC !== '0' && (turnAnchors.commit || turnAnchors.anchor)) {
    let addition = '';
    if (turnAnchors.commit) addition += COMMIT_TO_EXECUTION_DIRECTIVE;
    if (turnAnchors.anchor) addition += buildAntiSubstitutionDirective(userMessage);
    messages[0] = { ...messages[0], content: messages[0].content + addition };
    console.log(
      `[commit-exec] session=${safeSessionId(sessionId)} injected${turnAnchors.commit ? ' commit-to-execution' : ''}${turnAnchors.anchor ? ' stay-on-target' : ''}`,
    );
  }

  // Intent router: a deep_explore-routed turn gets a system-prefix nudge (START directly on explicit depth /
  // high confidence, else OFFER one line). Skipped when a reasoning session is already active for this owner
  // — the model continues that one, so we don't spawn duplicate sessions (the clutter fixed earlier).
  const intentDecision = signalBus.intentDecision ?? null;
  // Nudge only on the FORCE tier (first chance for the model to enter the engine itself; the
  // force backstop guarantees it either way). Ask tier already asked; direct tier runs flat by
  // the owner's decision; a declined ask must not re-nag.
  if (
    messages[0] &&
    intentDecision?.route === 'deep_explore' &&
    (deepExploreRouteTier(intentDecision) === 'force' || signalBus.exploreAskApproved) &&
    !signalBus.exploreAskDeclined &&
    !signalBus.selfReferentialMeta
  ) {
    // Suppress the nudge only when a session is RECENTLY active (the user is mid-exploration now), NOT when
    // any session merely exists — the user accumulates stale never-closed sessions, and a blanket "any
    // active" guard suppressed every nudge (the feature looked dead). Same recency guard as force-start.
    if (!hasRecentlyActiveExploreSession(sessionId)) {
      // START only once the owner has approved via the ask tier; otherwise the nudge merely OFFERS.
      const nudge = buildDeepExploreNudge(intentDecision, !!signalBus.exploreAskApproved);
      if (nudge) {
        messages[0] = { ...messages[0], content: messages[0].content + nudge };
        console.log(`[intent-router] session=${safeSessionId(sessionId)} injected deep_explore nudge (mode=${intentDecision.domain ?? 'deliberate'})`);
      }
    }
  }

  messages.push({ role: 'user', content: userMessage });

  // v7: drive runtime evaluation — let intrinsic-drives score and inject before user message is queued and LLM is called.
  // The triggered outcome will be fed back as this turn's observation (tool call success/failure + fact delta)
  // via afterTurn in the finally block, for SessionDriveReflector to score and tune parameters later.
  const turnStartTs = Date.now();
  const fired = driveRuntime.beforeTurn({
    sessionId,
    recentMessages: toRecentMessages(messages, 12),
    iteration: 0,
    activePursuits: memory.pursuits.listActive(BOOTSTRAP_ROOT_PURSUIT_ID),
    recentToolCalls: [],
  });
  if (fired.length === 0) {
    console.log(
      `[drive] session=${safeSessionId(sessionId)} 0 fired (evaluated ${driveRuntime.listEngines().length} engines)`,
    );
  } else {
    for (const f of fired) {
      // Flatten key snapshot fields into one line (fields differ per drive; JSON.stringify truncated to 200 chars)
      let snap = '';
      try {
        snap = JSON.stringify(f.triggerSnapshot).slice(0, 200);
      } catch {
        snap = '<unserializable>';
      }
      console.log(
        `[drive] session=${safeSessionId(sessionId)} FIRE ${f.driveId} utility=${f.utility.toFixed(2)} snapshot=${snap}`,
      );
    }
  }
  // K7.3 constitutional amendment: **never** push drive output to the user-role slot.
  // PDF→Word case revealed: LLM treated drive injection as a user question and kept doubling down when probed.
  // Root cause: drive output in user role + at tail position = LLM attention lock.
  //
  // New path: append all fires to the end of messages[0] ("system context"). The LLM can still
  // see the intrinsic-drive observation (influencing its response) but **will not treat it as user words**.
  // Also no longer sent to the frontend via onDelta (intrinsic drive is agent internal state and should not be visible as a conversation bubble).
  // Also no longer written to the raw timeline.
  if (fired.length > 0 && messages[0]) {
    const driveLines = ['', '## 内驱观察(本轮)'];
    for (const f of fired) {
      driveLines.push(`  · [${f.driveId}] ${f.injectedMessage}`);
    }
    messages[0] = {
      ...messages[0],
      content: messages[0].content + driveLines.join('\n'),
    };
  }

  try {
    // Compaction check: summarize the middle section when the message count is too large
    await maybeCompact(messages, sessionId);

    // ── Mechanism-driven plan–execute loop (docs/design/plan_execute_loop.md) ──────────────────
    // v1 entry: flag ON + intent route=plan + a guide URL (spec tier 1). The orchestrator owns the
    // turn: DRAFT → VERIFY(coverage vs guide) → REVISE(bounded) → EXECUTE(tool evidence per step)
    // → computed CLOSE. The model cannot skip VERIFY or self-declare completion — this is what
    // keeps the workflow intact on weak/edge models. Reaching this point = fresh turn (pending
    // resume paths returned earlier).
    // Scheduled/autonomous turns must NOT enter the mechanism loop: it owns the whole turn and returns
    // early, bypassing the legacy pipeline's schedule safety net (cross-turn-reflection, the credential/
    // heartbeat deliverable teaching, plan_knowledge cookbook, in-turn failure throttles). The loop is
    // for the USER-DRIVEN registration-style task; recurring heartbeats belong to the legacy path that
    // already handles them (prod: the loop hijacked scheduled turns and defanged the auto-pause breaker).
    const isScheduledTurn = sessionId.startsWith('system:scheduled:');
    if (!isScheduledTurn && planLoopEnabled() && signalBus.intentDecision?.route === 'plan') {
      const loopGuideUrl = userMessage.match(/https?:\/\/[^\s,;:'"<>()`，。；：、]+/)?.[0]?.replace(/[.,;:!?]+$/, '');
      if (loopGuideUrl) {
        console.log(`[plan-loop] session=${safeSessionId(sessionId)} entering mechanism loop (guide=${loopGuideUrl})`);
        const loopResult = await runPlanExecuteLoop(userMessage, [loopGuideUrl], {
          llm: miniLoopLLM,
          toolRunner: subTurnToolRunner,
          toolDefs: tools.list()
            .filter((t) => !PLAN_LOOP_BLACKLIST.has(t.name))
            .map((t) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.schema) })),
          toolBlacklist: PLAN_LOOP_BLACKLIST,
          // Input-aware classification (http POST → write:network) so the evidence criterion can
          // distinguish EXTERNAL actions from memory bookkeeping and reads.
          classifyCall: (name, input) => tools.classify(name, input) ?? undefined,
          // C: mechanism-written operational cookbook (legacy plan_knowledge, no longer dependent on
          // the model volunteering). Project name derived from the guide host (mycox.ai → mycox) —
          // matches the project scheduled sessions inherit, so their memory-prefix serves real
          // endpoints instead of letting a fresh session hunt (prod: 404/401 wall-loops).
          // ⑤ convergence: the loop drives the REAL plan store live. A mid-loop crash leaves an
          // `executing` plan → turn-end auto-close / cross-turn-reflection catch it like any other.
          planTracker: {
            create: (deliverables, steps, guideRef) => {
              try {
                const p = memory.plans.create({
                  sessionId,
                  taskSignature: `plan-loop-${quickTaskSignatureHash(userMessage)}`,
                  guideRef,
                  isPlaceholder: false,
                  deliverables: deliverables.map((d) => ({ id: d.id, description: d.description })),
                  steps: steps.map((st) => ({ id: st.id, description: st.description, covers: st.covers })),
                });
                return p.id;
              } catch (e) {
                console.warn('[plan-loop] live plan create failed (ignored):', (e as Error)?.message ?? e);
                return null;
              }
            },
            markStep: (planId, stepId, status, evidence) => {
              try { memory.plans.updateStep(planId, stepId, status, evidence ?? null); } catch { /* best-effort */ }
            },
            close: (planId, success, summary, statuses) => {
              try {
                memory.plans.close(planId, success ? 'success' : 'failure', summary, statuses);
                signalBus.planCloseCalled = true; // the loop closed its own plan — suppress auto-close fallback
              } catch (e) {
                console.warn('[plan-loop] live plan close failed — pipeline auto-close will catch it:', (e as Error)?.message ?? e);
              }
            },
          },
          recordOperationalKnowledge: (entries) => {
            try {
              const labels = new URL(loopGuideUrl).host.split('.').filter(Boolean);
              let i = 0;
              while (i < labels.length - 1 && /^(api|www|app)$/i.test(labels[i])) i++;
              const project = labels[i]?.toLowerCase().replace(/[^a-z0-9-]/g, '');
              if (!project || project.length < 2) return;
              for (const e of entries) memory.planFiles.appendKnowledge(project, e, 'endpoints');
            } catch (e) {
              console.warn('[plan-loop] cookbook write failed (ignored):', (e as Error)?.message ?? e);
            }
          },
          fetchGuide: async (url) => {
            const r = await subTurnToolRunner('webFetch', { url });
            if (!r.ok) return null;
            const parsed = parseWebFetchOutput(r.output);
            // Persist to the fetched-store like any webFetch (cache + "previously fetched" prefix).
            persistToolResultIfFetched(fetchedStore, {
              toolName: 'webFetch', params: { url }, success: true, output: r.output,
            }, { sessionId, excludeDirs: [memory.planFiles.baseDir] });
            return parsed?.body ?? null;
          },
          auxJudge: isAuxLLMConfigured()
            ? async (guideText, deliverables) => {
                try {
                  const req: AuxLLMRequest = {
                    system:
                      'Compare a plan against its guide. List guide requirements (mandatory actions of the flow ' +
                      'being asked for) NOT covered by any deliverable. Output ONLY JSON: {"gaps":["<one line each>"]} ' +
                      '(empty array when fully covered). Reference-only guide content is not a gap.',
                    user:
                      `# Guide\n${guideText.slice(0, 16_000)}\n\n# Deliverables\n` +
                      deliverables.map((d) => `- ${d.id}: ${d.description}`).join('\n'),
                    maxTokens: 500,
                    requireComplete: true,
                  };
                  const out = await callAuxLLM({ ...req, fallbackToMain: false });
                  const m = out.match(/\{[\s\S]*\}/);
                  if (!m) return null;
                  const parsed = JSON.parse(m[0]) as { gaps?: unknown };
                  return Array.isArray(parsed.gaps)
                    ? parsed.gaps.filter((g): g is string => typeof g === 'string').slice(0, 10)
                    : null;
                } catch {
                  return null; // degrade to deterministic-only, never block
                }
              }
            : undefined,
          // Spec compiler (spec_regime.md increment 1): guide → validated SpecDoc via the aux LLM,
          // regex anchor as floor/fallback. Absent aux config → pure regex path, unchanged.
          specCall: isAuxLLMConfigured()
            ? (req) => callAuxLLM({ ...req, fallbackToMain: false })
            : undefined,
          // Reuse a spec this service already compiled and installed, instead of recompiling every run.
          installedSpecFor: (hosts) => {
            const root = join(process.cwd(), '.philont', 'skills');
            for (const h of hosts) {
              const s = findSpecForHost(h, root);
              if (s) return s;
            }
            return null;
          },
          // Increment 3: the compiled contract lands as a normal FS skill (hot-reloaded by the
          // skills watcher; removed by the same uninstall/cleanup path as any other skill).
          emitServiceSkill: (spec, verifiedCalls) => {
            const r = writeServiceSkill(spec, verifiedCalls, join(process.cwd(), '.philont', 'skills'));
            console.log(`[plan-loop] service skill emitted: ${r.name} (${spec.endpoints.length} endpoints, ${verifiedCalls.length} verified calls)`);
            return { name: r.name };
          },
          log: (m) => console.log(m),
          // Cap forwarded progress messages at 2. WeChat limits how many bot messages one inbound
          // message may earn; the loop's ~10 per-state statuses exhausted that quota and the FINAL
          // report was rejected (sendText ret=-2 on a 59-char status and then on the report itself —
          // fast ~220ms rejections, i.e. quota, not size). Progress still goes to the log/trace.
          onStatus: (() => {
            let sent = 0;
            return (t: string) => { if (sent < 2) { sent++; onStatus?.(t); } };
          })(),
        });
        // ⑤: the plan record is now driven LIVE by the loop via planTracker (create at plan-final,
        // markStep during EXECUTE, close at CLOSE). Nothing retroactive to record here; if the
        // tracker close failed, the plan stays `executing` and the pipeline auto-close catches it.
        const finalText = `## For User\n${loopResult.reply}`;
        messages.push({ role: 'assistant', content: finalText });
        onDelta(finalText);
        memory.raw.appendMessage({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          role: 'assistant',
          content: finalText,
          originSessionId: sessionId,
        });
        return { outcome: { outcomeType: 'response', text: finalText }, auditEvents: audit.length };
      }
    }

    const response = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);

    if (response.type === 'text') {
      // Force deep_explore (mechanism, not prompt): if this turn is deep_explore-routed and depth was
      // wanted/approved but the model answered flat, synthesize a real deep_explore call and run it.
      // Shared with runToolLoop's terminal paths — see decideForcedDeepExploreCall for why.
      const forced = await decideForcedDeepExploreCall(sessionId, response.content, signalBus, turnStartTs);
      if (forced) {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: forced.id, name: forced.name, input: forced.input }] });
        return await runToolLoop(
          sessionId, messages, grants, audit,
          [forced],
          [], 0,
          onDelta, onAuthRequest, signalBus, onStatus, onTrace, statusLang,
        );
      }
      // ── Honesty gate on a ZERO-tool-call first response ──────────────────────────────────────────
      // runToolLoop's honesty gate only runs AFTER ≥1 tool call. A model that answers immediately with a
      // fabricated completion claim ("✅ 已删除 3 个技能" / "已注册" with no tool call) bypassed it entirely
      // (prod WeChat "删除豆瓣相关的自学习技能": tools=0, claimed deleted 3, no forget_skill, no [honesty] line).
      // Run the same gate here once per turn; on a high-severity fire, force a single regeneration — if the
      // model then actually calls a tool, route into runToolLoop; otherwise use the corrected text.
      let firstTextContent = response.content;
      if (!signalBus.firstTextHonestyChecked) {
        signalBus.firstTextHonestyChecked = true;
        const recentToolResults = extractRecentToolResults(messages);
        const skillDeleteSucceededThisTurn = (signalBus.inTurnRecords ?? []).some(
          (r) => r.success && (r.toolName === 'forget_skill' || r.toolName === 'uninstallSkill'),
        );
        const ownerReasoning = focusedReasoningSession(sessionId);
        const announceStallRaw = (process.env.PHILONT_HONESTY_ANNOUNCE ?? '').trim().toLowerCase();
        const announceStallEnabled = !(
          announceStallRaw === '0' || announceStallRaw === 'off' ||
          announceStallRaw === 'false' || announceStallRaw === 'no'
        );
        const honestySessionEnabled = process.env.PHILONT_HONESTY_SESSION !== '0';
        const honestyPatterns = evaluateHonesty(firstTextContent, {
          toolResults: recentToolResults,
          userMessage: signalBus.userMessage,
          reasoningState: ownerReasoning ? memory.reasoning.summarizeSession(ownerReasoning.id) : null,
          detectAnnouncementStall: announceStallEnabled,
          skillDeleteSucceededThisTurn,
          // Turn-durable: the zero-tool branch must not false-fire just because a gate reset the
          // per-iteration window (prod: replyWithMedia succeeded, gate still cried "ZERO tool calls").
          turnHadAnyToolCall: (signalBus.inTurnRecords ?? []).length > 0,
          session: honestySessionEnabled
            ? {
                unkeptRunPromise: honestySessionStore.get(sessionId).unkeptRunPromise,
                priorViolations: honestySessionStore.get(sessionId).violationCount,
                fabricatedExecClaim: honestySessionStore.get(sessionId).fabricatedExecClaim,
              }
            : undefined,
        });
        const honesty = honestyPatterns;
        // Fold this turn into the session latch. This site (the zero-tool first response) evaluated the gate
        // but NEVER wrote back — so a fabrication caught here armed nothing and did not even bump the
        // violation counter. The latch had a reader in one place and a writer in another, and they were not
        // connected: the same shape as every other defect this week.
        if (honestySessionEnabled) {
          honestySessionStore.update(sessionId, {
            promisedRun: !!findRunPromise(firstTextContent),
            didExecute: turnDidExecute(recentToolResults),
            fired: !!honesty,
            fabricatedExec: honesty?.reason === 'fabricated_execution_claim',
          });
        }
        if (honesty && honesty.severity === 'high') {
          signalBus.honesty = { evaluation: honesty, toolResults: recentToolResults, assistantText: firstTextContent };
          audit.append('self_domain_write', {
            source: 'honesty_gate',
            origin: 'Internal',
            toolName: 'honesty_gate_fired',
            sessionId,
            severity: honesty.severity,
            reason: honesty.reason,
            failCount: honesty.failCount,
            okCount: honesty.okCount,
            matchedClaim: honesty.matchedClaim,
          });
          recordControllerFire('honesty');
          console.warn(
            `[honesty] session=${safeSessionId(sessionId)} fired severity=${honesty.severity} reason=${honesty.reason} ` +
            `failCount=${honesty.failCount} okCount=${honesty.okCount} claim="${honesty.matchedClaim}" (zero-tool first response)`,
          );
          messages.push({ role: 'assistant', content: firstTextContent });
          pushGateDirective(
            messages,
              honesty.repeatOffense
                ? // REPEAT. The menu below is the mechanism that TAUGHT apologise-and-move-on: option B is a
                  // free exit — it costs nothing, satisfies the gate, and changes no behaviour, while the
                  // pressure that produced the fabrication (the user still wants a verified answer, nothing
                  // has run) is untouched. Same state next turn → same output. So on a repeat, B is removed:
                  // the only honest non-execution reply is a CONCRETE statement of incapacity, which an
                  // apology cannot satisfy.
                  `[drive Honesty/${honesty.reason}] ${honesty.evidence}\n\n` +
                  `**An apology is NOT an acceptable reply this time.** You already apologised for exactly this ` +
                  `earlier in this session and then did it again. Do ONE of these:\n` +
                  `  A · CALL an execution tool NOW in this reply (shell / pariGp / …) and report what it ` +
                  `actually returned — writing the command in prose or a Work Log is NOT calling it;\n` +
                  `  B · State CONCRETELY that you cannot run it, and WHAT is missing (which tool, which ` +
                  `environment, which credential). Name the blocker. "Sorry, I have not run it yet" is not a ` +
                  `blocker and will be rejected.\n` +
                  `Do not repeat the claim "${honesty.matchedClaim}" — no process ran, so there is no result to ` +
                  `report.${buildLanguageDirective(resolveResponseLanguage({ channel: sessionId, userLocale: readUserLanguage() }))}\n` +
                  INTERNAL_CORRECTION_FOOTER
                : `[drive Honesty/${honesty.reason}] ${honesty.evidence}\n\n` +
                  `**Do ONE of these in your reply — do not straddle**:\n` +
                  `  A · Actually perform it NOW by CALLING the tool (e.g. forget_skill / store_fact / shell) — ` +
                  `writing the call in a Work Log / prose is NOT calling it;\n` +
                  `  B · Correct yourself: tell the user honestly you have NOT done it yet.\n` +
                  `Do not repeat the claim "${honesty.matchedClaim}" unless a tool call THIS turn actually supports it.` +
                  `${buildLanguageDirective(resolveResponseLanguage({ channel: sessionId, userLocale: readUserLanguage() }))}\n` +
                  INTERNAL_CORRECTION_FOOTER,
          );
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: `Honesty gate triggered (${honesty.severity}) on zero-tool reply, regenerating`,
            meta: { gateName: 'Honesty', severity: honesty.severity },
          });
          const regen = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
          if (regen.type !== 'text') {
            // The model now actually calls a tool → run it through the normal loop (which also re-checks honesty).
            const sanitizedRegen = sanitizeAssistantMessageBlocks(regen.assistantMessage);
            messages.push(sanitizedRegen.msg);
            return await runToolLoop(
              sessionId, messages, grants, audit,
              regen.calls, [], 0,
              onDelta, onAuthRequest, signalBus, onStatus, onTrace, statusLang,
            );
          }
          firstTextContent = regen.content;
        } else if (!honesty) {
          console.log(`[honesty] session=${safeSessionId(sessionId)} passed (zero-tool first response)`);
        }

        // Claim grounding — the same chain the tool loop runs, and the reason this branch no longer
        // carries its own copies of the numeric and announced-tool gates (and previously lacked the
        // citation one entirely). One list, one regeneration, no per-exit subset.
        {
          const fired = await applyClaimGrounding({
            sessionId,
            text: firstTextContent,
            messages,
            toolNames: toolDefs.map((d) => d.name),
            audit,
            signalBus,
            ownerReasoningActive: !!ownerReasoning,
            onTrace,
          });
          if (fired) {
            const regen = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
            if (regen.type !== 'text') {
              // The model now actually calls a tool → run it through the normal loop.
              const sanitizedRegen = sanitizeAssistantMessageBlocks(regen.assistantMessage);
              messages.push(sanitizedRegen.msg);
              return await runToolLoop(
                sessionId, messages, grants, audit,
                regen.calls, [], 0,
                onDelta, onAuthRequest, signalBus, onStatus, onTrace, statusLang,
              );
            }
            firstTextContent = regen.content;
          }
        }
      }
      return emitFinalText({ sessionId, text: firstTextContent, messages, audit, signalBus, onDelta });
    }

    // 2026-05-07 #1 cont: tool_use.input in the assistantMessage returned by the LLM provider
    // is occasionally a string (multiple JSONs concatenated); pushing it directly into messages causes the next LLM call
    // to hit 400 Improperly formed request. Sanitize before pushing.
    const sanitizedAsst = sanitizeAssistantMessageBlocks(response.assistantMessage);
    if (sanitizedAsst.stats.fixed > 0 || sanitizedAsst.stats.rejected > 0) {
      console.warn(
        `[input-fix] assistantMessage tool_use blocks: total=${sanitizedAsst.stats.totalToolUse} ` +
          `fixed=${sanitizedAsst.stats.fixed} rejected=${sanitizedAsst.stats.rejected}`,
      );
    }
    messages.push(sanitizedAsst.msg);

    return await runToolLoop(
      sessionId, messages, grants, audit,
      response.calls, [], 0,
      onDelta, onAuthRequest,
      signalBus, onStatus, onTrace, statusLang,
    );
  } finally {
    // v7: drive triggered this turn → collect this turn's observation feedback and feed back to drive runtime.
    // The Reflector will later score the outcome's effectivenessScore, merge via EWMA,
    // and adjust drive_config parameters within constitution.driveBounds.
    let observations: ReturnType<typeof collectTurnObservations> | null = null;
    if (fired.length > 0) {
      try {
        observations = collectTurnObservations(sessionId, turnStartTs);
        driveRuntime.afterTurn(fired, observations);
      } catch (e) {
        console.warn('[drive] afterTurn failed:', e);
      }
    }

    // K7→K8 bridge: converts K7 reactive fire signals for this turn (TaskCommitment fired / honesty etc.)
    // into K8 InitiativeProposals and inserts them directly into the autonomousLoop's initiative queue.
    // The next autonomous tick will pick them up and run read-only tools
    // (webSearch / inspectPath / searchSkills etc.) to actually verify / leave audit notes,
    // patching the gap where "K7 injects advice to the LLM, but the LLM may not change anyway".
    //
    // Does not block the main path: all errors are swallowed and only logged.
    try {
      if (fired.length > 0 || signalBus.honesty) {
        const proposals = collectK7BridgeInitiatives({
          fired,
          honesty: signalBus.honesty
            ? {
                eval: signalBus.honesty.evaluation,
                toolResults: signalBus.honesty.toolResults,
                assistantText: signalBus.honesty.assistantText,
              }
            : undefined,
          observations: observations ?? { toolCalls: [] },
          recentDoneTargetRefs: autonomousLoop.initiatives.listDormantTargetRefs(),
          turnRef: `${sessionId}:${turnStartTs}`,
        });
        for (const p of proposals) {
          try {
            const inserted = autonomousLoop.initiatives.insert(p);
            internalAudit.append('self_domain_write', {
              source: 'k7_bridge',
              origin: 'Internal',
              toolName: 'k7_bridge_enqueued',
              sessionId,
              initiativeId: inserted.id,
              kind: p.kind,
              targetRef: p.targetRef,
              utility: p.utility,
            });
            console.log(
              `[k7-bridge] enqueued ${p.kind} (id=${inserted.id} util=${p.utility})`,
            );
          } catch (e) {
            console.warn('[k7-bridge] insert failed:', e);
          }
        }
      }
    } catch (e) {
      console.warn('[k7-bridge] collect failed, skipped:', e);
    }

    // Phase 9.2 M3 (2026-05-13): turn-close fallback — LLM did not explicitly call plan_close
    // but has an active plan (reviewed / executing / draft) + strong signal (honesty fired OR
    // sameRootCauseFailures ≥ 2) → mechanism layer automatically calls plan.close(failure).
    //
    // Fixes production mycox hole #2: LLM finishes tools and directly exits with outcome=response,
    // never calling plan_close → all outer loop close-time strict validation is dead code.
    // env PHILONT_PLAN_AUTO_CLOSE_ON_TURN_END=0 to disable.
    if (
      process.env.PHILONT_PLAN_AUTO_CLOSE_ON_TURN_END !== '0' &&
      !signalBus.planCloseCalled
    ) {
      try {
        const recentPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = recentPlans[0];
        if (
          lastPlan &&
          (lastPlan.status === 'draft' || lastPlan.status === 'executing')
        ) {
          let strongSignal: string | null = null;
          if (signalBus.honesty) {
            // A reporting correction does not establish that the work plan failed.
            // Preserve the active plan so the next turn can verify or repair its step.
            console.log(
              `[plan-lifecycle] session=${safeSessionId(sessionId)} honesty correction kept plan ${lastPlan.id} active`,
            );
          } else {
            try {
              // THIS TURN's failures only. The old global-24h window closed a healthy executing
              // plan on a turn with 32/32 tools OK because YESTERDAY's failures were still inside
              // the window (prod 2026-07-09 06:51) — and the failed plan state then made the gate
              // reject the session's compute tool. "This plan keeps hitting a wall" must be
              // evidenced by this plan's own execution.
              const turnFailures = (signalBus.inTurnRecords ?? [])
                .filter((r) => !r.success)
                .map((r) => ({
                  toolName: r.toolName,
                  result: r.resultText ?? null,
                  timestamp: Date.now(),
                }));
              const sameRoot = countSameRootCauseFailures(turnFailures);
              if (sameRoot >= 2) {
                strongSignal = `sameRootCauseFailures=${sameRoot} (this turn)`;
              }
            } catch {
              /* ignore */
            }
          }
          // 2026-05-13 / M3 Phase 11 (2026-05-15) second-layer fallback: plan still in draft state
          // = LLM never called plan_update_step(status='doing') to move the plan into
          // executing → treated as the protocol being bypassed (M3 state machine tightened: plan_protocol_gate
          // already blocks all non-protocol tools). Force close failure to prevent schedule infinite loops.
          if (!strongSignal && lastPlan.status === 'draft') {
            strongSignal = 'protocol_bypassed (plan in draft, never entered executing)';
          }
          if (strongSignal) {
            // M4 (2026-05-15): deliverable_status all marked not-attempted (mechanism-layer fallback)
            const allNotAttempted = Object.fromEntries(
              lastPlan.deliverables.map((d) => [d.id, 'not-attempted' as const]),
            );
            const closed = memory.plans.close(
              lastPlan.id,
              'failure',
              `[auto-close] turn 结束 LLM 未显式调 plan_close + ${strongSignal}`,
              allNotAttempted,
            );
            if (closed) {
              signalBus.planAutoClosedFailure = true;
              // auto-revise-on-fail flips TWO switches on a tool failure: fast→slow, and a placeholder
              // recovery plan. Closing the plan here undid one of them, and the leftover half is a trap.
              // Prod 2026-07-28 06:24→07:08: shell timed out → recovery plan (draft) + slow; the plan was
              // never promoted, so this block closed it as `failed`; from then on the gate answered every
              // shell call with "plan was closed as failed" — including shell, the one tool the recovery
              // existed for (autoRecoveryPlanScopeAllows deliberately does NOT exempt the scoped tool).
              // Nothing could execute, and forty minutes later the model reported 脚本运行成功 with the
              // gate holding every call. The honesty gate caught the lie; the state that made lying the
              // only available move was ours. A mechanism that sets two things must clear both.
              const recoveryTool = autoRecoveryScopedTool(lastPlan);
              if (recoveryTool) {
                taskModeStore.set(sessionId, 'fast', `auto:recovery-plan-abandoned:${recoveryTool}`);
                console.log(
                  `[plan-auto-close] session=${safeSessionId(sessionId)} recovery plan for ${recoveryTool} abandoned → mode restored to fast (the recovery attempt is over; do not keep the session locked for it)`,
                );
              }
              internalAudit.append('self_domain_write', {
                source: 'plan_auto_close_on_turn_end',
                origin: 'Internal',
                toolName: 'plan_auto_close_on_turn_end',
                sessionId,
                planId: lastPlan.id,
                previousStatus: lastPlan.status,
                strongSignal,
              });
              console.log(
                `[plan-auto-close] session=${safeSessionId(sessionId)} plan ${lastPlan.id} (was ${lastPlan.status}) → failed; trigger=${strongSignal}`,
              );
            }
          }
        }
      } catch (e) {
        console.warn('[plan-auto-close] failed, skipped:', e);
      }
    }
  }
}

// ── Tool execution loop (resumable from mid-point) ──────────────────────────────────────────────

/**
 * Accumulation container for K7 reactive signals within a single turn.
 *
 * runToolLoop writes to it when honesty/empty etc. gates fire; handleChatSendInner
 * reads it in the finally block and passes it to the K7→K8 bridge (collectK7BridgeInitiatives) to produce K8 initiatives.
 *
 * Not persisted; discarded at turn end. Multiple fires take **the most recent one** (each gate
 * has an attempts<1 cap within runToolLoop, firing at most once, so "most recent" == unique).
 */
/**
 * 2026-05-27: print a human-readable summary line at turn end, replacing the "waterfall of tool call logs".
 *
 * Gives ops / debuggers an at-a-glance view of:
 *   - How many tools were called this turn (total + read/write/execute breakdown)
 *   - How many succeeded and how many failed
 *   - Which tools failed (deduplicated)
 *   - The first error for failures (truncated to 60 chars)
 *
 * Not printed at per-tool-call granularity — those already go to onTrace / [tool] log lines.
 */
function summarizeTurnTools(records: InTurnToolRecord[]): string {
  if (!records.length) return 'tools=0';
  let ok = 0;
  let fail = 0;
  let read = 0;
  let write = 0;
  let exec = 0;
  const failedTools = new Set<string>();
  let firstError: string | null = null;
  for (const r of records) {
    if (r.success) {
      ok++;
    } else {
      fail++;
      failedTools.add(r.toolName);
      if (!firstError && r.resultText) {
        firstError = r.resultText.slice(0, 60).replace(/\s+/g, ' ');
      }
    }
    // Name-only on purpose: this is the turn-summary tally and inTurnRecords keep no params, so an
    // http POST counts as read here. A log line, not a decision — the gate is in createToolChecker.
    const c = tools.classify(r.toolName);
    if (c?.capability === 'read') read++;
    else if (c?.capability === 'write') write++;
    else if (c?.capability === 'execute') exec++;
  }
  const parts: string[] = [`tools=${records.length}`];
  parts.push(`ok=${ok}`);
  if (fail > 0) parts.push(`fail=${fail}`);
  parts.push(`(read=${read},write=${write},exec=${exec})`);
  if (failedTools.size > 0) {
    const list = [...failedTools].slice(0, 3).join(',');
    parts.push(`failed=[${list}${failedTools.size > 3 ? ',…' : ''}]`);
  }
  if (firstError) {
    parts.push(`firstErr="${firstError}"`);
  }
  return parts.join(' ');
}

/**
 * Render this turn's tool ledger as a compact, authoritative list — ✓ = real, citable result;
 * ⚠ = failed, produced NOTHING. Used inside the numeric-grounding directive (Stage B) so the regen
 * sees exactly what executed instead of narrating from memory (fabrication post-mortem 2026-06-22).
 *
 * NOTE: this is deliberately fed into an existing gate REMINDER rather than injected as a standalone
 * user message in the tool loop — a standalone string-content user message would be misread as the
 * turn boundary by extractRecentToolResults() and blind the honesty/numeric gates. Returns '' when
 * no tools have run.
 */
function renderTurnLedger(records: InTurnToolRecord[]): string {
  if (!records.length) return '';
  const lines: string[] = [];
  let idx = 0;
  for (const r of records) {
    idx++;
    const mark = r.success ? '✓' : '⚠';
    const excerpt = (r.resultText ?? '').slice(0, 140).replace(/\s+/g, ' ').trim();
    const tail = r.success
      ? excerpt ? ` → ${excerpt}` : ' → (ok, no output)'
      : ` → FAILED: ${excerpt || '(no error text)'}`;
    lines.push(`  ${mark} #${idx} ${r.toolName}${tail}`);
    if (idx >= 24) {
      lines.push(`  … (${records.length - idx} more)`);
      break;
    }
  }
  return lines.join('\n');
}

/**
 * S1 P1 — generation-time execution-ledger CONTRACT (anti-fabrication, structural prevention).
 *
 * The honesty gate is a post-hoc DETECTOR: it must enumerate phrasings ("成功编译", "53/53 pass", …) and
 * will always miss novel ones (that enumeration treadmill is why the fabrication problem recurs). This is
 * the PREVENTION layer and it is phrasing-agnostic: before each in-loop model call we append this turn's
 * REAL tool ledger + an explicit contract to the system context (messages[0]), so the model sees, while it
 * writes, that it only ran webSearch/webFetch (say) and therefore cannot claim it compiled/ran/tested
 * anything. The TileRT "compiled in my environment, Compile Tests 53/53 pass" lie is impossible to write
 * with the ledger in view.
 *
 * Injected into messages[0] (the system prefix, BEFORE turnStart) — the same slot every other dynamic
 * injection uses — so it is invisible to extractRecentToolResults and never blinds the honesty/numeric
 * gates. Replaced (not accumulated) each iteration via markers. Default ON; PHILONT_TURN_LEDGER_CONTRACT=
 * 0/off/false/no disables it and leaves messages byte-identical.
 */
export function turnLedgerContractEnabled(): boolean {
  const v = (process.env.PHILONT_TURN_LEDGER_CONTRACT ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

const TURN_LEDGER_MARK_START = '\n\n<<TURN_EXECUTION_LEDGER>>\n';
const TURN_LEDGER_MARK_END = '\n<</TURN_EXECUTION_LEDGER>>';

export function buildTurnLedgerContract(records: InTurnToolRecord[]): string {
  if (!records.length) return '';
  const didExec = turnDidExecute(records);
  const execNote = didExec
    ? ''
    : '\nNOTE: none of the tools above runs code / builds / installs / tests / computes — so THIS turn you ' +
      'have NOT compiled, run, tested, installed, reproduced, or computed anything.';
  return (
    '[THIS-TURN EXECUTION LEDGER — internal guardrail, read before you answer]\n' +
    'The ONLY operations you actually performed this turn (ground truth — real tool calls + their results):\n' +
    renderTurnLedger(records) +
    execNote +
    '\nCONTRACT 1/2 (do not fabricate): any claim that you RAN / BUILT / COMPILED / INSTALLED / TESTED / ' +
    'VERIFIED / REPRODUCED / COMPUTED something — and ANY concrete result you attribute to it (a pass count ' +
    'like "53/53 pass", a measured number, "succeeded", a toolchain or version) — MUST correspond to a real ' +
    'tool in the ledger above. If it is not there, you did not do it: say so plainly when it is germane.\n' +
    'CONTRACT 2/2 (but still ANSWER): this ledger is INTERNAL. Do NOT quote it, do NOT narrate "my research ' +
    'is all from webSearch", and do NOT re-litigate earlier turns or pre-emptively protest your own honesty — ' +
    'none of that answers the user. Lead with the question the user ACTUALLY asked, answered directly and ' +
    'concretely; webSearch / webFetch findings in the ledger ARE solid evidence, so commit to a concrete ' +
    'recommendation rather than deflecting with "should I try it?". Reserve "I could not run/compile/verify X ' +
    'here" for when it is genuinely germane — it is a valid answer, not a pre-emptive disclaimer to open with.\n' +
    // CONTRACT 3 exists because output_format was firing on FOUR OUT OF FIVE substantive turns
    // (2026-07-28: finalLen 1135 / 1141 / 1123 / 593, all `long_text_no_user_section`), and each fire
    // costs a full extra model call. A gate that fires most of the time is not a gate, it is a missing
    // instruction — and the instruction was not missing, it was STALE: the reply-format contract sits in
    // the system prefix, and by the time a long analytical turn writes its answer it is nineteen tool
    // calls and tens of thousands of tokens behind. The regenerated replies prove the model knows the
    // format; it just wrapped the same content correctly on the second pass.
    //
    // So the contract is restated in the block that is already rebuilt and re-injected on every
    // iteration, at the moment it is needed rather than once at the top. Detection stays as the backstop
    // it was meant to be; this is the prevention layer the ledger contract's own header describes.
    'CONTRACT 3/3 (the envelope): your final natural-language reply MUST open with a literal `## For User` ' +
    'heading and carry everything the user should read under it, followed by `## Work Log`. This holds no ' +
    'matter how long or how well-structured the answer is — a report full of `###` sections still needs ' +
    'the `## For User` envelope around it. WeChat and similar channels push ONLY that section; without the ' +
    'heading the whole draft is dumped as a fallback, and the mechanism layer will make you write it again.'
  );
}

/** Refresh (replace, never accumulate) the turn-ledger contract block inside messages[0] (system prefix). */
export function refreshTurnLedgerContract(messages: NativeMessage[], records: InTurnToolRecord[]): void {
  if (!turnLedgerContractEnabled()) return;
  const sys = messages[0];
  if (!sys || typeof sys.content !== 'string') return;
  let base = sys.content;
  const s = base.indexOf(TURN_LEDGER_MARK_START);
  if (s >= 0) {
    const e = base.indexOf(TURN_LEDGER_MARK_END, s);
    base = e >= 0 ? base.slice(0, s) + base.slice(e + TURN_LEDGER_MARK_END.length) : base.slice(0, s);
  }
  const block = buildTurnLedgerContract(records);
  messages[0] = { ...sys, content: block ? base + TURN_LEDGER_MARK_START + block + TURN_LEDGER_MARK_END : base };
}

/**
 * Is the user mid-exploration RIGHT NOW (a reasoning session for this owner touched within the last 20 min)?
 * Recency, not mere existence — the user accumulates stale never-closed sessions, and treating those as
 * "active" suppressed both the deep_explore nudge and the force-start (the feature looked dead). Shared by
 * both so they stay consistent.
 */
function hasRecentlyActiveExploreSession(sessionId: string): boolean {
  try {
    const RECENT_MS = 20 * 60 * 1000;
    const now = Date.now();
    return memory.reasoning
      .listActiveSessions()
      .some((s) => s.ownerSessionId === sessionId && now - s.updatedAt < RECENT_MS);
  } catch {
    return false; // reasoning store query failed — treat as "not mid-exploration" so the feature still fires
  }
}

/**
 * Derive a force-start goal for a SHORT context-dependent message ("重做深度调研" / "深入点") that refers back
 * to an earlier topic. messageIsSelfContainedGoal is false for these, so without this the force-start would
 * skip and the redo falls through to flat search (observed). A cheap aux call reads the recent transcript
 * and names the concrete topic being redone. Returns null when unconfigured / no context / no clear goal.
 */
/**
 * The goal a force-started deep_explore session should pursue — synthesized by the aux LLM from the
 * user's message PLUS the recent conversation, never transcribed by a length test.
 *
 * Production 2026-07-24 17:34: the owner sent "找别人的论文有什么用呢？即使复现也是在别人的路线上而且肯定
 * 没有解决问题。" — a CRITIQUE of the current approach (stop reproducing papers; attack the open problem
 * originally). The old fork asked messageIsSelfContainedGoal, a ≥12-char length proxy, which any Chinese
 * sentence passes — so force-start transcribed the rhetorical question verbatim as the session goal, and
 * the engine spent forty minutes earnestly researching the sociology of literature review (Merton, Kuhn,
 * "functions of reading papers") instead of returning to the Gyárfás problem with a new strategy. The
 * route was right; the GOAL took the owner's words literally. Length measures neither of the things that
 * matter here — whether the message stands alone, and whether it is a goal at all — so both questions go
 * to the aux LLM (the owner's standing rule: user intent is judged by a model, not by a pattern).
 *
 * Parsing note: UNSUITABLE is OUR enum consumed by exact match on our own output slot — allowed. The
 * message text itself is never pattern-matched.
 */
export async function synthesizeExploreGoal(
  sessionId: string,
  currentMessage: string,
  deps: {
    ask?: (req: { system: string; user: string; maxTokens: number }) => Promise<string | null>;
    configured?: boolean;
    transcript?: () => Array<{ role: string; content: string }>;
  } = {},
): Promise<string | null> {
  const msg = (currentMessage ?? '').trim();
  const verbatimFallback = messageIsSelfContainedGoal(msg) ? msg.slice(0, 2000) : null;
  const configured = deps.configured ?? isAuxLLMConfigured();
  if (!configured) return verbatimFallback; // pre-aux behavior: long → verbatim, short → no force-start
  let recent: Array<{ role: string; content: string }>;
  try {
    recent = (deps.transcript?.() ?? memory.raw.getMessages(sessionId).slice(-12)) as Array<{
      role: string;
      content: string;
    }>;
  } catch {
    return verbatimFallback;
  }
  const transcript = recent
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${String(m.content ?? '').slice(0, 300)}`)
    .join('\n');
  try {
    const raw = await (deps.ask ?? callAuxLLM)({
      system:
        'You determine what goal a deep reasoning session should pursue. Output only the goal, or the single word UNSUITABLE.',
      user:
        `The user's latest message:\n"${msg}"\n\nRecent conversation:\n${transcript || '(none)'}\n\n` +
        `Decide what the reasoning session should pursue:\n` +
        `1. If the latest message IS itself a complete, self-contained research goal, output it VERBATIM — ` +
        `do not paraphrase; mathematical or technical statements must not lose precision.\n` +
        `2. If it is a critique, redirection, or new constraint on work already underway in the conversation ` +
        `(e.g. questioning the current approach, "not X", "try an original route", "go deeper"), output ONE ` +
        `sentence stating the ONGOING task's goal updated with the user's new direction. The goal must be ` +
        `about the task, never about the user's sentence.\n` +
        `3. If it is a question about the assistant itself or its previous output, or there is no research ` +
        `goal at all, output exactly: UNSUITABLE\n` +
        `Output ONLY the goal (or UNSUITABLE) — no preamble, no quotes.`,
      maxTokens: 300,
    });
    const goal = (raw ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim().slice(0, 2000);
    if (/^UNSUITABLE\b/i.test(goal)) return null;
    if (goal.length < 12) return verbatimFallback;
    // ANCHORING. Length was the only check here, and length is precisely what cannot see the failure
    // that follows. Production 2026-07-25 23:06, one day after this function replaced a length test:
    // "还有其它方向可以尝试吗？" was synthesized into "探索其他可能的研究方向或解决方案。" — 18 characters, so it
    // passed, and it names NOTHING. No Gyárfás, no Goldbach, no object of study at all. The engine then
    // spent three minutes searching "how to find novel research directions" and "science slowdown publish
    // or perish", fetched an HBS piece on why good ideas get stuck in universities, and hung ZERO nodes —
    // the identical sociology-of-research detour this function was written to stop, arriving through the
    // function itself. Twenty minutes earlier the same engine, given a goal that named its object, produced
    // five candidates in one round.
    //
    // A real goal is anchored in the conversation: its subject was said out loud by someone. So require a
    // run of >= 4 characters shared with the transcript. This is a substring test on OUR OWN aux output
    // against real text — not semantic matching between languages, which is the thing that does not work.
    // Unanchored → no goal at all: answering flat and asking beats burning three minutes on a void.
    // Anchor against the current message TOO: case 1 (the message already IS the goal) echoes the user's
    // own words back, and those words are the most anchored text there is.
    const anchorText = `${transcript}\n${msg}`;
    if (anchorText.trim() && longestCommonRun(goal, anchorText) < 4) {
      console.warn(
        `[force-start] synthesized goal is not anchored in the conversation — refusing it: "${goal.slice(0, 60)}"`,
      );
      return null;
    }
    return goal;
  } catch {
    return verbatimFallback;
  }
}

/** Longest run of characters occurring in both strings. Character-level on purpose: word tokenisation
 *  is exactly what fails on Chinese, and this is comparing our own output against text we already hold. */
export function longestCommonRun(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (!x || !y) return 0;
  let prev = new Uint16Array(y.length + 1);
  let best = 0;
  for (let i = 1; i <= x.length; i++) {
    const cur = new Uint16Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** First not-done step id of a plan — concrete id for gate hints (the model has often never seen
 *  the real ids; an abstract `step_id` placeholder made it guess "step-1", prod 2026-07-07). */
function firstOpenStepId(plan: { steps: Array<{ id: string; status: string }> }): string {
  const open = plan.steps.find((st) => st.status !== 'done' && st.status !== 'skipped');
  return (open ?? plan.steps[0])?.id ?? 'step-1';
}

/**
 * Decide whether this turn must be FORCED into deep_explore, and return the synthesized call (or null).
 * Single source of truth for BOTH force-continue and force-start; sets the anti-reentry flags + logs.
 *
 * REACHABILITY (prod 2026-07-12 & 07-13 — the reason this is a shared helper and not inline):
 * the force checks used to live ONLY in handleChatSendInner's "the first LLM response was pure text"
 * branch. But the moment the model calls ANY tool, control enters runToolLoop and never returns there —
 * so the check was structurally unreachable for exactly the behaviour it exists to catch. A model that
 * ignores the deep_explore nudge and flat-searches necessarily opens with a tool call, so it ALWAYS
 * escaped. Observed twice: (a) the owner EXPLICITLY approved deep_explore via the ask tier, the model
 * opened with search_skills, and the turn then ran 22 flat webSearches and hit the 20-iteration cap —
 * engine never entered, approval silently ignored; (b) a "propose a new conjecture" task opened with
 * pariGp, hit the auth card, and after the resume ran 6 minutes of flat pariGp/shell and fabricated a
 * "Conjecture 1 disproved" claim. So the decision must be evaluated wherever the turn actually emits its
 * FINAL text: the flat-text branch, runToolLoop's natural text exit, AND runToolLoop's maxIterations
 * fallback (a flat-searching model reliably exits via that last one).
 */
async function decideForcedDeepExploreCall(
  sessionId: string,
  assistantText: string,
  signalBus: TurnSignalBus,
  idSeed: number,
): Promise<{ id: string; name: string; input: Record<string, unknown> } | null> {
  const deepExploreRanThisTurn = (signalBus.inTurnRecords ?? []).some((r) => r.toolName === 'deep_explore');

  // Force-CONTINUE: the model recited deep_explore round results with ZERO deep_explore calls this turn.
  if (
    deepExploreForceAdvanceEnabled() &&
    // A status/count question ("how many unfinished explores?") must never be forced into an advancing
    // round — narrating the saved snapshot is the correct answer, not a stall.
    !signalBus.userAsksExploreStatus &&
    shouldForceDeepExploreAdvance(assistantText, {
      alreadyForced: !!signalBus.forcedDeepExploreContinue,
      deepExploreRanThisTurn,
      hasActiveSession: memory.reasoning.getMostRecentActiveSession(sessionId) != null,
    })
  ) {
    signalBus.forcedDeepExploreContinue = true;
    console.warn(
      `[force-continue] session=${safeSessionId(sessionId)} model narrated deep_explore round results with 0 calls — forcing a real deep_explore(action=continue)`,
    );
    return { id: `forced-de-continue-${idSeed}`, name: 'deep_explore', input: { action: 'continue' } };
  }

  // Force-START. On a pending-auth resume the live userMessage is the bare "ok" that answered the auth
  // card, so goal / depth-signal / meta all run against the ORIGINAL message carried across the resume.
  const forceMessage = signalBus.carriedExploreGoal ?? signalBus.userMessage ?? '';
  const routeTier = deepExploreRouteTier(signalBus.intentDecision ?? null);
  const metaQuestion = isSelfReferentialMetaQuestion(forceMessage);
  // Depth is ESTABLISHED, never inferred. The owner's yes (ask tier) is the only entry — the keyword
  // bypass (userSignaledDepth) is deleted: it read "编排系统" as a depth request and force-started a
  // session nobody asked for, and it missed "花点时间好好琢磨" entirely. 'force' tier is unreachable
  // unless PHILONT_DEEP_EXPLORE_FORCE_CONF is explicitly lowered.
  const depthWanted =
    !signalBus.exploreAskDeclined && (routeTier === 'force' || !!signalBus.exploreAskApproved);
  const baseEligible =
    deepExploreForceStartEnabled() &&
    signalBus.intentDecision?.route === 'deep_explore' &&
    depthWanted &&
    !deepExploreRanThisTurn &&
    !signalBus.forcedDeepExploreStart &&
    !signalBus.forcedDeepExploreContinue &&
    !hasRecentlyActiveExploreSession(sessionId);
  // The goal is SYNTHESIZED (aux LLM over message + transcript), never transcribed by length: a long
  // critique of the current approach is not a goal, and a short "重做" names one. See synthesizeExploreGoal.
  const forceGoal = baseEligible ? await synthesizeExploreGoal(sessionId, forceMessage) : null;
  if (
    deepExploreForceStartEnabled() &&
    shouldForceDeepExploreStart({
      decision: signalBus.intentDecision ?? null,
      explicitDepth: depthWanted,
      tier: routeTier,
      approvedViaAsk: !!signalBus.exploreAskApproved,
      selfReferentialMeta: metaQuestion,
      goalSubstantial: !!forceGoal && forceGoal.trim().length >= 12,
      alreadyForcedStart: !!signalBus.forcedDeepExploreStart,
      alreadyForcedContinue: !!signalBus.forcedDeepExploreContinue,
      deepExploreRanThisTurn,
      // RECENCY, not mere existence: a stale never-closed session must not block a fresh dive.
      hasActiveSession: hasRecentlyActiveExploreSession(sessionId),
    })
  ) {
    signalBus.forcedDeepExploreStart = true;
    const forcedInput: Record<string, unknown> = buildForceStartInput(signalBus.intentDecision ?? null, forceGoal ?? forceMessage);
    if (signalBus.exploreAskAuto) forcedInput.autoAdvance = true;
    console.warn(
      `[force-start] session=${safeSessionId(sessionId)} deep_explore route + depth wanted but the turn answered flat — forcing deep_explore(action=start, mode=${forcedInput.mode ?? 'auto'})`,
    );
    return { id: `forced-de-start-${idSeed}`, name: 'deep_explore', input: forcedInput };
  }
  return null;
}

interface TurnSignalBus {
  /** Wire send time supplied by the channel; may precede receipt by an entire long agent turn. */
  inboundSentAtMs?: number;
  authInboundDisposition?: PendingAuthInboundDisposition;
  bypassPendingQuestion?: boolean;
  honesty?: {
    evaluation: HonestyEvaluation;
    toolResults: Array<{ toolName: string; content: string; toolInput?: Record<string, unknown> }>;
    assistantText: string;
  };
  /**
   * The tool_use id the user explicitly approved via the pending-auth card this turn. That exact
   * call bypasses the plan_protocol_gate on resume (approval outranks the plan state machine).
   */
  authApprovedCallId?: string;
  /** The user message that opened this turn (for correction-aware honesty branches). */
  userMessage?: string;
  /**
   * Skill names the aux selector judged relevant to THIS turn, in its order. Computed before the
   * (synchronous) prefix build and read by the skill funnel. Absent = no opinion, keep the lexical
   * ranking. See skill_relevance_llm.
   */
  skillRelevanceNames?: string[];
  /**
   * Tools this turn tried to call and the autonomous-turn blacklist rejected. Feeds the
   * unsatisfiable-goal detector: a scheduled task whose goal needs a tool it can never call fails
   * identically forever, and nothing used to say so out loud.
   */
  blockedTools?: Set<string>;
  /** Ask-tier deep_explore: the owner approved entering the engine for the restored goal this turn. */
  exploreAskApproved?: boolean;
  /** The owner selected the visible "自动持续" ask-tier choice. */
  exploreAskAuto?: boolean;
  /** Ask-tier deep_explore: the owner declined — run flat, do not re-ask or force this turn. */
  exploreAskDeclined?: boolean;
  /**
   * WS5 (selfhood_closure): the skill most recently retrieved via use_skill this turn. Subsequent
   * tool actions are logged with linkedSkill=this name, which is what lets the reflector attribute
   * their success/failure to the recipe and run reuse verification (recordLinkedSkillOutcomes).
   */
  activeSkillName?: string;
  /** Aux-LLM intent route for this turn (computed in handleChatSend, read in handleChatSendInner for the deep_explore nudge). */
  intentDecision?: IntentDecision | null;
  /**
   * Pending-auth resume only: the ORIGINAL user message that opened the turn (this turn's userMessage is
   * the bare "ok" answering the auth card). force-start uses it as the session goal — "ok" is neither a
   * self-contained goal nor a depth signal, so without these the resumed turn cannot force-start. See carriedIntent.
   */
  carriedExploreGoal?: string;
  /**
   * Set when this turn began by throwing away an authorization request that had timed out. The owner
   * typed something that may well have been the approval; the tool did not run and will not run. The
   * turn must SAY so rather than silently answering something else — an approval that vanishes without
   * a word is how the same "OK" gets typed twice (prod 2026-08-09 12:43:29 → 12:43:50).
   */
  droppedExpiredAuth?: { toolName: string; ageMinutes: number };
  /**
   * The one decision this message was addressed to, settled at entry by exact means. At most one per
   * message: once a module claims it, no other may reinterpret the same sentence.
   */
  resolvedDecisionId?: string;
  /** What the reply said once the addressing tokens were stripped — the part that decides. */
  resolvedVerdictText?: string;
  /**
   * A tool that was mid-execution when the process died and never got an explicit retry/skip decision.
   * Recorded as unresolved — NOT as a user refusal. Anything downstream that reasons about what the
   * owner decided must be able to tell those apart.
   */
  unresolvedToolCall?: { toolName: string; reason: 'no_explicit_decision' };
  /**
   * Cleanup-turn scoping (2026-07-06): set when the user message is a pure cleanup command
   * (looksLikeCleanupIntent). runToolLoop then mechanism-rejects external write http for the whole
   * turn (prod: clear turns drifted into re-registering the service being cleared), and matching
   * schedules were soft-paused at turn start so they can't race the deletion.
   */
  cleanupIntent?: { targets: string[] } | null;
  /** Set once when the forced-continue mechanism has injected a real deep_explore(continue) this turn (anti-reentry). */
  forcedDeepExploreContinue?: boolean;
  /** Set once when the forced-START mechanism has injected a real deep_explore(start) this turn (anti-reentry). */
  forcedDeepExploreStart?: boolean;
  /** The user message is a meta-question about the agent itself (isSelfReferentialMetaQuestion). */
  selfReferentialMeta?: boolean;
  /**
   * This turn's user message is a STATUS/COUNT/LIST query about deep_explore ("how many unfinished
   * explores", "状态/进度") rather than a request to advance. Suppresses force-continue (a status question
   * must not be hijacked into a 6-min advancing round) and the fabrication gate (reporting the saved
   * snapshot IS the correct answer to a status question, not a faked round). Set in handleChatSendInner.
   */
  userAsksExploreStatus?: boolean;
  /**
   * Wall-clock start of this turn (Date.now() at handleChatSendInner entry). Used by plan_protocol_gate to
   * tell a terminal plan CLOSED THIS TURN (a same-turn follow-up — auto-fast is fine) from a STALE terminal
   * plan left by a PRIOR task (must not auto-downgrade a new slow task → that would bypass the protocol).
   */
  turnStartedAt?: number;
  /**
   * Total critical+high+normal count from InterruptDrainer.drain() this turn.
   * Updated by buildMemoryPrefix at drain time. ≥ 1 is treated as interruptDrained.
   */
  interruptDrainedCount?: number;
  /**
   * 2026-05-11: list of rule IDs that routing_inject matched and injected this turn.
   * At turn close, calls recordRuleOutcome based on this turn's outcome (strong success/failure signal) to feed back,
   * making the routing_rules 5-tier confidence state machine actually live (previously had 0 callers).
   */
  activeRuleIds?: number[];
  /** 2026-05-11: EmptyConclusionGate fire that occurred this turn (feeds back strong failure signal) */
  emptyConclusionFired?: boolean;
  /**
   * Stage A (2026-06-22 anti-fabrication): the numeric-grounding gate forced the reply away from
   * reporting unbacked computed values toward an honest "could not verify" framing. Used at final
   * emit to label the turn `could_not_verify` — a first-class HONEST outcome (like stop_and_report),
   * NOT a failure — so admitting "I couldn't verify" is a sanctioned way to end a turn rather than a
   * penalized one. Removing that penalty is what removes the pressure to fabricate.
   */
  couldNotVerify?: boolean;
  /**
   * Phase 9.2 M1 (2026-05-13): whether the LLM has explicitly called plan_close this turn.
   * Written back by markPlanCloseCalled at the plan_close.execute entry point.
   * Turn-close fallback (M3) uses this to determine "whether an active plan needs auto-close".
   */
  planCloseCalled?: boolean;
  /**
   * 2026-05-15: mechanism-layer "forced demotion" signals for this turn (passed to turn-close to compute turnDegraded,
   * which is forwarded to reflection_runner so reflection takes the negative distillation path and rejects new_skill/skill_refine).
   *
   * These signals indicate the turn did not end normally with the LLM giving a conclusion; instead it was caught by mechanisms:
   *   - planCircuitBroken: plan_* tools repeatedly failed, triggering circuit-breaker to force fast mode
   *   - inTurnToolBlockFired: same-root-cause failures ≥ threshold triggered in-turn-tool-block to disable tools
   *   - planAutoClosedFailure: turn-end turn-close fallback automatically closed plan with failure
   */
  planCircuitBroken?: boolean;
  inTurnToolBlockFired?: boolean;
  planAutoClosedFailure?: boolean;
  /**
   * Phase 12 cont (2026-05-17): full tool call trace within the turn.
   * runToolLoop pushes one entry at each tool execution point; at handleChatSend turn close,
   * if sessionId is a scheduled session, summarizes and writes to ScheduleOutcomeStore.
   * Multiple runToolLoop calls within a single turn (auth resume / question resume) share the same array.
   */
  inTurnRecords?: InTurnToolRecord[];
  /**
   * 2026-07-01: the honesty gate on a ZERO-tool-call first response has run this turn (cap 1 regen). The
   * runToolLoop gate only sees post-tool-call text; a model that answers immediately with a fabricated
   * completion claim (e.g. "✅ 已删除 3 个技能" with no forget_skill call) bypassed honesty entirely. Set
   * once the first-text gate fires + forces its single regeneration.
   */
  firstTextHonestyChecked?: boolean;
  /**
   * Phase 18 (2026-06-15) WS4: reflection emitted a recommend_stop verdict for this owner session on a
   * prior turn (persisted, read pre-LLM this turn). Arms the ViabilityGate score (+3). undefined = no signal.
   */
  recommendStop?: boolean;
}

/** True when a tool call would advance a deep_explore round (the expensive ~15-min mini-loop), vs read-only status/finalize. */
function isDeepExploreAdvance(call: { name: string; input: unknown }): boolean {
  if (call.name !== 'deep_explore') return false;
  const action = String((call.input as { action?: unknown } | null)?.action ?? '');
  return action === 'start' || action === 'continue' || action === 'discover';
}
const DEEP_EXPLORE_ONE_ROUND_MSG =
  'Each turn advances deep_explore by at most one round (~15 min) to stay under the turn time limit. ' +
  'This turn already ran one round and saved the tree. Tell the user the round is done and to reply "continue" ' +
  'to advance the next round in a fresh turn — do NOT call deep_explore(start/continue/discover) again this turn. ' +
  'IMPORTANT: this blocked call did NOT run a round — when summarizing, count ONLY the one round that actually ran ' +
  '(do not report blocked attempts as extra rounds).';

/**
 * 2026-06-08: anti-fabrication gate (mechanism layer — prompt-level guidance kept failing).
 * Observed: on "继续"/"启动" the model returns text (tools=0, ~15s) that INVENTS a deep_explore
 * round result from the saved-snapshot numbers — "第N轮 / 时间帽 / x开→y开 / 已启动 session <id>" —
 * presenting fake math progress as real. These markers can only be TRUE if deep_explore actually
 * ran this turn. So: if the response claims them AND no deep_explore tool ran this turn → it's
 * fabrication; replace with an honest message. A response that DID call deep_explore (calledDeepExplore)
 * is never gated — a real round legitimately reports "第N轮…". Markers are deliberately specific
 * (round/session events), not generic words like 死胡同/已证, to avoid false-positives on summaries.
 */
const DEEP_EXPLORE_FABRICATION_RE =
  /时间帽|第\s*\d+\s*轮|\d+\s*开\s*(?:→|->|—>)\s*\d+\s*开|已启动[^。\n]{0,40}session\s*[0-9a-fA-F][0-9a-fA-F-]{5,}|(?:session|deep[\s_-]?explore)[^.\n]{0,30}\badvanced\b|\badvanced\b[^.\n]{0,15}(?:one\s+)?(?:more\s+)?rounds?\b|\bcontinue\s+advanced\b|\b\d+\s+proved\b[^.\n]{0,15}\bopen\b|\bproved\s*[=:]\s*\d+|\bcheck\s+(?:the\s+)?status[^.\n]{0,24}(?:then\s+|and\s+)?(?:advance|continue)\b/i;
const DEEP_EXPLORE_FABRICATION_REPLY =
  '## For User\n' +
  '我这一回合并没有真正运行 deep_explore——"第N轮 / 已证 / 时间帽 / x开→y开 / 已启动 session" 这类是**已保存的状态快照,不是这次跑出来的**。' +
  '要真正推进,请回复"继续",我会**实际调用 deep_explore 跑一轮**(约需数分钟);要看当前真实进度,我去调 deep_explore(action=status)。\n\n' +
  '## Work Log\n' +
  '[fabrication-gate] 本回合未实际调用 deep_explore 却声称了回合/会话结果 → 已拦截并替换为如实说明。';

/** Returns the safe outgoing text: if it fabricates deep_explore progress (claims a round/session result with no deep_explore call this turn), replace it with an honest message. */
function guardDeepExploreFabrication(
  text: string,
  signalBus: TurnSignalBus,
  sessionId: string | null,
): string {
  const calledDeepExplore = (signalBus.inTurnRecords ?? []).some((r) => r.toolName === 'deep_explore');
  // A status/count question was asked → reporting the saved snapshot ("2 proved / 17 open") IS the answer,
  // not a faked round; don't replace it. (force-continue is suppressed for the same case.)
  if (signalBus.userAsksExploreStatus) return text;
  if (calledDeepExplore || !DEEP_EXPLORE_FABRICATION_RE.test(text)) return text;
  // 2026-07-21: no active reasoning session ⇒ no saved snapshot to recite ⇒ a marker match cannot be
  // the fabrication this guard exists to catch. Force-continue already carried this premise
  // (shouldForceDeepExploreAdvance's hasActiveSession); the two rewrite paths did not, so 第N轮 in a
  // numbered scheduled routine ("第25轮签到") replaced the entire real report with the boilerplate below
  // — prod 2026-07-21, replyText 1820b → 274b, the user lost the check-in result five runs running.
  // This guard REPLACES the reply, so its misfire is maximally destructive: it must be the conservative one.
  try {
    if (memory.reasoning.getMostRecentActiveSession(sessionId) == null) return text;
  } catch {
    return text; // lookup failure → never blank a reply on a premise we could not substantiate
  }
  console.warn(
    '[fabrication-gate] blocked fabricated deep_explore progress (response claimed round/session results but no deep_explore call this turn)',
  );
  return DEEP_EXPLORE_FABRICATION_REPLY;
}

/**
 * 2026-06-26: forced-continue mechanism (the structural fix the rewrite-only fabrication-gate could not
 * give). When the model recites deep_explore round results without running a round (the "继续" stall),
 * the gate above could only swap the text for an honest deflection — which loops ("继续 → 请回复继续 →
 * 继续 …"). Prompt directives (COMMIT_TO_EXECUTION_DIRECTIVE) also kept failing. So instead of asking the
 * model again, the harness GUARANTEES a real deep_explore(action=continue) runs this turn (see the call
 * site). Default ON (env via web-ui); PHILONT_DEEP_EXPLORE_FORCE_CONTINUE=0/off/false/no disables.
 */
function deepExploreForceAdvanceEnabled(): boolean {
  const v = (process.env.PHILONT_DEEP_EXPLORE_FORCE_CONTINUE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/**
 * True when the user's message is a STATUS / COUNT / LIST query ABOUT deep_explore — asking what state
 * the exploration(s) are in, not asking to advance one. Requires BOTH an explore reference AND a
 * status/count/list cue (so "继续" / "深入研究X" never match). Used to stop force-continue from hijacking a
 * "how many unfinished explores?" question into a 6-minute advancing round, and to let the model answer
 * such a question from the (per-turn-refreshed) session snapshot instead of being blocked by the
 * fabrication gate. Reporting saved state in answer to a status question is correct, not a faked round.
 */
const EXPLORE_REF_RE = /deep[\s_-]?explore|探索|推演|reasoning\s+session|exploration/i;
const EXPLORE_STATUS_CUE_RE =
  /多少|几个|哪些|列(?:表|出|一下)|清单|进度|状态|到哪了?|未结[束完]|没结[束完]|还(?:有|剩|在)|在跑|运行中|开着|挂着|how\s+many|status|progress|\blist\b|which|running|still\s+open|in\s+progress/i;
export function userAsksExploreStatus(message: string): boolean {
  return EXPLORE_REF_RE.test(message) && EXPLORE_STATUS_CUE_RE.test(message);
}

/**
 * Pure decision for the forced-continue mechanism. Forcing is warranted only when the model's text
 * narrates deep_explore round/session results (DEEP_EXPLORE_FABRICATION_RE) yet it did NOT call
 * deep_explore this turn — the recite-without-running stall — AND forcing is safe: not already forced
 * this turn, no deep_explore advanced this turn, and an active session exists to continue.
 */
export function shouldForceDeepExploreAdvance(
  text: string,
  ctx: { alreadyForced: boolean; deepExploreRanThisTurn: boolean; hasActiveSession: boolean },
): boolean {
  if (ctx.alreadyForced || ctx.deepExploreRanThisTurn || !ctx.hasActiveSession) return false;
  return DEEP_EXPLORE_FABRICATION_RE.test(text);
}

/**
 * Force-tier deep_explore turns must not be captured by the plan protocol (prod 2026-07-09: the
 * first KV-cache turn was routed force-tier, but the model opened with task_mode_classify(slow) →
 * plan gate took over → the force-start mechanism, which only evaluates on a text response, never
 * ran → the research went flat). On such turns a task_mode_classify(slow) call is mechanically
 * rejected with a redirect to deep_explore(start); slow mode is never set, so the plan gate never
 * engages and the harness force-start stays reachable if the model still answers flat.
 */
function forceTierClassifyRedirect(
  call: { name: string; input: Record<string, unknown> },
  signalBus: TurnSignalBus,
): string | null {
  if (call.name !== 'task_mode_classify') return null;
  if ((call.input as { mode?: unknown })?.mode !== 'slow') return null;
  const decision = signalBus.intentDecision ?? null;
  if (decision?.route !== 'deep_explore') return null;
  const forceTier = deepExploreRouteTier(decision) === 'force' || !!signalBus.exploreAskApproved;
  if (!forceTier) return null;
  if (signalBus.selfReferentialMeta) return null; // meta-question turns are not explore turns
  if (signalBus.forcedDeepExploreStart || signalBus.forcedDeepExploreContinue) return null;
  return (
    `[intent_router] task_mode_classify(slow) is disabled for this turn: the intent router already ` +
    `routed it to deep_explore (confidence ${decision.confidence}). Open exploration/research goes ` +
    `through deep_explore's own decompose→verify protocol — it is exempt from the plan gate, and ` +
    `wrapping it in a plan would flatten the research.

` +
    `Call deep_explore({ action: "start", goal: "<the user's research goal>" }) now. ` +
    `If this really is an EXECUTION task (deploy/register/send/write external data), reply in text ` +
    `explaining why and the harness will not force-start.`
  );
}

/**
 * The single application point for the claim-grounding chain (see claim_grounding.ts).
 *
 * Evaluates the chain against the text about to be emitted and, on a fire, does everything that used to
 * be copy-pasted per gate per exit: audit row, controller fire count, console line, the assistant +
 * directive message pair, the trace event, and the two flags a rule can arm. Returns true when the
 * caller must regenerate.
 *
 * The caller keeps ownership of HOW it regenerates, because that genuinely differs: the tool loop
 * `continue`s, the zero-tool branch calls the model directly and may hand off to the tool loop. What must
 * NOT differ — which rules run, in what order, with what side effects — now lives in one place.
 */
async function applyClaimGrounding(opts: {
  sessionId: string;
  text: string;
  messages: NativeMessage[];
  toolNames: readonly string[];
  audit: AuditLog;
  signalBus: TurnSignalBus;
  ownerReasoningActive: boolean;
  onTrace?: TraceFn;
}): Promise<boolean> {
  const { sessionId, text, messages, audit, signalBus, onTrace } = opts;
  let finding: ClaimGroundingFinding | null = null;
  try {
    finding = await evaluateClaimGrounding({
      text,
      toolResults: extractRecentToolResults(messages),
      messages,
      toolNames: opts.toolNames,
      calledToolNames: (signalBus.inTurnRecords ?? []).map((r) => r.toolName),
      hasActiveReasoningSession: opts.ownerReasoningActive,
      deepExploreSucceededThisTurn: (signalBus.inTurnRecords ?? []).some(
        (r) => r.success && r.toolName === 'deep_explore',
      ),
      renderedLedger: renderTurnLedger(signalBus.inTurnRecords ?? []),
    });
  } catch (e) {
    console.warn('[claim-grounding] chain failed (ignored):', (e as Error)?.message);
    return false;
  }
  if (!finding) return false;
  // A log-only observation (the announced-tool window that found no verdict) is reported and dropped:
  // the window exists so a miss is readable rather than silent.
  console.warn(`[${finding.rule}] session=${safeSessionId(sessionId)} ${finding.log}`);
  if (!isGroundingFire(finding)) return false;

  audit.append('self_domain_write', {
    source: `claim_grounding:${finding.rule}`,
    origin: 'Internal',
    toolName: `${finding.rule}_fired`,
    sessionId,
    ...finding.audit,
  });
  recordControllerFire(finding.rule === 'session_claim' ? 'honesty' : finding.rule);
  if (finding.armsCouldNotVerify) signalBus.couldNotVerify = true;
  if (finding.armsHonestyLatch && process.env.PHILONT_HONESTY_SESSION !== '0') {
    // Preserved from when this rule WAS an honesty verdict: it must still bump the violation counter
    // that removes the apology exit on a repeat offence.
    honestySessionStore.update(sessionId, {
      promisedRun: false,
      didExecute: turnDidExecute(extractRecentToolResults(messages)),
      fired: true,
    });
  }
  messages.push({ role: 'assistant', content: text });
  pushGateDirective(messages, finding.directive);
  onTrace?.({
    kind: 'internal-gate',
    tier: 4,
    text: `Claim-grounding rule ${finding.rule} fired, regenerating`,
    meta: { gateName: finding.rule },
  });
  return true;
}

/**
 * The single way a turn delivers its final text.
 *
 * There were three copies of this ritual — the zero-tool first response, the tool loop's natural text
 * exit, and the maxIterations fallback — and they had drifted, silently, in the way copies do:
 *
 *   · the maxIterations copy once omitted onDelta, so its summary reached nobody; the comment left at
 *     that site is the scar.
 *   · it still omitted the assistant message push, so the transcript ended without the reply in it.
 *   · and the OUTCOME LABEL was computed at the tool-loop exit only. The numeric-grounding rule arms
 *     `signalBus.couldNotVerify` on every exit, and steering a turn into an honest "I could not verify
 *     this" is exactly what that flag is for — but on two of the three exits the flag was armed and then
 *     never read, so the turn was reported as an ordinary successful `response`. Prod 2026-07-28
 *     07:09:52 fired the rule on the zero-tool path and closed `outcome=response`, while the identical
 *     fire inside the tool loop closed `outcome=could_not_verify`. The learning judge and the daily
 *     health report both read that label, so half the honest non-answers were being counted as answers.
 *
 * Three copies of an eight-line ritual is how that happens. There is one now, and adding a step to it
 * cannot reach only two exits.
 */
function emitFinalText(opts: {
  sessionId: string;
  text: string;
  messages: NativeMessage[];
  audit: AuditLog;
  signalBus: TurnSignalBus;
  onDelta: (text: string) => void;
  /** Tool-loop only: a viability stop is its own deliberate concede and outranks could_not_verify. */
  viabilityStop?: { pending: boolean; reasoningSessionId?: string | null };
}): { outcome: { outcomeType: string; text: string }; auditEvents: number } {
  const { sessionId, messages, audit, signalBus, onDelta } = opts;
  // Anti-fabrication backstop: replace a fabricated deep_explore recite with an honest message before
  // it goes out, whichever exit produced it.
  const safeText = guardDeepExploreFabrication(opts.text, signalBus, sessionId);
  // An ordinary reply while cards are outstanding gets a nudge — one line, no re-offer of the words
  // that would make it a second card competing for the next message. This is the "user sent a normal
  // message" trigger of the digest; nothing is consumed and nothing is re-asked.
  // The book no longer holds anything that was resolved this turn, so it IS the outstanding set.
  // Filtering out `resolvedDecisionId` on top of that used to be harmless and now hides a real card:
  // a message can address a decision without answering it, and that decision is still waiting.
  const stillWaiting = pendingDecisions.list(sessionId);
  const withTail =
    stillWaiting.length > 0
      ? safeText +
        renderPendingTail(
          stillWaiting,
          resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }) === 'en' ? 'en' : 'zh',
        )
      : safeText;
  messages.push({ role: 'assistant', content: withTail });
  // Invariant: onDelta BEFORE returning outcome.text — the frontend treats a final `outcome=response`
  // as "already delivered via the delta stream" and stays silent otherwise.
  onDelta(withTail);
  memory.raw.appendMessage({
    sessionId: GLOBAL_TIMELINE_SESSION_ID,
    role: 'assistant',
    content: withTail,
    originSessionId: sessionId,
  });

  // Phase 18 WS2: stop_and_report is a first-class WINNABLE outcome (honest no-go + banked lemmas +
  // recommended reframe), not a failure. Counsel-only — the reasoning session is NOT auto-abandoned;
  // it stays resumable, and the next turn closes it iff the user explicitly accepts stopping.
  if (opts.viabilityStop?.pending && opts.viabilityStop.reasoningSessionId) {
    viabilityStopRecommended.set(sessionId, {
      reasoningSessionId: opts.viabilityStop.reasoningSessionId,
      at: Date.now(),
    });
  }
  const outcomeType = resolveFinalOutcomeType({
    viabilityStopPending: opts.viabilityStop?.pending === true,
    couldNotVerify: signalBus.couldNotVerify === true,
    inTurnRecords: signalBus.inTurnRecords ?? [],
  });
  return { outcome: { outcomeType, text: safeText }, auditEvents: audit.length };
}

/** Tools whose SUCCESS means the turn really did compute something. */
const OUTCOME_COMPUTE_TOOLS = ['pariGp', 'z3Verify', 'leanCheck', 'magnitude', 'shell', 'process'];

/**
 * How a delivered turn is LABELLED. Pure, so the one rule that used to exist at one of three exits can
 * be pinned by tests rather than by whichever exit a reader happens to open.
 *
 * `stop_and_report` outranks everything: a viability stop is a deliberate concede with banked results,
 * not a failure to verify. `could_not_verify` is the honest non-answer the numeric-grounding rule steers
 * a turn into — but only when no compute tool actually succeeded, since a turn that DID compute and then
 * hedged about something else is an ordinary response.
 */
export function resolveFinalOutcomeType(input: {
  viabilityStopPending: boolean;
  couldNotVerify: boolean;
  inTurnRecords: ReadonlyArray<{ toolName: string; success: boolean }>;
}): 'stop_and_report' | 'could_not_verify' | 'response' {
  if (input.viabilityStopPending) return 'stop_and_report';
  const okCompute = input.inTurnRecords.some(
    (r) => r.success && OUTCOME_COMPUTE_TOOLS.includes(r.toolName),
  );
  return input.couldNotVerify && !okCompute ? 'could_not_verify' : 'response';
}

async function runToolLoop(
  sessionId: string,
  messages: NativeMessage[],
  grants: GrantStore,
  audit: AuditLog,
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  collectedResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>,
  startIteration: number,
  onDelta: (text: string) => void,
  onAuthRequest: (req: AuthRequest) => void,
  signalBus: TurnSignalBus,
  onStatus?: (text: string) => void,
  onTrace?: TraceFn,
  statusLang: PhraseLang = 'en',
): Promise<{ outcome: { outcomeType: string; text?: string; reason?: string }; auditEvents: number }> {

  // A LEARNED RULE THAT ONLY REACHES THE PROMPT IS ADVICE, NOT LEARNING.
  //
  // The rule for the top failure signature was already stored, already printed in the tool's own error
  // text, and already injected — and the same signature failed 38 times in the week of 2026-08-22. So
  // once a rule exists for a mechanical failure, the mechanism applies it itself and re-runs the tool,
  // instead of asking the model to remember. The tool is the verifier; nothing below knows what any
  // tool's arguments mean. One attempt per signature per turn, and only signatures that already have a
  // rule — a repairer that guesses is how a learning layer poisons itself.
  const repairAttemptedSignatures = new Set<string>();
  const failedSignaturesThisTurn = new Set<string>();
  const maybeMechanicalRepair = async (
    call: { name: string; input: Record<string, unknown> },
    failed: ToolResult,
  ): Promise<{
    result: ToolResult;
    notice: string;
    originalFailure?: ToolResult;
    repairedInput?: Record<string, unknown>;
  }> => {
    if (failed.success) return { result: failed, notice: '' };
    const errorText = failed.error ?? failed.output ?? '';
    const signature = extractFailureSignature(call.name, errorText);
    if (!signature || !isMechanicalFailure(signature)) return { result: failed, notice: '' };
    const rules = [
      ...authoringCheatsheet(signature).filter((l) => l.trim()),
      ...learnedCheatsheet(signature, memory.facts),
    ];
    // The one honest effect metric: a signature recurring AFTER its rule was known. Counted whether or
    // not a repair runs, so "we learned it and it kept happening" stays visible either way — and split,
    // because the two halves have different culprits. Within one turn the model already has the error
    // text in front of it and submitted another variant anyway; across turns the stored rule did not
    // survive the trip into the next prompt. A single mixed bucket (the shape of `pariGp:gp-other ×38`)
    // can prove neither.
    const bucket = classifyRecurrence(rules.length > 0, failedSignaturesThisTurn.has(signature));
    if (bucket) memory.metrics.increment(recurrenceMetricKey(bucket));
    failedSignaturesThisTurn.add(signature);
    // Measurement runs whether or not repair is armed — otherwise the flag-off period has no baseline
    // to compare the flag-on period against, and "did this help?" stays unanswerable in exactly the way
    // that produced the question.
    if (!mechanicalRepairEnabled()) return { result: failed, notice: '' };
    if (repairAttemptedSignatures.has(signature)) return { result: failed, notice: '' };
    // The failed model call itself is about to consume one slot below. A mechanism-initiated retry is
    // a second real tool execution and may run only when another slot remains.
    if (totalToolCallsThisTurn + 1 >= effectiveMax) {
      console.log(`[auto-repair] session=${safeSessionId(sessionId)} ${signature} skipped (tool-budget-exhausted)`);
      return { result: failed, notice: '' };
    }
    repairAttemptedSignatures.add(signature);
    try {
      const outcome = await attemptMechanicalRepair({
        signature,
        toolName: call.name,
        toolInput: call.input,
        errorText,
        rules,
        facts: memory.facts,
        // A REWRITE IS A DIFFERENT CALL THAN THE ONE THAT WAS APPROVED.
        //
        // So the rewritten arguments go back through the same checker the model's own call passed —
        // matrix, grants, validator chain, path ACL, command gate — rather than through a hand-picked
        // predicate. Denied means no repair, not a repair that failed: the rule is not charged for it.
        isSafeToRerun: async (input) =>
          (await checker({ toolName: call.name, approval: 'never', params: JSON.stringify(input) })) === null,
        // Re-authorized immediately above by checker() on these exact arguments (see isSafeToRerun).
        run: (input) => {
          totalToolCallsThisTurn++;
          return tools.execute(call.name, input);
        },
      });
      if (!outcome.attempted || !outcome.result) {
        if (outcome.reason && outcome.reason !== 'disabled' && outcome.reason !== 'no-rule') {
          console.log(`[auto-repair] session=${safeSessionId(sessionId)} ${signature} skipped (${outcome.reason})`);
        }
        return { result: failed, notice: '' };
      }
      memory.metrics.increment('learning.repair.applied');
      const repairedError = outcome.result.error ?? outcome.result.output ?? '';
      const transition = classifyRepairTransition({
        beforeSignature: signature,
        afterSuccess: outcome.result.success,
        afterSignature: outcome.result.success
          ? undefined
          : extractFailureSignature(call.name, repairedError),
      });
      memory.metrics.increment(`learning.repair.${transition}`);
      // Preserve the old aggregate only for a demonstrated no-op. A changed failure is progress;
      // timeout/cancellation is unscorable rather than negative evidence.
      if (transition === 'no_effect') memory.metrics.increment('learning.repair.failed');
      console.log(
        `[auto-repair] session=${safeSessionId(sessionId)} ${signature} ` +
          `${transition} ` +
          `(applied=${outcome.stats?.applied ?? 0} verified=${outcome.stats?.verified ?? 0})`,
      );
      // Built field by field, not spread over the failure: a spread leaves the old `error` string
      // standing on a now-successful result, and every downstream reader of `error` would see a turn
      // that both succeeded and failed.
      return {
        result: {
          success: outcome.result.success,
          output: outcome.result.output ?? '',
          error: outcome.result.success ? undefined : outcome.result.error,
          duration: failed.duration,
        },
        notice: renderRepairNotice(call.name, rules, outcome.verified === true),
        originalFailure: failed,
        repairedInput: outcome.repairedInput,
      };
    } catch (e) {
      console.warn(`[auto-repair] ${signature} threw (ignored):`, (e as Error)?.message);
      return { result: failed, notice: '' };
    }
  };

  // THE INPUT IS PART OF THE AUTHORIZATION DECISION, SO THE DECIDER HAS TO SEE IT.
  //
  // This lambda dropped its second argument. createToolChecker passes the parsed params in — that is
  // the whole reason ToolRegistry.classify takes them — and every tool with a dynamic classify() was
  // therefore judged by its STATIC declaration instead.
  //
  // For `http` and `securedHttp` the static declaration is read × network, which the default matrix
  // permits outright. Their classify() exists precisely to say that POST/PUT/PATCH/DELETE are
  // write × network, which the matrix denies. So every external write this agent has ever made over
  // http — registering an account, posting content, calling someone's webhook — was authorized as if
  // it were a page fetch, and no approval card was ever raised for it. The dynamic classifier was
  // written, tested, and never consulted at the one call site that decides anything.
  //
  // runToolLoop was already fixed to classify with input; this is the half that gates.
  const checker = createToolChecker({
    permissions,
    audit,
    classifyTool: (name, params) => tools.classify(name, params),
    grantStore: grants,
    validatorChain: conservativeValidatorChain,
  });

  // Phase 10 (2026-05-14): take cap based on task mode. Snapshot at entry to avoid mid-turn mode changes
  // causing cap jumps (bad UX if LLM sees N/X warning and then X changes).
  const effectiveMax = effectiveMaxIter(sessionId);

  const toolResults = [...collectedResults];
  // EmptyConclusionGate: accumulated tool call count across the entire runToolLoop.
  // collectedResults already includes tool_results executed before the resume (auth resume case); counted first.
  let totalToolCallsThisTurn = collectedResults.length;
  // 2026-06-08: at most ONE advancing deep_explore round per turn. A single 15-min round fits under
  // the 20-min turn hard deadline, but the model would chain a 2nd round in the same turn ("reply
  // continue" → it calls deep_explore(continue) again) → 2×15min > 20min → TurnDeadlineError ("抱歉
  // 出错"). Counter is runToolLoop-scoped (= one chat turn); read-only actions (status/finalize)
  // don't count. Autonomous ticks don't go through runToolLoop, so they're unaffected.
  let deepExploreAdvancesThisTurn = 0;

  // 2026-05-10: in-turn failure pattern detector uses this turn-internal tool call trace.
  // Pushes one entry after each tool execution (success or fail); detectInTurnFailurePattern
  // scans for same-root-cause failures ≥ threshold → injects "reflect rather than retry" hint.
  //
  // 2026-05-17 Phase 12 cont: shared into signalBus; used as ScheduleOutcomeStore data source
  // at handleChatSend turn close (scheduled sessions automatically capture outcome).
  // Multiple runToolLoop entries via auth/question resume share the same array; trace is not lost.
  signalBus.inTurnRecords = signalBus.inTurnRecords ?? [];
  const inTurnRecords = signalBus.inTurnRecords;

  const isAutonomousTurn = sessionId.startsWith('system:scheduled:');

  // Interrupt teeth (2026-05-29): this turn was stopped by the user (UserHardStop) → exit early at each iteration /
  // tool boundary. In-flight LLM calls are cancelled via signal passed to HTTP (see
  // sendLlmWithRescue); these boundary checks handle the "stalled between tool calls / before next LLM call" scenario.
  const stopped = () => turnAbortSignal(sessionId)?.aborted === true;
  const interruptedReturn = () => ({
    outcome: { outcomeType: 'interrupted' as const, reason: 'user_stop', text:
            resolvePhraseLang({ channel: sessionId, userLocale: readUserLanguage() }) === 'en'
              ? 'Stopped'
              : '已停止' },
    auditEvents: audit.length,
  });
  if (stopped()) return interruptedReturn();

  for (const call of calls) {
    if (stopped()) return interruptedReturn();
    // Input is part of the authorization decision. Normalize and validate it BEFORE classification/
    // policy checking so malformed calls can never create a reusable grant or a poisoned pending state.
    const prepared = sanitizeToolInput(call.input);
    const requiredCheck = prepared.input
      ? validateRequiredToolInput(prepared.input, tools.get(call.name)?.schema)
      : { valid: false as const, reason: prepared.reason ?? 'invalid tool input' };
    if (!prepared.input || !requiredCheck.valid) {
      const detail = requiredCheck.valid ? 'invalid tool input' : requiredCheck.reason;
      const reason = `tool input format error, blocked before authorization: ${detail}`;
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: reason });
      totalToolCallsThisTurn++;
      inTurnRecords.push({ toolName: call.name, success: false, resultText: reason });
      console.warn(`[tool] ${call.name} → pre-auth input rejected: ${detail}`);
      continue;
    }
    call.input = prepared.input;
    const classification = tools.classify(call.name, call.input);

    // 2026-05-10: autonomous turn blacklist interception. Return failure as tool_result; the LLM
    // adapts to this turn's constraint without interrupting the turn (unlike auth_pending which halts the entire schedule).
    if (isAutonomousTurn && AUTONOMOUS_TURN_BLACKLIST.has(call.name)) {
      const reason = autonomousBlacklistReason(call.name);
      (signalBus.blockedTools ??= new Set()).add(call.name);
      console.warn(
        `[autonomous-blacklist] session=${safeSessionId(sessionId)} rejected ${call.name}`,
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: reason,
      });
      totalToolCallsThisTurn++;
      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        params: call.input,
        result: 'rejected_by_autonomous_blacklist',
        success: false,
      });
      audit.append('self_domain_write', {
        source: 'autonomous_blacklist',
        origin: 'Internal',
        toolName: 'autonomous_tool_blocked',
        sessionId,
        blockedTool: call.name,
      });
      continue;
    }
    if (!classification) {
      toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: Unknown tool '${call.name}'` });
      totalToolCallsThisTurn++;
      continue;
    }

    {
      const redirect = forceTierClassifyRedirect(call, signalBus);
      if (redirect) {
        console.warn(`[intent-router] session=${safeSessionId(sessionId)} rejected task_mode_classify(slow) on force-tier deep_explore turn`);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: redirect });
        totalToolCallsThisTurn++;
        inTurnRecords.push({ toolName: call.name, success: false, resultText: redirect });
        continue;
      }
    }

    // 2026-05-13 constitutional amendment bug: plan_protocol_gate previously only checked in secondary iter (line ~4452)
    // → all tools in the first iter were let through; LLM's first response could bypass the entire plan
    // protocol (production mycox: webFetch 200 passed + then fabricated "complete"). Added first iter check.
    // Logic is an exact mirror of secondary iter; shares the same semantics.
    //
    // Phase 12 (2026-05-17): allowance rules changed to 3×4 capability/domain (see isPlanGateExempt).
    // read any domain + write×self are allowed; webFetch / readFile /
    // search_skills / store_fact etc. required by LLM before writing a plan are no longer erroneously blocked by the gate.
    //
    // 2026-05-14 debug: added trace log to investigate suspicion of auth_pending resume path bypassing gate
    // (enable with PHILONT_PLAN_GATE_TRACE=1).
    {
      const mode = taskModeStore.get(sessionId);
      const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
      const lastPlan = sessionPlans[0];
      const exempt = isPlanGateExempt(call.name, classification, call.input);
      if (process.env.PHILONT_PLAN_GATE_TRACE === '1') {
        console.log(
          `[plan-gate-trace][first-iter] tool=${call.name} mode=${mode} plan=${lastPlan?.id ?? 'none'} planStatus=${lastPlan?.status ?? 'none'} reviewCount=${lastPlan?.reviewHistory.length ?? 0} exempt=${exempt}`,
        );
      }
    }
    if (taskModeStore.get(sessionId) === 'slow') {
      const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
      const lastPlan = sessionPlans[0];
      // M3 / Phase 11 (2026-05-15) tightened: only 'executing' allows execution-type tools.
      // 'draft' still rejects (forces LLM to call plan_update_step status='doing' to enter executing).
      // Phase 18 (2026-06-16): a TERMINAL plan (completed/failed) closed THIS turn is a finished task — a
      // same-turn follow-up tool call should not be forced through a full re-plan (that thrash polluted the
      // viability/same_root_cause signal). Auto-downgrade to fast for those.
      // 2026-06-30 fix: that bypass must NOT leak across tasks. A terminal plan left by a PRIOR turn is STALE;
      // if it downgraded a genuinely NEW slow task to fast, the whole plan protocol is skipped (observed:
      // mycox register/post ran in fast mode — no plan_draft/review/revise → guide MUST-items silently dropped).
      // So only treat terminal as "no active plan" when it was closed during the current turn.
      const terminalClosedThisTurn = terminalPlanClosedThisTurn(lastPlan?.status, lastPlan?.updatedAt, signalBus.turnStartedAt);
      if (terminalClosedThisTurn) {
        taskModeStore.set(sessionId, 'fast', `auto:terminal-plan:${lastPlan!.status}`);
        console.log(
          `[plan_protocol_gate] session=${safeSessionId(sessionId)} terminal plan ${lastPlan!.id} (${lastPlan!.status}) closed this turn → auto fast, ${call.name} allowed[first-iter]`,
        );
      }
      const planAllowsExec = lastPlan?.status === 'executing';
      const needsPlanReview = !planAllowsExec && !terminalClosedThisTurn;
      // A call the user JUST approved via the auth card is exempt: re-blocking it punishes the
      // approval and (prod 2026-07-07 09:06) left a narrated "sent" with nothing sent.
      const exempt = isPlanGateExempt(call.name, classification, call.input) ||
        signalBus.authApprovedCallId === call.id;
      // A recovery plan for X must not confiscate Y — see autoRecoveryScopedTool.
      const recoveryScoped = needsPlanReview && !exempt && autoRecoveryPlanScopeAllows(lastPlan, call.name);
      if (recoveryScoped) {
        console.log(
          `[plan_protocol_gate] session=${safeSessionId(sessionId)} auto-recovery plan (${lastPlan!.guideRef}) is scoped to its failing tool — ${call.name} allowed[first-iter]`,
        );
      }
      if (needsPlanReview && !exempt && !recoveryScoped) {
        const baseReason = !lastPlan
          ? `slow 模式下尚未调 plan_draft 拆解任务。`
          : lastPlan.status === 'draft'
            ? `plan ${lastPlan.id} 状态 draft(${lastPlan.steps.length} 步,尚未开始执行)。`
            : lastPlan.status === 'failed'
              ? `plan ${lastPlan.id} 已 close=failed。这个 plan 已弃,但本任务未完成 — 需要新 plan_draft 接续。`
              : lastPlan.status === 'completed'
                ? `plan ${lastPlan.id} 已 close=completed。如果你要做新任务,先 plan_draft 拆步;别直接跑工具。`
                : `plan ${lastPlan.id} 状态 ${lastPlan.status} 不在允许执行集合(executing)。`;
        const planStateHint = !lastPlan
          ? 'plan_draft({deliverables, steps, task_signature, guide_ref}) — 创建 plan'
          : lastPlan.isPlaceholder
            ? `plan_revise({plan_id:"${lastPlan.id}", new_steps, new_deliverables, reason}) — 转正占位 plan(必须提供 new_deliverables)`
            : lastPlan.status === 'draft'
              ? `plan_update_step({plan_id:"${lastPlan.id}", step_id:"${firstOpenStepId(lastPlan)}", status:"doing"}) — 开始执行第一步`
              : lastPlan.status === 'completed' || lastPlan.status === 'failed'
                // A STALE terminal plan cannot be revised (plans.revise rejects completed/failed) and
                // cannot be closed again. Telling the model to plan_revise it is a dead end — the gate
                // blocks the tool and then hands out an instruction that always errors (prod 2026-07-13:
                // writeFile + planAndExecute both rejected on planStatus=completed). The task is NEW:
                // draft a NEW plan for it. The protocol is preserved, the deadlock is not.
                ? 'plan_draft({deliverables, steps, task_signature}) — 上一个 plan 已关闭,为这个新任务建新 plan'
                : `plan_revise({plan_id:"${lastPlan.id}", ...}) — 修订 plan 路径`;
        const closeHint = !lastPlan
          ? '(当前无活 plan,跳到第 2 步)'
          : lastPlan.status === 'failed' || lastPlan.status === 'completed'
            ? `(plan ${lastPlan.id} 已 close — **不要再调 plan_close(会报错)**,直接第 2 步 task_mode_classify(fast))`
            : `plan_close({plan_id:"${lastPlan.id}", outcome:"failure", summary:"分类错误"})`;
        const reason =
          `[plan_protocol_gate] ${baseReason}\n` +
          `本工具 ${call.name} 已被机制层禁用,直到 plan 进入 executing 状态。\n\n` +
          `**这不是 bug,是 slow 协议设计。** 你现在有 3 个选择:\n\n` +
          `A) 本任务**需要 plan**(多 deliverable 或多步依赖):\n` +
          `   1. ${planStateHint}\n` +
          `   2. plan_update_step({plan_id, step_id, status:"doing"}) — 开始执行\n` +
          `   3. 然后 ${call.name} 自动放行\n\n` +
          `B) 本任务**不需要 plan**(单次调用就够,或调研类只读):\n` +
          `   1. ${closeHint} — 关掉占位 plan(close 后即可切 fast,无冷却)\n` +
          `   2. task_mode_classify({mode:"fast", reason:"..."})\n` +
          `   3. 重试 ${call.name}\n\n` +
          `C) 你**卡住了**:\n` +
          `   - list_facts / search_skills 查相关历史\n` +
          `   - webFetch guide_ref 重新读指引\n` +
          `   - 调 plan_revise 改 plan(若现 plan 路径错了)\n\n` +
          `**不要直接重试 ${call.name} 不变** — 会再次被拦。`;
        console.warn(
          `[plan_protocol_gate] session=${safeSessionId(sessionId)} rejected ${call.name} (slow + planStatus=${lastPlan?.status ?? 'none'})[first-iter]`,
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_plan_protocol_gate',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'plan_protocol_gate',
          origin: 'Internal',
          toolName: 'plan_protocol_gate_blocked',
          sessionId,
          blockedTool: call.name,
          planStatus: lastPlan?.status ?? 'no-plan',
          planId: lastPlan?.id ?? null,
          iter: 'first',
        });
        continue;
      }
    }

    // Pre-intercept: use createToolChecker for unified checking
    const { capability, domain } = classification;
    const denial = await checker({ toolName: call.name, approval: 'never', params: JSON.stringify(call.input) });
    // 2026-05-28: headless/benchmark autogrant. In unattended sandbox containers, auth_pending
    // would be auto-"allowed" and replayed by headless anyway; but **the pause-resume itself** splits multiple
    // tool_use blocks from one model response across the pause boundary → on resume, messages are reassembled with
    // tool_use ↔ tool_result mismatches → Anthropic 400 (deepseek always hits this when emitting multiple tool_use at once;
    // Claude emitting one at a time does not). PHILONT_AUTO_GRANT=1 passes through directly, eliminating the pause → multiple
    // tool_use blocks processed in order in the same runToolLoop pass, naturally paired correctly.
    // Sandbox/benchmark use only; never enable in production (equivalent to full permissions with no human approval).
    const autoGrant = process.env.PHILONT_AUTO_GRANT === '1';
    const allowed = denial === null || autoGrant || isAuthExemptManagementCall(call);
    if (autoGrant && denial !== null) {
      console.warn(
        `[auto-grant] session=${safeSessionId(sessionId)} allowed ${call.name} (${capability}×${domain})— PHILONT_AUTO_GRANT=1, sandbox unattended`,
      );
    }

    if (!allowed) {
      // Pause: save state, wait for user authorization
      const remainingCalls = calls.slice(calls.indexOf(call) + 1);
      pendingAuth.set(sessionId, {
        goal: signalBus.carriedExploreGoal ?? carriedIntent.get(sessionId)?.goal ?? findLastUserText(messages) ?? '',
        executionState: 'awaiting_auth',
        callLedger: [
          ...toolResults.map((r) => ({ id: r.tool_use_id, name: ledgerToolName(r.tool_use_id, calls), state: 'completed' as const })),
          { id: call.id, name: call.name, state: 'awaiting_auth' as const },
          ...remainingCalls.map((c) => ({ id: c.id, name: c.name, state: 'queued' as const })),
        ],
        capability, domain,
        toolName:   call.name,
        toolCallId: call.id,
        input:      call.input,
        remainingCalls,
        collectedResults: toolResults,
        iteration: startIteration,
        // K0: save the current messages array in full; on authorization resume use it directly without rebuilding,
        // to avoid tool_use / tool_result pairing mismatches.
        inflightMessages: [...messages],
        priorInTurnRecords: [...(signalBus.inTurnRecords ?? [])],
        ts: Date.now(),
      });
      persistContinuation(sessionId);

      onAuthRequest({ requestId: call.id, toolName: call.name, capability, domain, input: call.input });
      return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
    }

    // ── askUserQuestion special path: ask then stop, wait for the user's next message to resume ──────────
    if (call.name === 'askUserQuestion') {
      // GUARD: the previous assistant already contained a question + user has already replied → reject a second prompt.
      // Fixes the anti-pattern of "agent asked a question, user answered, agent then asks askUserQuestion pretending not to know".
      // Note: messages.length-1 is the current assistant (containing this tool_use); look back from its predecessor.
      const priorAssistantText = findLastAssistantText(messages, messages.length - 1);
      if (priorAssistantText) {
        const detected = detectUnclosedQuestion(priorAssistantText);
        if (detected.hasQuestion) {
          const lastUserMsg = findLastUserText(messages, messages.length - 1) ?? '';
          const rejection = renderAskGuardRejection(detected.snippet, lastUserMsg);
          console.log(
            `[ask-guard] session=${safeSessionId(sessionId)} rejected askUserQuestion (prior question: "${detected.snippet.slice(0, 40)}…")`,
          );
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'ask-guard 拦截一次 askUserQuestion 二次追问',
            meta: { gateName: 'AskGuard' },
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: rejection,
          });
          totalToolCallsThisTurn++;
          memory.actions.log({
            sessionId: GLOBAL_TIMELINE_SESSION_ID,
            toolName: call.name,
            params: call.input,
            result: 'rejected_by_ask_guard',
            success: false,
          });
          audit.append('self_domain_write', {
            source: 'ask_guard',
            origin: 'Internal',
            toolName: 'ask_guard_blocked',
            sessionId,
            priorQuestion: detected.snippet,
            userReply: lastUserMsg.slice(0, 200),
          });
          continue;
        }
      }

      // First call this tool's own execute (pure schema validation); treat failures as normal tool errors
      const validation = await tools.execute(call.name, call.input);
      if (!validation.success) {
        console.log(`[tool] askUserQuestion → fail: ${validation.error ?? ''}`);
        onTrace?.({
          kind: 'tool-result', tier: 3,
          text: summarizeToolResult(validation),
          meta: { toolName: call.name, success: false },
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: truncateToolResultContent(formatToolResultContent(validation)),
        });
        totalToolCallsThisTurn++;
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: validation.error ?? null,
          success: false,
        });
        continue;
      }

      const question = String(call.input.question ?? '').trim();
      const optionsRaw = (call.input.options ?? []) as ReadonlyArray<{
        label: string;
        description?: string;
      }>;
      const allowFreeText = Boolean(call.input.allowFreeText);
      const rendered = renderQuestion(question, optionsRaw, allowFreeText);
      console.log(
        `[tool] askUserQuestion → pending (${optionsRaw.length} options${allowFreeText ? ', free-text ok' : ''})`,
      );
      // Deliver the question text directly to the user (do not prepend "📞 calling askUserQuestion";
      // that line is meaningless to the user and obscures the actual question)
      onDelta(rendered);

      const remainingCalls = calls.slice(calls.indexOf(call) + 1);
      pendingQuestion.set(sessionId, {
        goal: signalBus.carriedExploreGoal ?? carriedIntent.get(sessionId)?.goal ?? findLastUserText(messages) ?? '',
        callLedger: [
          ...toolResults.map((r) => ({ id: r.tool_use_id, name: ledgerToolName(r.tool_use_id, calls), state: 'completed' as const })),
          { id: call.id, name: call.name, state: 'awaiting_user' as const },
          ...remainingCalls.map((c) => ({ id: c.id, name: c.name, state: 'queued' as const })),
        ],
        toolCallId: call.id,
        question,
        options: optionsRaw,
        allowFreeText,
        remainingCalls,
        collectedResults: toolResults,
        iteration: startIteration,
        inflightMessages: [...messages],
        createdAt: Date.now(),
      });
      persistContinuation(sessionId);

      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        params: call.input,
        result: '__pending_user_response__',
        success: true,
      });

      return { outcome: { outcomeType: 'question_pending' }, auditEvents: audit.length };
    }

    // Never dump raw tool arguments to process logs. Inputs routinely contain credentials, document
    // contents, private queries, or shell commands with inline tokens — the 2026-08-09 log leaked the
    // owner's Windows account name on every readFile. But a bare name is not a log either: that same
    // log's `writeFile({})` (nine minutes of the owner's time spent approving a call that could never
    // work) is invisible without knowing the call had no fields. Structure, not content.
    console.log(`[tool] ${call.name} ${summarizeToolInputForLog(call.input)}`);
    // 2026-05-19 three-stream separation: tool call details → Tier 3 onTrace; semantic progress → Tier 2 onStatus
    onTrace?.({
      kind: 'tool-invocation', tier: 3,
      text: summarizeToolInvocation(call.name, call.input),
      meta: { toolName: call.name },
    });
    onStatus?.(semanticToolPhrase(call.name, call.input, statusLang));

    // 2026-05-07 #1: tool input defense layer. LLM providers occasionally concatenate multiple tool_use
    // arguments into a single string; passing it directly to tools.execute would throw TypeError and
    // corrupt messages history → next LLM call hits 400. Intercept and fix here.
    const sanitized = sanitizeToolInput(call.input);
    let result;
    if (sanitized.input === null) {
      console.warn(
        `[tool] ${call.name} → input rejected: ${sanitized.reason ?? 'unknown'} (path=${sanitized.path})`,
      );
      result = {
        success: false,
        output: '',
        error: `tool input 格式错误,已拦截: ${sanitized.reason ?? 'unknown'}`,
        duration: 0,
      };
    } else {
      if (sanitized.path !== 'object') {
        console.warn(
          `[tool] ${call.name} → input sanitized: path=${sanitized.path}` +
            (sanitized.truncatedTailLen ? ` truncated=${sanitized.truncatedTailLen}` : ''),
        );
      }
      const parserLabel =
        process.env.PHILONT_SKILL_REFLEX !== '0' && !skillReflexNudged.has(sessionId)
          ? detectHandRolledParser(call.name, sanitized.input)
          : null;
      const alreadySearchedSkills = (signalBus.inTurnRecords ?? []).some(
        (r) => r.toolName === 'search_skills' || r.toolName === 'use_skill',
      );
      if (parserLabel && !alreadySearchedSkills) {
        // Intercept once per session: don't run the raw parser yet — nudge the agent to check skills first.
        // Re-issuing the same command runs it as-is (the session is now marked nudged), so this never loops.
        skillReflexNudged.add(sessionId);
        console.warn(
          `[skill-reflex] session=${safeSessionId(sessionId)} intercepted hand-rolled "${parserLabel}" → nudging search_skills first`,
        );
        result = { success: false, output: '', error: buildSkillReflexNudge(parserLabel), duration: 0 };
      } else if (isDeepExploreAdvance(call) && deepExploreAdvancesThisTurn >= 1) {
        console.warn(`[deep-explore] blocked 2nd advance this turn (one round/turn cap)`);
        result = { success: true, output: DEEP_EXPLORE_ONE_ROUND_MSG, duration: 0 };
      } else {
        if (isDeepExploreAdvance(call)) deepExploreAdvancesThisTurn++;
        result = await tools.execute(call.name, sanitized.input);
      }
    }
    // The approved call has returned. Persist that fact immediately; do not leave it `running` while
    // the rest of this potentially long turn continues.
    settleRunningPendingAuth(sessionId, call.id);
    const originalInput = (sanitized.input ?? call.input) as Record<string, unknown>;
    const repair = await maybeMechanicalRepair({ name: call.name, input: originalInput }, result);
    result = repair.result;
    const actualInput = repair.repairedInput ?? originalInput;
    const outPreview = (result.success ? result.output : result.error) ?? '';
    console.log(
      `[tool] ${call.name} → ${result.success ? 'ok' : 'fail'}: ${String(outPreview).slice(0, 200)}`
    );
    onTrace?.({
      kind: 'tool-result', tier: 3,
      text: summarizeToolResult(result),
      meta: { toolName: call.name, success: result.success },
    });
    if (!result.success) {
      onStatus?.(semanticToolFailPhrase(call.name, statusLang));
    }
    // Phase 10 M1 (2026-05-14): successful webFetch / readFile automatically persisted to FetchedResourceStore.
    // Failed / other tool: no-op. Hook is fully try/catch internally; main path is unaffected.
    // Phase 15.5 (2026-05-18): exclude the plan-files baseDir (plan.md is a PlanFileStore output
    // and should not be copied to local-plan.md in the workspace by fetched-store).
    persistToolResultIfFetched(
      fetchedStore,
      {
        toolName: call.name,
        params: actualInput,
        success: result.success,
        output: result.output ?? '',
        error: result.error,
      },
      { sessionId, excludeDirs: [memory.planFiles.baseDir] },
    );
    // A SUB-LOOP CANNOT ASK. THIS TURN CAN.
    //
    // planAndExecute stops when the policy layer refuses one of its steps, keeps what it finished,
    // and says which capability it needed. Up to here that report went into the transcript and the
    // owner learned about it only if the model chose to mention it — which is the shape of every
    // other thing that quietly did not happen.
    //
    // So the turn raises the card itself, and raises it for the CAPABILITY THAT WAS REFUSED rather
    // than for the wrapper: "shell (execute/local)" is a question an owner can answer;
    // "planAndExecute needs something" is not. Approving it grants that capability and replays this
    // same call, which resumes from the checkpoint instead of re-running the finished steps.
    const blocked = subLoopBlockedAuthorization(result);
    if (blocked && !isAutonomousTurn) {
      const remainingCalls = calls.slice(calls.indexOf(call) + 1);
      pendingAuth.set(sessionId, {
        goal: signalBus.carriedExploreGoal ?? carriedIntent.get(sessionId)?.goal ?? findLastUserText(messages) ?? '',
        executionState: 'awaiting_auth',
        callLedger: [
          ...toolResults.map((r) => ({ id: r.tool_use_id, name: ledgerToolName(r.tool_use_id, calls), state: 'completed' as const })),
          { id: call.id, name: call.name, state: 'awaiting_auth' as const },
          ...remainingCalls.map((c) => ({ id: c.id, name: c.name, state: 'queued' as const })),
        ],
        capability: blocked.capability,
        domain: blocked.domain,
        toolName: blocked.tool,
        toolCallId: call.id,
        // Replaying planAndExecute is what resumes the plan; the checkpoint holds the finished work.
        input: call.input,
        remainingCalls,
        collectedResults: toolResults,
        iteration: startIteration,
        inflightMessages: [...messages],
        priorInTurnRecords: [...(signalBus.inTurnRecords ?? [])],
        ts: Date.now(),
      });
      persistContinuation(sessionId);
      console.warn(
        `[plan-execute] session=${safeSessionId(sessionId)} plan blocked at ${blocked.subTaskId}; ` +
          `raising a card for ${blocked.tool} (${blocked.capability}/${blocked.domain}) — approval resumes the plan`,
      );
      onAuthRequest({
        requestId: call.id,
        toolName: blocked.tool,
        capability: blocked.capability,
        domain: blocked.domain,
        input: { neededBy: `plan sub-task ${blocked.subTaskId}` },
      });
      return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
    }

    const rawResultText = formatToolResultContent(result) + repair.notice;
    toolResults.push({
      type: 'tool_result',
      tool_use_id: call.id,
      content: truncateToolResultContent(rawResultText),
    });
    totalToolCallsThisTurn++;
    const ledgerRows = repairLedgerRows({
      originalInput,
      originalFailure: repair.originalFailure,
      repairedInput: repair.repairedInput,
      finalResult: result,
    });
    if (repair.originalFailure && repair.repairedInput) {
      const originalError = repair.originalFailure.error ?? repair.originalFailure.output ?? '';
      inTurnRecords.push({ toolName: call.name, success: false, resultText: originalError });
      const failedRow = ledgerRows[0];
      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        ...failedRow,
        linkedSkill: signalBus.activeSkillName,
      });
    }
    // 2026-05-10: trace used by the in-turn failure pattern detector. Signature extraction needs raw
    // error / output text (extractFailureSignature normalizes it), so raw is passed.
    // 2026-05-17: http tool additionally stores toolInput (method/url) for
    // ScheduleOutcome aggregation at scheduled turn close.
    inTurnRecords.push({
      toolName: call.name,
      success: result.success,
      resultText: result.success ? (result.output ?? '') : (result.error ?? result.output ?? ''),
      toolInput: call.name === 'http' ? actualInput : undefined,
    });
    rememberFormalVerificationEvidence(sessionId, call.name, actualInput, result);
    // WS5: a successful use_skill makes that skill the turn's active linked skill, so the
    // actions that follow are attributed to it (reuse verification input for the reflector).
    if (call.name === 'use_skill' && result.success) {
      const skillName = (sanitized.input as { name?: unknown } | null)?.name;
      if (typeof skillName === 'string' && skillName.trim()) {
        signalBus.activeSkillName = skillName.trim();
        // The acceptance side of [skill-funnel]. This is the ONE event that lets a skill be credited
        // (linkedSkill → recordLinkedSkillOutcomes → recordSkillOutcome → maturity). It fired 10 times in
        // 462 turns. Log it so offers and acceptances can be counted against each other in one log file.
        console.log(`[skill-funnel] ACCEPTED use_skill('${skillName.trim()}') — subsequent actions will be credited to it`);
      }
    }
    // Layer 0.5: action persisted to global timeline; selected by time window during reflection
    const finalLedgerRow = ledgerRows[ledgerRows.length - 1];
    memory.actions.log({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      toolName: call.name,
      ...finalLedgerRow,
      // Attribute post-use_skill actions to the active recipe (never use_skill itself).
      linkedSkill:
        call.name !== 'use_skill' && signalBus.activeSkillName
          ? signalBus.activeSkillName
          : undefined,
    });
  }

  // All tools executed; push into message history and continue LLM conversation.
  // Defensive check: empty toolResults means the tool_use from the previous assistant message was all discarded
  // (e.g. an early grant path bug that did not put the pending call back in the queue); sending this to the LLM
  // would get "empty final user message" / structure mismatch 400. Fail fast to let the outer layer roll back.
  if (toolResults.length === 0) {
    throw new Error(
      `runToolLoop: refusing to push empty tool_result (calls=${calls.length}, collected=${collectedResults.length}) — upstream bug`,
    );
  }
  messages.push({ role: 'user', content: toolResults });

  // K2 HonestyGate: budget for final-text regeneration within the same turn. 0 = not used yet, 1 = already used.
  // Set cap=1 to prevent honesty/pledge infinite loops (the LLM will only ever be forced to rewrite once).
  let honestyAttempts = 0;
  // Tier 1.3 EmptyConclusionGate: budget for "empty conclusion" regeneration within the same turn; cap=1.
  // Counted independently from honestyAttempts; the two diagnose different conditions (lying vs not saying).
  let emptyConclusionAttempts = 0;
  // Phase 11 (2026-05-14): OutputFormatGate budget for "long text without a `## For User` section"
  // regeneration within the same turn; cap=1. Independent of the two above. env PHILONT_OUTPUT_FORMAT_GATE=0 to disable.
  let outputFormatAttempts = 0;
  // Phase 15 (2026-05-18): HalfFinishedGate budget for "slow task commitment-type final text + 0 actual progress"
  // regeneration within the same turn; cap=1. env PHILONT_HALF_FINISHED_GATE=0 to disable.
  // Successful plan_update_step count is derived from signalBus.inTurnRecords (no separate counter needed).
  let halfFinishedAttempts = 0;
  // Phase 17 (2026-05-18): PlanFailureFalseClaimGate budget for "plan was mechanically forced to failed
  // (circuit breaker), or LLM never properly converted the plan, but final text contains a completion claim"
  // regeneration within the same turn; cap=1.
  // Production mycox onboarding: plan-circuit-breaker fired but LLM output "MycoX registration complete";
  // honesty did not count register 404 as failure → lie slipped through. This gate uses mechanism-layer signals (circuit breaker /
  // placeholder plan still in draft) to directly determine a lie, without relying on honesty's tool result count.
  let planFailureFalseClaimAttempts = 0;
  // Phase 18 (2026-06-15): ViabilityGate budget for "active reasoning goal is doomed/stalled but the draft
  // pitches continuation as if normal" regeneration within the same turn; cap=1. env PHILONT_VIABILITY_GATE=0
  // to disable. Counsel-only: changes the RECOMMENDATION (and may downgrade outcome to stop_and_report), never
  // blocks the user from replying "继续".
  let viabilityAttempts = 0;
  // Citation-grounding gate (2026-06-17): the model fabricates a specific arXiv id (and its attributed
  // equation/result) from memory when no source was actually retrieved this conversation. One regen forces
  // honest framing. Capped at one attempt like the other gates.
  // One counter for the whole claim-grounding chain: the point of merging four gates is one
  // regeneration per turn, not up to three stacked on each other.
  let claimGroundingAttempts = 0;
  // Phase 18 WS2: carries a stop_and_report verdict from the ViabilityGate to the final emit so the outcome
  // class is downgraded deterministically (independent of whether the regen dropped the continuation pitch).
  let viabilityStopPending = false;
  // The owner reasoning session a stop was recommended for, so the next turn can abandon it iff the user accepts.
  let viabilityStopReasoningId: string | null = null;
  // Ratchet: update the per-session pivot streak at most once per turn (the gate may evaluate twice across a regen).
  let viabilityStreakUpdated = false;

  // 2026-05-07: give the LLM one warning at max-3 (approaching the iter limit) so it wraps up rather than
  // continuing to explore. Injected only once to prevent spam.
  let iterWarningInjected = false;
  // 2026-05-10: in-turn failure pattern → reflection reminder. Injected only once per turn.
  let reflectionReminderInjected = false;
  // 2026-05-11: in-turn-reflection upgraded — once triggered, remaining calls to **the same tool** within this turn
  // are short-circuited by the mechanism layer (synthetic fail) to prevent the LLM from continuing to hit the wall.
  // Trigger logic: reflection.signature looks like `<toolName>:<errorClass>` → extract toolName
  // as the block list for the remainder of this turn. Auto-cleared on the next user turn (variable is turn-local).
  let blockedToolAfterReflection: string | null = null;
  // Mechanical syntax failures need one fix-and-retry, but not an unlimited loop. Production's top
  // signature was pariGp brace syntax (38 occurrences); after the 2x reminder allow exactly one retry.
  let mechanicalRetryTool: string | null = null;
  let mechanicalRetriesRemaining = 0;
  // Phase 11 (2026-05-14): ResearchBeforeRetry — must do research before retrying business tools after failure.
  // in-turn-reflection triggered + no research calls this turn → set flag.
  // Any business tool (non-research / non-plan-gate-exempt) is blocked until the LLM makes one
  // research tool call (readFile / webFetch / search_skills / list_facts etc.).
  // env PHILONT_RESEARCH_BEFORE_RETRY=0 to disable.
  let researchRequiredBeforeBusinessTool = false;
  let researchTriggerContext: { failedTool: string; signature: string } | null =
    null;
  // 2026-05-12 Phase 7 hardening 2: after in-turn-reflection fires, automatically promote to slow + create a placeholder plan
  // (or inject a plan_revise hint for an already-reviewed plan). Triggered only once per turn.
  let autoRevisePlanInjected = false;
  // Phase 11 constitutional amendment (2026-05-15): plan factory circuit breaker.
  // Production (mycox-heartbeat) revealed: after failure, LLM enters "plan_draft fails → plan_revise fails →
  // plan_close fails → auto-revise-on-fail creates another placeholder → fails again" infinite loop;
  // 8 plans / N reflections / massive token waste. This mechanism triggers when same-turn plan_* failures accumulate ≥ N → force fast mode +
  // inject wrap-up hint. env PHILONT_PLAN_CIRCUIT_BREAKER_AT to set threshold (default 3; set 0 to disable).
  // Triggered only once per turn.
  let planCircuitBroken = false;
  // Set when the wall clock, not the iteration counter, ended the loop. See TURN_WRAPUP_HEADROOM_MS.
  let outOfTime = false;
  for (let i = startIteration + 1; i < effectiveMax; i++) {
    // Interrupt teeth: user stopped → exit before the next LLM call.
    if (stopped()) return interruptedReturn();

    // Clock teeth. Running out of time and running out of iterations are the same situation, and until
    // now only one of them had a graceful exit: the cap fell through to a forced summary, the clock threw
    // TurnDeadlineError and discarded the turn. Leave the loop with headroom and take the same exit.
    const turnAgeMs = Date.now() - (signalBus.turnStartedAt ?? Date.now());
    if (turnAgeMs > TURN_HARD_DEADLINE_MS - TURN_WRAPUP_HEADROOM_MS) {
      outOfTime = true;
      console.warn(
        `[turn-wrapup] session=${safeSessionId(sessionId)} ${Math.round(turnAgeMs / 1000)}s elapsed of the ` +
          `${Math.round(TURN_HARD_DEADLINE_MS / 1000)}s turn budget — no more tool calls; writing the ` +
          `reply with the ${Math.round(TURN_WRAPUP_HEADROOM_MS / 1000)}s that are left`,
      );
      onTrace?.({
        kind: 'loop-control', tier: 4,
        text: `时间预算用尽(${Math.round(turnAgeMs / 60_000)}min),停止调工具,改为收尾汇报`,
      });
      break;
    }
    // 2026-05-13: within the tool loop, compaction only triggers at the hard-cap (default 250K) as a safety net
    // to prevent the LLM context window from truly overflowing. Soft-threshold (default 180K) compaction is reserved
    // for the "quiet period" at turn entry — to avoid compaction mid-plan/tool chain breaking precise IDs like plan_id.
    await maybeCompact(messages, sessionId, 'hard');

    // Phase 11 constitutional amendment (2026-05-15): plan factory circuit breaker.
    // Same-turn accumulation of ≥ N plan_* failures → force fast mode (allow business tools) + inject wrap-up hint.
    // Unlike in-turn-reflection (which uses same-root-cause signatures), this mechanism specifically monitors the plan factory loop
    // (plan_draft failures / plan_revise failures / plan_close failures all counted regardless of cause).
    if (!planCircuitBroken) {
      const threshold = Number(process.env.PHILONT_PLAN_CIRCUIT_BREAKER_AT ?? 3);
      if (threshold > 0) {
        const planFailures = inTurnRecords.filter(
          (r) => r.toolName.startsWith('plan_') && !r.success,
        ).length;
        if (planFailures >= threshold) {
          planCircuitBroken = true;
          signalBus.planCircuitBroken = true;
          const wasMode = taskModeStore.get(sessionId);
          if (wasMode === 'slow') {
            taskModeStore.set(
              sessionId,
              'fast',
              `auto:plan-circuit-breaker:${planFailures}-failures`,
            );
          }
          console.warn(
            `[plan-circuit-breaker] session=${safeSessionId(sessionId)} plan_* failed ${planFailures}x, downgrade ${wasMode}→fast + inject wrap-up hint`,
          );
          audit.append('self_domain_write', {
            source: 'plan_circuit_breaker',
            origin: 'Internal',
            toolName: 'plan_circuit_breaker_tripped',
            sessionId,
            planFailures,
            wasMode,
          });
          pushGateDirective(
            messages,
              `[plan-circuit-breaker] 你已经在本 turn 内累计 ${planFailures} 次 plan_* 工具失败` +
              `(plan_draft / plan_revise / plan_close 之类)。机制层判定 plan 协议在本 turn 已不可恢复,` +
              `**降级回 fast 模式** + 不再强制 plan 协议。\n\n` +
              `下一步必须直接收尾:\n` +
              `  1. 若任务已部分完成 → 用 \`## For User\` 段如实汇报已完成的部分 + 未完成的部分,**不要再调任何 plan_* 工具**\n` +
              `  2. 若需要持续性任务(周期 check-in 等)→ 调 schedule_reminder 设定,然后再 \`## For User\` 段\n` +
              `  3. **禁止**继续 plan_draft / plan_revise / plan_close — 已被本 turn 拉黑\n\n` +
              `下次同类任务时,reflection 路径会蒸馏出 routing_rule 帮你绕过本次的失败模式。`,
          );
          onTrace?.({
            kind: 'loop-control', tier: 4,
            text: `plan 工具失败 ${planFailures}x,机制层降级收尾`,
          });
        }
      }
    }

    // 2026-05-10: in-turn reflection trigger — **when same-root-cause failures ≥ 2** (i.e. the first repeat)
    // give a one-shot reminder "reflect before acting, do not just retry". Generic mechanism (applies to any
    // tool / service / skill). Complements turn-close reflection.ts:
    //   - reflection.ts: post-hoc, writes routing rule / playbook at turn close for next time
    //   - in-turn (this mechanism): mid-turn stop, LLM immediately self-corrects this turn
    // Reason for threshold 2 not 3: 1 failure LLM naturally pivots (transient glitch); 2 same-signature
    // is the earliest evidence of "LLM not self-correcting". Each wasted retry is expensive.
    if (!reflectionReminderInjected) {
      const reflection = detectInTurnFailurePattern(inTurnRecords, 2);
      if (reflection.triggered) {
        reflectionReminderInjected = true;
        memory.metrics.increment('inturn.fire'); // instrumentation: the cheap same-turn feedback path
        // A MECHANICAL failure (gp/python syntax error, traceback, not-a-function) is a bug in the script the
        // agent just wrote — the recovery is "fix it and re-run", which needs writeFile+shell. The strategic
        // gates below (in-turn-tool-block / research-before-retry / auto-revise-plan) would block exactly those
        // tools → deadlock (prod 2026-06-17). For mechanical errors: give the fix-it reminder, skip the gates.
        const mechanicalFailure = isMechanicalFailure(reflection.signature);
        if (mechanicalFailure) memory.metrics.increment('inturn.mechanical');
        if (mechanicalFailure && reflection.signature) {
          const colonIdx = reflection.signature.indexOf(':');
          if (colonIdx > 0) {
            mechanicalRetryTool = reflection.signature.slice(0, colonIdx);
            mechanicalRetriesRemaining = 1;
          }
        }
        pushGateDirective(
          messages,
          mechanicalFailure
            ? buildMechanicalFixReminder(
                reflection.signature!,
                reflection.count!,
                learnedCheatsheet(reflection.signature!, memory.facts),
              )
            : reflection.reminder!,
        );
        onTrace?.({
          kind: 'loop-control', tier: 4,
          text: `同根因失败 ${reflection.count}x,触发反思提醒${mechanicalFailure ? '(机械错:仅提示修复,不锁工具)' : ''}`,
        });
        // 2026-05-11: extract toolName from the signature head as the block list for the rest of this turn.
        // Signature looks like `http:http-401` / `webFetch:other:...` / `shell:cmd-not-found:rg`;
        // toolName is before the first colon. Graceful degradation on failure: if parsing fails, do not block; only inject reminder.
        // Mechanical errors skip the tool-block + research-before-retry entirely (the fix needs those tools).
        if (reflection.signature && !mechanicalFailure) {
          const colonIdx = reflection.signature.indexOf(':');
          if (colonIdx > 0) {
            blockedToolAfterReflection = reflection.signature.slice(0, colonIdx);
            signalBus.inTurnToolBlockFired = true;
            console.warn(
              `[in-turn-tool-block] session=${safeSessionId(sessionId)} remaining calls to ${blockedToolAfterReflection} this turn are mechanism-layer disabled`,
            );

            // Phase 11 (2026-05-14): simultaneously check if ResearchBeforeRetry is needed.
            // Trigger condition: in-turn-reflection fire + no research calls this turn
            if (
              process.env.PHILONT_RESEARCH_BEFORE_RETRY !== '0' &&
              !researchRequiredBeforeBusinessTool &&
              !hasResearchCallInTurn(inTurnRecords)
            ) {
              researchRequiredBeforeBusinessTool = true;
              researchTriggerContext = {
                failedTool: blockedToolAfterReflection,
                signature: reflection.signature,
              };
              console.warn(
                `[research-before-retry] session=${safeSessionId(sessionId)} triggered: no research call this turn, business tools blocked after ${reflection.signature}`,
              );
              audit.append('self_domain_write', {
                source: 'research_before_retry',
                origin: 'Internal',
                toolName: 'research_before_retry_fired',
                sessionId,
                failedTool: blockedToolAfterReflection,
                signature: reflection.signature,
              });
            }
          }
        }
        console.warn(
          `[in-turn-reflection] session=${safeSessionId(sessionId)} signature=${reflection.signature} count=${reflection.count}`,
        );
        audit.append('self_domain_write', {
          source: 'in_turn_reflection',
          origin: 'Internal',
          toolName: 'reflection_reminder_injected',
          sessionId,
          signature: reflection.signature ?? '',
          count: reflection.count ?? 0,
        });

        // 2026-05-12 Phase 7 hardening 2: in-turn-reflection fires → auto-promote to slow + create placeholder plan
        // (or inject plan_revise hint for an already-reviewed plan).
        // Co-exists with blockedToolAfterReflection: tool layer blocks the specific tool + protocol layer forces revise.
        // Triggered only once per turn. env flag PHILONT_AUTO_REVISE_ON_FAIL=0 to disable.
        //
        // 2026-05-15 skip benign misses: research/lookup tools (get_fact/list_facts/search_* etc.)
        // "not found" is fundamentally "no results", not "hitting a wall". Treating it as a wall would
        // erroneously promote simple queries (e.g. "look up my info") to slow + placeholder plan + block subsequent store_fact.
        // The correct response to a benign miss is the LLM informing the user nothing is stored / storing it, not changing the protocol.
        //
        // 2026-05-15 (tail fix): skip "mechanism-layer intentional reject" type signatures.
        // Production mycox: after plan completed, LLM calls http to verify → plan_protocol_gate rejects
        // → in-turn-reflection same-root-cause 2x → auto-revise-on-fail creates another placeholder plan.
        // Infinite loop risk. These rejects are not real wall collisions; they are ON-PURPOSE protocol-layer stops
        // and should not trigger plan escalation.
        // Signature head pattern: `<tool>:other:[<mechanism>_<name>]` (square bracket + mechanism name marker).
        const isMechanismReject = /:other:\[(plan_protocol_gate|in_turn_tool_block|autonomous_blacklist|research[_-]?before[_-]?retry)\b/i.test(
          reflection.signature ?? '',
        );
        // Mechanical errors (script/syntax bug) are not a strategic wall — escalating to slow+placeholder-plan
        // and blocking writeFile via plan_protocol_gate is exactly what deadlocked the fix in prod. Skip it.
        const mechFail = isMechanicalFailure(reflection.signature);
        const isBenignMiss =
          /^(get_fact|list_facts|search_notes|search_skills|search_kb|recall_sessions):/i.test(
            reflection.signature ?? '',
          ) ||
          /(?::|^)(未找到|not_found|not found|empty|no results?)\b/i.test(
            reflection.signature ?? '',
          ) ||
          isMechanismReject ||
          mechFail;
        if (isBenignMiss) {
          const skipReason = isMechanismReject
            ? 'mechanism-layer active reject'
            : mechFail
              ? 'mechanical error (fix-and-retry, not a strategic wall)'
              : 'benign miss';
          console.log(
            `[auto-revise-on-fail] session=${safeSessionId(sessionId)} skipped (${skipReason}, no escalation): ${reflection.signature}`,
          );
        }
        if (
          process.env.PHILONT_AUTO_REVISE_ON_FAIL !== '0' &&
          !autoRevisePlanInjected &&
          reflection.signature &&
          !isBenignMiss
        ) {
          autoRevisePlanInjected = true;
          const sigHash = createHash('sha1')
            .update(reflection.signature)
            .digest('hex')
            .slice(0, 8);

          // 2.1 Auto-promote to slow (if currently fast)
          if (taskModeStore.get(sessionId) === 'fast') {
            taskModeStore.set(
              sessionId,
              'slow',
              `auto:in-turn-fail:${reflection.signature}`,
            );
            audit.append('self_domain_write', {
              source: 'auto_revise_on_fail',
              origin: 'Internal',
              toolName: 'task_mode_auto_slow_after_fail',
              sessionId,
              signature: reflection.signature,
            });
            console.log(
              `[auto-revise-on-fail] session=${safeSessionId(sessionId)} fast→slow due to ${reflection.signature}`,
            );
          }

          // 2.2 Get active plan + branch handling
          try {
            const sessionPlans = memory.plans.listBySession(sessionId, {
              limit: 1,
            });
            const lastPlan = sessionPlans[0];

            if (
              !lastPlan ||
              lastPlan.status === 'completed' ||
              lastPlan.status === 'failed'
            ) {
              // Path A: no active plan → create a "diagnose-fix-retry" three-step placeholder plan
              const placeholder = memory.plans.create({
                sessionId,
                taskSignature: `recovery-${sigHash}`,
                guideRef: `auto-recovery:${reflection.signature}`,
                // M3 / Phase 11 (2026-05-15): placeholder plan marked with isPlaceholder=true.
                isPlaceholder: true,
                steps: [
                  {
                    id: 'diagnose',
                    description: `诊断 ${reflection.signature} 根因(看最近 ${reflection.count} 条失败 tool_result,抽 errorClass + 路径/参数差异)`,
                  },
                  {
                    id: 'revise',
                    description: `调 plan_revise 把 steps 改成绕过此根因的新方案(换工具 / 换参数 / 换 endpoint)`,
                  },
                  {
                    id: 'retry',
                    description: `按新 plan 执行 1-2 步验证;仍失败 → plan_close failure 写 playbook`,
                  },
                ],
              });
              audit.append('self_domain_write', {
                source: 'auto_revise_on_fail',
                origin: 'Internal',
                toolName: 'auto_recovery_plan_created',
                sessionId,
                planId: placeholder.id,
                signature: reflection.signature,
              });
              console.log(
                `[auto-revise-on-fail] session=${safeSessionId(sessionId)} created placeholder plan ${placeholder.id} sig=${reflection.signature}`,
              );
            } else if (lastPlan.status === 'executing') {
              // Path B: active plan in executing → inject user-role hint (M3 removed 'reviewed')
              const guide = [
                `[内驱 auto-revise-hint] 你的活 plan ${lastPlan.id} (executing) 在执行中遭遇 ${reflection.count}x 同根因失败 (${reflection.signature})。`,
                `**立即调 plan_revise({ plan_id: "${lastPlan.id}", new_steps: [...], reason: "${reflection.signature} 同根因失败" })** 替换 steps,绕过此根因。`,
                `revise 后 plan 回 draft,调 plan_update_step(status="doing") 重新执行。`,
              ].join('\n');
              pushGateDirective(messages, guide);
              audit.append('self_domain_write', {
                source: 'auto_revise_on_fail',
                origin: 'Internal',
                toolName: 'auto_revise_hint_injected',
                sessionId,
                planId: lastPlan.id,
                signature: reflection.signature,
              });
            }
            // Path C: lastPlan.status === 'draft' → no intervention; plan_protocol_gate
            // naturally forces LLM to call plan_update_step (to enter executing) or plan_revise (to change the approach)
          } catch (e) {
            console.warn(
              `[auto-revise-on-fail] session=${safeSessionId(sessionId)} failed (ignored):`,
              e,
            );
          }
        }
      }
    }

    // Approaching limit warning: insert a system reminder at max-3
    if (!iterWarningInjected && i >= effectiveMax - 3) {
      iterWarningInjected = true;
      pushGateDirective(
        messages,
          `[drive iter-warning] You have used ${i}/${effectiveMax} tool-call rounds and are approaching the limit.\n` +
          `**Wrap up immediately**: organize the information you have collected into a reply for the user (## For User / ## Work Log two-section format). ` +
          `Do not make any more pointless tool calls. If you must call one more, pick the 1-2 most critical, then produce your final reply.\n` +
          INTERNAL_CORRECTION_FOOTER,
      );
      onStatus?.(summarizingPhrase(statusLang));
    }

    // S1 P1: refresh this-turn's execution-ledger contract into the system prefix so the model sees what it
    // actually ran (and what it did NOT) BEFORE it writes — prevents build/run/test fabrication phrasing-
    // agnostically, as opposed to the post-hoc honesty gate that has to enumerate phrasings.
    refreshTurnLedgerContract(messages, signalBus.inTurnRecords ?? []);

    let response: LLMResponse;
    try {
      response = await sendLlmWithRescue(messages, toolDefs, sessionId, onTrace);
    } catch (e) {
      // A call that timed out with no turn budget left for another attempt is not an error to hand the
      // owner — it is the clock, and the clock has a graceful exit. Anything else still propagates.
      if (e instanceof LlmTimeoutError && !hasRoomForTimeoutRetry(turnRemainingMs(sessionId))) {
        outOfTime = true;
        console.warn(
          `[turn-wrapup] session=${safeSessionId(sessionId)} the LLM call timed out with no budget for a retry — ` +
            `wrapping up instead of failing the turn`,
        );
        break;
      }
      throw e;
    }

    if (response.type === 'text') {
      // K2 HonestyGate: verify "completion claim vs actual tool results" **before** onDelta pushes text to the user.
      // If high severity hits and budget is not used → inject a reminder message to make the LLM
      // regenerate once so the lie never leaves.
      if (honestyAttempts < 1) {
        const recentToolResults = extractRecentToolResults(messages);
        const evidenceLevel = assessEvidenceLevel(recentToolResults);
        onTrace?.({
          kind: 'internal-gate', tier: 4,
          text: `evidence checkpoint: ${evidenceLevel}`,
          meta: {
            gateName: 'EvidenceCheckpoint',
            evidenceLevel,
            successfulTools: recentToolResults
              .filter((r) => r.content.startsWith('✓'))
              .map((r) => r.toolName),
          },
        });
        // Ground truth for the deep_explore honesty checks: the owner-scoped active reasoning session's
        // tree state (null if none). Lets the gate catch "全部闭合 / proved / 最终判决" claims the tree
        // doesn't support, and round-result narration with no actual round this turn.
        const ownerReasoning = focusedReasoningSession(sessionId);
        // Session-aware say-do-gap latch (PHILONT_HONESTY_SESSION=0 disables). Carries "promised a run but
        // didn't" / fabrication count across turns so a REPEATED unkept run-promise escalates to high.
        const honestySessionEnabled = process.env.PHILONT_HONESTY_SESSION !== '0';
        // Verb-agnostic announce-then-yield stall (e.g. ends with "正在调研中……" / commits to start
        // deep_explore, but issues 0 tools → permanent stall). Default ON (env set via web-ui);
        // PHILONT_HONESTY_ANNOUNCE=0/off/false/no disables.
        const announceStallRaw = (process.env.PHILONT_HONESTY_ANNOUNCE ?? '').trim().toLowerCase();
        const announceStallEnabled = !(
          announceStallRaw === '0' ||
          announceStallRaw === 'off' ||
          announceStallRaw === 'false' ||
          announceStallRaw === 'no'
        );
        // Turn-durable skill-delete signal: did forget_skill/uninstallSkill succeed ANYWHERE this turn? The
        // per-iteration recentToolResults window resets whenever a gate injects a string user message, so an
        // early successful forget_skill can drop out of view and false-fire the skill_forget branch on a
        // restated claim. inTurnRecords is the whole-turn ledger and does not reset.
        const skillDeleteSucceededThisTurn = (signalBus.inTurnRecords ?? []).some(
          (r) => r.success && (r.toolName === 'forget_skill' || r.toolName === 'uninstallSkill'),
        );
        const honesty = evaluateHonesty(response.content, {
          toolResults: recentToolResults,
          userMessage: signalBus.userMessage,
          reasoningState: ownerReasoning ? memory.reasoning.summarizeSession(ownerReasoning.id) : null,
          detectAnnouncementStall: announceStallEnabled,
          skillDeleteSucceededThisTurn,
          // Turn-durable: the zero-tool branch must not false-fire just because a gate reset the
          // per-iteration window (prod: replyWithMedia succeeded, gate still cried "ZERO tool calls").
          turnHadAnyToolCall: (signalBus.inTurnRecords ?? []).length > 0,
          session: honestySessionEnabled
            ? {
                unkeptRunPromise: honestySessionStore.get(sessionId).unkeptRunPromise,
                priorViolations: honestySessionStore.get(sessionId).violationCount,
                fabricatedExecClaim: honestySessionStore.get(sessionId).fabricatedExecClaim,
              }
            : undefined,
        });
        // The session-claim adjudicator used to live here, inline, and nowhere else — which is how a
        // fabricated session sailed through the zero-tool exit on 2026-07-28 while the identical claim was
        // caught here two turns earlier. It is now a rule in the claim-grounding chain, evaluated the same
        // way on every exit. See claim_grounding.ts.
        const honestyVerdict = honesty;

        // Fold this turn into the latch BEFORE acting on the verdict: a fresh "现在跑" / announced-but-
        // did-nothing (0 tools) arms it; an actual execution clears it; a fire bumps the violation counter.
        if (honestySessionEnabled) {
          const announcedStall =
            announceStallEnabled &&
            recentToolResults.length === 0 &&
            !!findActionAnnouncement(response.content);
          honestySessionStore.update(sessionId, {
            promisedRun: !!findRunPromise(response.content) || announcedStall,
            didExecute: turnDidExecute(recentToolResults),
            fired: !!honestyVerdict,
            // Arms the sticky latch: from here on, an execution claim with zero execution tools gets no
            // free "sorry, I have not run it" exit — that exit is what it took last time.
            fabricatedExec: honestyVerdict?.reason === 'fabricated_execution_claim',
          });
        }
        if (!honestyVerdict) {
          // Explicitly print "passed" status so tests can see the gate actually ran + no false positives
          const okN = recentToolResults.filter((r) => r.content.startsWith('✓')).length;
          const failN = recentToolResults.filter((r) => r.content.startsWith('⚠')).length;
          console.log(
            `[honesty] session=${safeSessionId(sessionId)} passed (${okN} ok / ${failN} fail / ${recentToolResults.length} total)`,
          );
        }
        if (honestyVerdict) {
          honestyAttempts++;
          audit.append('self_domain_write', {
            source: 'honesty_gate',
            origin: 'Internal',
            toolName: 'honesty_gate_fired',
            sessionId,
            severity: honestyVerdict.severity,
            reason: honestyVerdict.reason,
            failCount: honestyVerdict.failCount,
            okCount: honestyVerdict.okCount,
            matchedClaim: honestyVerdict.matchedClaim,
          });
          recordControllerFire('honesty');
          console.warn(
            `[honesty] session=${safeSessionId(sessionId)} fired severity=${honestyVerdict.severity} reason=${honestyVerdict.reason} failCount=${honestyVerdict.failCount} okCount=${honestyVerdict.okCount} claim="${honestyVerdict.matchedClaim}"`,
          );
          // K7→K8 bridge: write fire to signalBus so the finally block produces a K8 initiative.
          // Take **the most recent** fire (honestyAttempts cap is 1 per turn; at most one overwrite).
          signalBus.honesty = {
            evaluation: honestyVerdict,
            toolResults: recentToolResults,
            assistantText: response.content,
          };
          // Leave what the LLM was about to say in messages (so it knows it almost lied / lacked verification),
          // then append an Internal-origin user message demanding a rewrite or verification first. The LLM
          // on the next iteration will see this reminder + its previous draft + actual tool results.
          messages.push({ role: 'assistant', content: response.content });
          // K9 Path B: upgrade "reactive negation" to "negation + step-by-step guidance";
          // following a procedure is more actionable for the LLM than simply saying "don't lie".
          // Each severity level has its own standard correction routine.
          let reminder: string;
          if (honestyVerdict.reason === 'fabricated_size_claim') {
            reminder =
              `[drive Honesty/fabricated_size] You just said "${honestyVerdict.matchedClaim}", but ${honestyVerdict.evidence}\n\n` +
              `**Verification steps (execute in order)**:\n` +
              `  1. Check the actual "bytes" value in the most recent stat / dir / ls / readFile / tool JSON output;\n` +
              `  2. **Compute the ratio**: claimed value ÷ actual value. E.g. claimed 577 KB / actual 18 bytes ≈ 30,000×.\n` +
              `     - Ratio < 1.5×: likely a unit conversion or rounding error — rewrite with the correct value;\n` +
              `     - Ratio > 10×: **this is fabrication, not an error** — tell the user the actual size in bytes;\n` +
              `  3. When rewriting, use the number the tool actually returned (rounding is fine, but do not invent a number);\n` +
              `  4. If the tool returned an anomalous value (e.g. an 18-byte .docx — files < 256 bytes are usually a JSON error body, not real binary),\n` +
              `     tell the user honestly "this looks wrong — the API may have returned an error response" — **do not pretend success**.\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.reason === 'fabricated_execution_claim') {
            // This is the branch that actually fired in prod (07-14), twice in one session — fabricate,
            // apologise, fabricate again. Step 4 below WAS the mechanism: "if you will not run it, say 'not
            // run yet'" is a free exit that costs nothing, satisfies the gate, and changes nothing, while the
            // pressure that produced the fabrication survives intact into the next turn. On a repeat the exit
            // is removed: the only non-execution reply that counts is a NAMED blocker, which an apology
            // cannot fake.
            reminder = honestyVerdict.repeatOffense
              ? `[drive Honesty/fabricated_execution · REPEAT] You wrote "${honestyVerdict.matchedClaim}", but ${honestyVerdict.evidence}\n\n` +
                `**You already did this once in THIS session, acknowledged it, and have now done it again. ` +
                `An apology is therefore not an acceptable reply — it did not work last time.**\n` +
                `  1. There is no result to report. No process started, no output was produced, no exit code was ` +
                `seen. Numbers you write down now would be invented;\n` +
                `  2. In THIS reply, CALL the execution tool (shell / pariGp) and report ONLY its ✓ / ⚠ output — ` +
                `writing the command in prose is not calling it;\n` +
                `  3. If you genuinely cannot run it, name the BLOCKER concretely: which tool is unavailable, ` +
                `which environment is missing, which credential you lack. "I have not run it yet" is a ` +
                `restatement, not a blocker, and will be rejected;\n` +
                `  4.${buildLanguageDirective(resolveResponseLanguage({ channel: sessionId, userLocale: readUserLanguage() }))}\n\n` +
                INTERNAL_CORRECTION_FOOTER
              : `[drive Honesty/fabricated_execution] You wrote "${honestyVerdict.matchedClaim}", but ${honestyVerdict.evidence}\n\n` +
                `**This is the most serious dishonesty: reporting results of a computation that never ran this turn.**\n` +
                `  1. Do NOT narrate numbers / eigenvalues / ratios / "shell 返回" you did not get from a tool THIS turn;\n` +
                `  2. In this same reply, actually CALL the tool (shell / pariGp) and wait for its ✓ / ⚠ output;\n` +
                `  3. Report ONLY what the tool returned — if it failed, say it failed;\n` +
                `  4. If you will not run it now, tell the user plainly "not run yet" — never invent the result;\n` +
                `  5.${buildLanguageDirective(resolveResponseLanguage({ channel: sessionId, userLocale: readUserLanguage() }))}\n\n` +
                INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.reason === 'run_promise_without_exec') {
            reminder =
              `[drive Honesty/say_do_gap] You said "${honestyVerdict.matchedClaim}" but issued no tool call — ${honestyVerdict.evidence}\n\n` +
              `**Announcing a run is not running. Close the say-do gap NOW:**\n` +
              `  1. In THIS reply, call the shell / pariGp tool to actually run it — do not end the turn on "现在跑";\n` +
              `  2. If you cannot or will not run it, say so plainly — do not promise a run you will not perform;\n` +
              `  3. Never end a turn with "I'll run it now" and no tool call — that is the exact loop the user flagged.\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.reason === 'announced_action_without_doing') {
            reminder =
              `[drive Honesty/say_do_gap] You announced "${honestyVerdict.matchedClaim}" but issued no tool call — ${honestyVerdict.evidence}\n\n` +
              `**Announcing is not doing. Close the stall NOW (the turn is about to end = you yield and the in-progress "…" hangs forever):**\n` +
              `  1. In THIS reply, actually take the action you announced — call webSearch / webFetch for research, or start deep_explore — do not end on a trailing "…";\n` +
              `  2. If you genuinely cannot act now (missing input / not your call), say so plainly and ask the user — do not narrate progress you are not making;\n` +
              `  3. Never end a turn with a present-progressive "I'm researching…" / a trailing "…" and zero tool calls — that is the exact stall the user flagged.\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.reason === 'skill_forget_claim_without_call') {
            reminder =
              `[drive Honesty/skill_forget] You said "${honestyVerdict.matchedClaim}" but issued no successful forget_skill / uninstallSkill call — ${honestyVerdict.evidence}\n\n` +
              `**Pick one of two paths — do not straddle**:\n` +
              `  Path A · Actually delete: in THIS reply CALL forget_skill — forget_skill(contains="mycox") to bulk-delete every self-learned skill mentioning it, or forget_skill(name="<exact-slug>") for one. Then report the deleted names the tool returned (deleted=[…]).\n` +
              `    - forget_skill removes DB-only self-learned skills; file-backed (bundled/installed) skills are protected and must go through uninstallSkill instead.\n` +
              `  Path B · Correct yourself: honestly tell the user you have NOT deleted anything yet — do not write "已清除 / deleted" or narrate a forget_skill(…) call you did not issue.\n\n` +
              `Writing the tool call in a Work Log is NOT calling it. Nothing was deleted until forget_skill returns ✓ with deleted names.\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.severity === 'high') {
            reminder =
              `[drive Honesty/high] Your draft reply contains a completion claim "${honestyVerdict.matchedClaim}", but ${honestyVerdict.evidence}\n\n` +
              `**Verification steps (execute in order)**:\n` +
              `  1. Re-read each tool_result prefix: ✓ TOOL OK / ⚠ TOOL FAILED;\n` +
              `  2. List the names of failing commands + exit code / error message (copy key sentences from ⚠ sections);\n` +
              `  3. In one sentence, distinguish: **what succeeded / what failed / what the user should do next**;\n` +
              `  4. Do not repeat "${honestyVerdict.matchedClaim}" — a success claim inconsistent with the failure count is a falsehood;\n` +
              `  5. If there is an untried reasonable path (different command / path / permissions), try one more tool call.\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else if (honestyVerdict.reason === 'memory_claim_without_write') {
            reminder =
              `[drive Honesty/memory_claim] You said "${honestyVerdict.matchedClaim}" but did not call store_fact — ${honestyVerdict.evidence}\n\n` +
              `**Pick one of two paths — do not straddle**:\n` +
              `  Path A · Actually persist: call store_fact(namespace, key, value), then reply to the user;\n` +
              `    - Preference/constraint → namespace=user, key=preferences.X / constraints.X\n` +
              `    - Project-related → namespace=project\n` +
              `    - Before writing, call get_fact to check existing value and merge rather than overwrite\n` +
              `  Path B · Correct yourself: honestly tell the user "I cannot persist that — please remind me next time" — do not pretend to have remembered.\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          } else {
            reminder =
              `[drive Honesty/${honestyVerdict.reason}] Your draft reply contains a completion claim "${honestyVerdict.matchedClaim}", but ${honestyVerdict.evidence}\n\n` +
              `**Principle: your reply must state facts, not subjective assertions.**\n` +
              `  ✓ Factual: "wrote /tmp/out.json (2.3 KB); stat shows mtime=now"\n` +
              `  ✗ Subjective: "done" / "completed" / "handled" — the user cannot verify these\n\n` +
              `**Ask yourself — if the user goes to verify right now, is this claim true?**\n` +
              `  - Not sure → you must verify first, then reply\n` +
              `  - Sure → include the evidence in your reply\n\n` +
              `**Artifact verification steps (execute in order)**:\n` +
              `  1. Call an observation tool to confirm the artifact exists and is reasonable:\n` +
              `     - File: readFile(path) or glob(pattern) or shell "stat path"\n` +
              `     - Edit: readFile to check that the expected new content is present\n` +
              `     - Create: glob to confirm the file is really at the expected path\n` +
              `     - API: call the read endpoint again to verify (e.g. GET /resource/{id})\n` +
              `  2. If verification reveals a problem → tell the user honestly and correct it — do not conceal;\n` +
              `  3. If verification confirms the claim → include concrete numbers / ids / paths / timestamps in your reply:\n` +
              `     ✓ "POST /register returned 201, user_id=abc123, stored via store_fact to project.<svc>.user_id"\n` +
              `     ✓ "wrote /tmp/out.json 2.3 KB, inspectPath confirms mtime=now + size > 0"\n` +
              `     ✗ "registration done" — no facts, same as saying nothing\n\n` +
              INTERNAL_CORRECTION_FOOTER;
          }
          pushGateDirective(messages, reminder);
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: `Honesty gate triggered (${honestyVerdict.severity}), verifying / rewriting`,
            meta: { gateName: 'Honesty', severity: honestyVerdict.severity },
          });
          continue;
        }
      }

      // Tier 1.3 EmptyConclusionGate: last line of defense before final emit —
      // HonestyGate handles "lying"; EmptyConclusionGate handles "did a bunch of things but said nothing".
      // In the PDF→Word case, after 3 shell calls the LLM returned only ".".
      if (emptyConclusionAttempts < 1) {
        const empty = evaluateEmptyConclusion({
          toolCallsThisTurn: totalToolCallsThisTurn,
          finalText: response.content,
        });
        if (empty.shouldRegenerate) {
          emptyConclusionAttempts++;
          // 2026-05-11 Phase 3: mark signalBus so that routing outcome backflow at turn close knows this turn failed
          signalBus.emptyConclusionFired = true;
          audit.append('self_domain_write', {
            source: 'empty_conclusion_gate',
            origin: 'Internal',
            toolName: 'empty_conclusion_gate_fired',
            sessionId,
            reason: empty.reason,
            toolCallsThisTurn: totalToolCallsThisTurn,
            finalTextLength: empty.detail?.finalTextLength ?? 0,
          });
          recordControllerFire('empty_conclusion');
          console.warn(
            `[empty-conclusion] session=${safeSessionId(sessionId)} fired reason=${empty.reason} toolCalls=${totalToolCallsThisTurn} finalLen=${empty.detail?.finalTextLength}`,
          );
          messages.push({ role: 'assistant', content: response.content });
          pushGateDirective(
            messages,
              `[drive EmptyConclusion] You made ${totalToolCallsThisTurn} tool calls this turn, but your final reply was ` +
              (empty.reason === 'empty_after_tools' ? 'completely empty' : `too short (only "${response.content.trim()}")`) +
              `. In one sentence, tell the user: what those calls did, what the result was, and what happens next.\n` +
              INTERNAL_CORRECTION_FOOTER,
          );
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'EmptyConclusion gate triggered, adding summary',
            meta: { gateName: 'EmptyConclusion' },
          });
          continue;
        }
      }
      // The regeneration itself can also come back empty (production 2026-08-22 10:46). Previously the
      // turn was labelled response and WeChat logged `produced no text`; never let a completed tool turn
      // disappear silently. This fallback contains only ledger counts, so it cannot fabricate a result.
      if (emptyConclusionAttempts >= 1) {
        const stillEmpty = evaluateEmptyConclusion({
          toolCallsThisTurn: totalToolCallsThisTurn,
          finalText: response.content,
        });
        if (stillEmpty.shouldRegenerate) {
          const fallback = renderEmptyConclusionFallback(
            signalBus.inTurnRecords ?? [],
            statusLang === 'en' ? 'en' : 'zh',
          );
          response = { ...response, content: fallback };
          memory.metrics.increment('empty_conclusion.fallback_emitted');
          console.error(
            `[empty-conclusion] session=${safeSessionId(sessionId)} regeneration stayed empty; emitted deterministic fallback`,
          );
        }
      }

      // Phase 15 (2026-05-18) HalfFinishedGate: "half-done and stopped" detection for slow tasks.
      //
      // Production root cause: after a few tool calls the LLM outputs "let me look first / I'm about to X" commitment text
      // and ends the turn, but the channel is fire-and-forget so the user never returns for the next turn.
      // Task hanging = heartbeat not started = onboarding half-done.
      //
      // Detection conditions (all generic; see half_finished_gate.ts):
      //   mode=slow + placeholder plan still in draft + commitment-type phrasing + 0 plan_update_step + no completion claim
      // Hit → cap=1 regen; inject strong constraint prompt to make the LLM actually advance the plan.
      //
      // env PHILONT_HALF_FINISHED_GATE=0 to disable.
      if (
        halfFinishedAttempts < 1 &&
        process.env.PHILONT_HALF_FINISHED_GATE !== '0'
      ) {
        try {
          const sidForHF = sessionId;
          const currentModeHF = taskModeStore.get(sidForHF);
          const sessionPlansHF = memory.plans.listBySession(sidForHF, { limit: 1 });
          const activePlanHF = sessionPlansHF[0];
          const planUpdateStepOk = (signalBus.inTurnRecords ?? []).filter(
            (r) => r.toolName === 'plan_update_step' && r.success,
          ).length;
          const hf = detectHalfFinishedTurn(response.content, {
            mode: currentModeHF === 'slow' ? 'slow' : 'fast',
            hasPlaceholderPlanInDraft:
              !!activePlanHF &&
              activePlanHF.status === 'draft' &&
              activePlanHF.isPlaceholder === true,
            hasPlanUpdateStepCallInTurn: planUpdateStepOk > 0,
          });
          if (hf) {
            halfFinishedAttempts++;
            audit.append('self_domain_write', {
              source: 'half_finished_gate',
              origin: 'Internal',
              toolName: 'half_finished_gate_fired',
              sessionId,
              reason: hf.reason,
              matchedPhrase: hf.matchedPhrase,
              planUpdateStepOk,
              activePlanId: activePlanHF?.id ?? null,
            });
            recordControllerFire('half_finished');
            console.warn(
              `[half-finished] session=${safeSessionId(sessionId)} fired reason=${hf.reason} phrase="${hf.matchedPhrase}" planUpdateOk=${planUpdateStepOk}`,
            );
            messages.push({ role: 'assistant', content: response.content });
            pushGateDirective(
              messages,
                `[drive HalfFinished] You just output "${hf.matchedPhrase}" — but this turn has a placeholder plan for a slow task,` +
                ` no plan_revise to promote it, and 0 plan_update_steps — equivalent to leaving without doing anything.\n\n` +
                `**This channel is fire-and-forget** — the user sends a message and moves on. "Let me look at this first / I'll do it next..." = task left hanging.\n\n` +
                `**Analogy: coding in Claude Code** — the plan is the code, tool calls are the runtime. You would not "study it and write it another day"; you plan + write + run + debug right now.\n\n` +
                `**This turn you must choose one of two paths**:\n` +
                `1. Make real progress — call plan_revise to split deliverables → plan_update_step("doing") → tool calls → plan_close\n` +
                `2. Genuinely blocked — call askUserQuestion (specifying what user input is missing) or plan_close(failure, "<specific blocker>")\n\n` +
                `**Do not repeat** promise-style phrases / "let me / I'll / next / later" etc. Reorganize your response.\n\n` +
                INTERNAL_CORRECTION_FOOTER,
            );
            onTrace?.({
              kind: 'internal-gate', tier: 4,
              text: 'HalfFinished gate triggered, forcing substantive progress this turn',
              meta: { gateName: 'HalfFinished' },
            });
            continue;
          }
        } catch (e) {
          console.warn('[half-finished] detector failed (ignored):', e);
        }
      }

      // Phase 17 (2026-05-18) PlanFailureFalseClaimGate: plan was mechanically forced to failed
      // (circuit breaker), or placeholder plan still in draft + LLM never called plan_close,
      // but final text contains a completion claim → cap=1 regen forces an honest admission of failure.
      //
      // Complements HonestyGate: HonestyGate relies on tool_result fail count; production revealed
      // register 404 and similar failures sometimes do not enter the fail count (extractRecentToolResults window /
      // formatToolResultContent prefix boundary etc.). This gate directly uses mechanism-layer signals (planCircuitBroken /
      // placeholder + no close) to determine failure state, **without relying on toolResults count**, plugging the honesty gap.
      //
      // env PHILONT_PLAN_FAILURE_GATE=0 to disable.
      if (
        planFailureFalseClaimAttempts < 1 &&
        process.env.PHILONT_PLAN_FAILURE_GATE !== '0'
      ) {
        try {
          const sidForFG = sessionId;
          const claim = findCompletionClaim(response.content);
          // Signal 1: plan-circuit-breaker fired
          const circuitBroken = signalBus.planCircuitBroken === true;
          // Signal 2: placeholder plan still in draft + LLM never truly called plan_close
          let placeholderUnclosed = false;
          if (!circuitBroken && !signalBus.planCloseCalled) {
            const sessionPlans = memory.plans.listBySession(sidForFG, { limit: 1 });
            const active = sessionPlans[0];
            placeholderUnclosed =
              !!active &&
              active.isPlaceholder === true &&
              (active.status === 'draft' || active.status === 'executing');
          }
          const fired = (circuitBroken || placeholderUnclosed) && !!claim;
          if (fired) {
            planFailureFalseClaimAttempts++;
            const reason = circuitBroken
              ? 'circuit_breaker_fired'
              : 'placeholder_plan_unclosed';
            audit.append('self_domain_write', {
              source: 'plan_failure_false_claim_gate',
              origin: 'Internal',
              toolName: 'plan_failure_false_claim_gate_fired',
              sessionId,
              reason,
              matchedClaim: claim,
            });
            console.warn(
              `[plan-failure-false-claim] session=${safeSessionId(sessionId)} fired reason=${reason} claim="${claim}"`,
            );
            messages.push({ role: 'assistant', content: response.content });
            pushGateDirective(
              messages,
                `[drive PlanFailureFalseClaim] Your final text contains "${claim}", but the mechanism layer determined that this turn's plan failed ` +
                `(${
                  circuitBroken
                    ? 'plan circuit-breaker fired = plan_* tools repeatedly failed; the task was not actually completed'
                    : 'placeholder plan is still draft + you never called plan_close = task left half-done'
                }).\n\n` +
                `**Do not lie**: this turn was a failure. Rewrite the final text:\n` +
                `1. **Do not include** completion claims like "completed / succeeded / done / finished"\n` +
                `2. Honestly state which deliverables failed, which were not done, and the root cause (from tool error / circuit-breaker reason)\n` +
                `3. If user action is needed (e.g. new invite_code / new credential / different param) → use \`## For User\` to write clearly "please provide X"\n` +
                `4. If some steps (e.g. schedule_reminder) succeeded while others failed → say honestly "setup partially succeeded, but register failed → heartbeat not started"\n\n` +
                INTERNAL_CORRECTION_FOOTER,
            );
            onTrace?.({
              kind: 'internal-gate', tier: 4,
              text: 'PlanFailureFalseClaim gate triggered, forcing honest failure acknowledgement',
              meta: { gateName: 'PlanFailureFalseClaim' },
            });
            continue;
          }
        } catch (e) {
          console.warn('[plan-failure-false-claim] detector failed (ignored):', e);
        }
      }

      // Phase 11 OutputFormatGate: last line of defense before final emit —
      // long final text (> 500 chars) but no `## For User` section → regenerate once; force the LLM
      // to use the standard two-section format. EmptyConclusionGate handles "said nothing"; OutputFormatGate handles
      // "said something but no section breaks" (WeChat and similar channels rely on ## For User to extract push content).
      //
      // env PHILONT_OUTPUT_FORMAT_GATE=0 to disable.
      // Scheduled turns are exempt: their reply goes to the schedule-outcome log (and channel
      // fallback already sends full text when the section is missing), so the two-section format
      // buys nothing there — while the regeneration cost one extra LLM call on EVERY heartbeat
      // (prod 2026-07-07: the gate fired on ~10 consecutive mycox check-ins).
      if (
        outputFormatAttempts < 1 &&
        process.env.PHILONT_OUTPUT_FORMAT_GATE !== '0' &&
        !sessionId.startsWith('system:scheduled:')
      ) {
        // A completed deep_explore round is work the user is owed a report on, so it cancels the
        // "short reply ⇒ simple query" exemption. Prod 2026-07-27 15:30:48: a 6-minute round
        // (`refuted 1; +1 dead ends; 10 still open`) was followed by a 17-character off-topic reply
        // with no section — under the length rule alone the gate never looked at it.
        // Match on the round-summary line renderProgressText emits, i.e. a string we produce ourselves.
        const reportableWork = extractRecentToolResults(messages).some(
          (r) => r.toolName === 'deep_explore' && r.content.includes('This round:'),
        );
        const fmt = evaluateOutputFormat({ finalText: response.content, reportableWork });
        if (fmt.shouldRegenerate) {
          outputFormatAttempts++;
          audit.append('self_domain_write', {
            source: 'output_format_gate',
            origin: 'Internal',
            toolName: 'output_format_gate_fired',
            sessionId,
            reason: fmt.reason,
            finalTextLength: fmt.detail?.finalTextLength ?? 0,
          });
          recordControllerFire('output_format');
          console.warn(
            `[output-format] session=${safeSessionId(sessionId)} fired reason=${fmt.reason} finalLen=${fmt.detail?.finalTextLength}`,
          );
          messages.push({ role: 'assistant', content: response.content });
          pushGateDirective(
            messages,
              (fmt.reason === 'reportable_work_no_user_section'
                ? `[drive OutputFormat] This turn RAN A REASONING ROUND and it returned a result, but your reply ` +
                  `(${fmt.detail?.finalTextLength} characters) has no \`## For User\` section and does not report that round. ` +
                  `The round's findings — what was decomposed, settled, refuted, ruled out, and what is still open — are the ` +
                  `only reason the user waited. Do not change the subject and do not drop them.\n\n`
                : `[drive OutputFormat] Your reply was ${fmt.detail?.finalTextLength} characters but did not use the required two-section format ` +
                  `(missing \`## For User\` heading). The frontend extracts content from the \`## For User\` section to push to users; ` +
                  `without it, the full text is sent as a fallback (verbose and unfocused).\n\n`) +
              `**Please rewrite your final reply** using the strict two-section format:\n` +
              `\n  ## For User\n` +
              `  (EVERYTHING the user should read. Status update → ≤ 200 chars, action result + key evidence + next step. ` +
              `Analysis / report / detailed answer → the COMPLETE deliverable goes HERE, full length — the user never sees Work Log, ` +
              `and "the report is in the previous message" is false if that message was never delivered)\n` +
              `\n  ## Work Log\n` +
              `  (Full process / tool call details / intermediate data — goes into timeline; user does not see this)\n` +
              INTERNAL_CORRECTION_FOOTER_NL,
          );
          onTrace?.({
            kind: 'internal-gate', tier: 4,
            text: 'OutputFormat gate triggered, rewriting two-section format',
            meta: { gateName: 'OutputFormat' },
          });
          continue;
        }
      }

      // Phase 18 (2026-06-15) ViabilityGate — the missing ACTUATOR. Runs last (after honesty/format have
      // settled truthfulness and shape) so it only changes the RECOMMENDATION inside an already-clean draft.
      // Reads the owner-scoped active reasoning session's sensors (barrier match / noProgressRounds / status /
      // same_root_cause / reflection recommend_stop) and, when the goal is doomed/stalled, forces one regen that
      // forbids the "要我继续吗" pitch and recommends stop/reframe. Counsel-only: never blocks the user's "继续".
      // env PHILONT_VIABILITY_GATE=0 to disable. See viability_gate.ts.
      if (process.env.PHILONT_VIABILITY_GATE !== '0') {
        try {
          // The doomed goal may live in a deep_explore reasoning session (read its barrier/stall sensors) OR
          // the loop may have moved into raw shell/patch/writeFile grinding with NO session — in which case the
          // gate runs session-less on the global same_root_cause signal (which counts that grinding's failures).
          const ownerSession = focusedReasoningSession(sessionId);
          const vSummary = ownerSession ? memory.reasoning.summarizeSession(ownerSession.id) : null;
          const allMatches: BarrierMatch[] = ownerSession
            ? matchBarriers([ownerSession.goal, ...ownerSession.assumptions].join('\n'))
            : [];
          const applied = allMatches.filter((m) => m.severity === 'applies');
          // A matched barrier whose GOAL is a famous open problem → the goal is categorically intractable here,
          // not a method to pivot. Prefer naming that barrier so the directive states the right problem.
          const openMatch = allMatches.find((m) => m.barrier.goalIsOpenProblem === true);
          let vSameRoot = 0;
          try {
            // Episode-scope the failure window (2026-06-17): floor sinceTs at the current reasoning
            // session's createdAt so same_root_cause counts only failures of THIS direction. Without this,
            // the global 24h ledger carried a saturated count across a user redirect → a brand-new direction
            // inherited "撞了 6 次" and was stopped before it ran once.
            const vSince = Math.max(
              Date.now() - 24 * 60 * 60_000,
              ownerSession?.createdAt ?? 0,
              episodeAnchorTs.get(sessionId) ?? 0,
            );
            vSameRoot = countSameRootCauseFailures(
              memory.actions.listRecentFailures({ sinceTs: vSince, limit: 30 }),
            );
          } catch {
            /* same_root_cause is one input of many; ignore lookup failure */
          }
          // Real attempts this episode = settled nodes (proved + dead_end) in the current session. Gates the
          // generic stop verdict: a direction with < MIN attempts can't be declared a wall (see viability_gate).
          const vAttemptsThisEpisode =
            (vSummary?.provedCount ?? 0) + (vSummary?.deadCount ?? 0);
          const advancedThisTurn = (signalBus.inTurnRecords ?? []).some(
            (r) => r.toolName === 'deep_explore' && r.success,
          );
          const vTurnCount = messages.filter(
            (m) => m.role === 'user' && typeof m.content === 'string',
          ).length;
          const priorPivotStreak = viabilityPivotStreak.get(sessionId) ?? 0;
          const v = computeViability({
            hasActiveSession: !!ownerSession,
            barrierApplies: applied.length > 0,
            barrierTitle: openMatch?.barrier.title ?? applied[0]?.barrier.title,
            barrierCircumvention: applied[0]?.barrier.circumvention,
            goalIsOpenProblem: !!openMatch,
            noProgressRounds: ownerSession?.noProgressRounds ?? 0,
            status: vSummary?.status ?? ownerSession?.status ?? null,
            provedCount: vSummary?.provedCount ?? 0,
            openFrontierCount: vSummary?.openFrontierCount ?? 0,
            sameRootCause: vSameRoot,
            turnCount: vTurnCount,
            recommendStop: signalBus.recommendStop === true,
            madeProgressThisTurn: advancedThisTurn && (ownerSession?.noProgressRounds ?? 1) === 0,
            repeatedPivotCount: priorPivotStreak,
            attemptsThisEpisode: vAttemptsThisEpisode,
            deadEndCount: vSummary?.deadCount ?? 0,
          });
          // Cross-task hijack guard (2026-07-01): when an active reasoning session exists but THIS turn
          // neither engaged it (no deep_explore call) nor pitched to continue it, the pivot directive would
          // hijack an UNRELATED task. Prod: a "删除豆瓣技能" turn (forget_skill succeeded, clean reply) got
          // pivoted into "模型选型推理当前状态…" because a stale never-closed model-selection session + a global
          // same_root_cause inflated by the failing mycox-heartbeat pump tripped the pivot score. The actuator
          // only makes sense on a reply that is actually pitching a doomed continuation of the session (or a
          // session-less doom-grind, whose existing behavior is preserved via !ownerSession).
          const vRelevantToThisTurn = viabilityActuatorRelevant({
            hasActiveSession: !!ownerSession,
            turnEngagedReasoning: (signalBus.inTurnRecords ?? []).some((r) => r.toolName === 'deep_explore'),
            replyPitchesContinuation: CONTINUATION_PITCH_RE.test(response.content),
          });
          if (v.verdict !== 'continue' && !vRelevantToThisTurn) {
            console.log(
              `[viability] session=${safeSessionId(sessionId)} verdict=${v.verdict} score=${v.score} SKIPPED — active session ` +
              `but this turn neither ran deep_explore nor pitched continuation (unrelated task); not hijacking. ` +
              `reasons=${v.reasons.join(',')}`,
            );
          } else {
          // Ratchet bookkeeping (once per turn): a non-continue verdict extends the streak; continue resets it.
          if (!viabilityStreakUpdated) {
            viabilityStreakUpdated = true;
            viabilityPivotStreak.set(sessionId, v.verdict === 'continue' ? 0 : priorPivotStreak + 1);
          }
          if (v.verdict !== 'continue' && viabilityAttempts < 1) {
            viabilityAttempts++;
            if (isStopVerdict(v.verdict)) {
              viabilityStopPending = true;
              viabilityStopReasoningId = ownerSession?.id ?? null;
            }
            audit.append('self_domain_write', {
              source: 'viability_gate',
              origin: 'Internal',
              toolName: 'viability_gate_fired',
              sessionId,
              verdict: v.verdict,
              score: v.score,
              reasons: v.reasons.join(','),
            });
            recordControllerFire('viability');
            console.warn(
              `[viability] session=${safeSessionId(sessionId)} fired verdict=${v.verdict} score=${v.score} reasons=${v.reasons.join(',')} hasSession=${!!ownerSession}`,
            );
            messages.push({ role: 'assistant', content: response.content });
            pushGateDirective(
              messages, buildViabilityDirective(v, {
                provedCount: vSummary?.provedCount ?? 0,
                openProblemNote: openMatch?.barrier.circumvention,
                hasReasoningSession: !!ownerSession,
                taskHint: (signalBus.userMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
              }),
            );
            onTrace?.({
              kind: 'internal-gate', tier: 4,
              text: `Viability gate ${v.verdict} (score=${v.score}), reframing recommendation`,
              meta: { gateName: 'Viability' },
            });
            continue;
          }
          // Budget already spent (the regen ran): a stop/intractable verdict downgrades the outcome at emit
          // regardless of whether the rewrite dropped the pitch — the actuator does not depend on compliance.
          if (isStopVerdict(v.verdict)) {
            viabilityStopPending = true;
            viabilityStopReasoningId = ownerSession?.id ?? null;
            if (CONTINUATION_PITCH_RE.test(response.content)) {
              console.warn(
                `[viability] session=${safeSessionId(sessionId)} continuation pitch persisted after regen → deterministic stop_and_report downgrade`,
              );
            }
          }
          } // end vRelevantToThisTurn else
        } catch (e) {
          console.warn('[viability] gate failed (ignored):', e);
        }
      }

      // Claim grounding — one chain, one regeneration. Formerly three hand-wired blocks here (citation,
      // numeric, announced-tool) and a different subset of them on every other exit; see
      // claim_grounding.ts for the coverage table that produced three shipped defects in three days.
      if (claimGroundingAttempts < 1) {
        const fired = await applyClaimGrounding({
          sessionId,
          text: response.content,
          messages,
          toolNames: toolDefs.map((d) => d.name),
          audit,
          signalBus,
          ownerReasoningActive: !!memory.reasoning.getMostRecentActiveSession(sessionId),
          onTrace,
        });
        if (fired) {
          claimGroundingAttempts++;
          continue;
        }
      }

      // Force deep_explore before emitting a flat answer. This is the path a flat-searching model
      // actually takes (it opened with a tool call, so handleChatSendInner's copy of this check was
      // never reached) — without it, an owner who explicitly approved the engine gets a flat answer.
      {
        const forced = await decideForcedDeepExploreCall(sessionId, response.content, signalBus, Date.now());
        if (forced) {
          messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: forced.id, name: forced.name, input: forced.input }] });
          return await runToolLoop(
            sessionId, messages, grants, audit,
            [forced],
            [], 0,
            onDelta, onAuthRequest, signalBus, onStatus, onTrace, statusLang,
          );
        }
      }

      return emitFinalText({
        sessionId,
        text: response.content,
        messages,
        audit,
        signalBus,
        onDelta,
        viabilityStop: { pending: viabilityStopPending, reasoningSessionId: viabilityStopReasoningId },
      });
    }

    // Same as #1: subsequent loop iterations also need to sanitize assistantMessage tool_use blocks
    const sanitizedAsst2 = sanitizeAssistantMessageBlocks(response.assistantMessage);
    if (sanitizedAsst2.stats.fixed > 0 || sanitizedAsst2.stats.rejected > 0) {
      console.warn(
        `[input-fix] assistantMessage tool_use blocks: total=${sanitizedAsst2.stats.totalToolUse} ` +
          `fixed=${sanitizedAsst2.stats.fixed} rejected=${sanitizedAsst2.stats.rejected}`,
      );
    }
    messages.push(sanitizedAsst2.msg);

    const nextResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];

    for (const call of response.calls) {
      // Interrupt teeth: user stopped → no longer execute subsequent tools; exit early.
      if (stopped()) return interruptedReturn();
      const prepared = sanitizeToolInput(call.input);
      const requiredCheck = prepared.input
        ? validateRequiredToolInput(prepared.input, tools.get(call.name)?.schema)
        : { valid: false as const, reason: prepared.reason ?? 'invalid tool input' };
      if (!prepared.input || !requiredCheck.valid) {
        const detail = requiredCheck.valid ? 'invalid tool input' : requiredCheck.reason;
        const reason = `tool input format error, blocked before authorization: ${detail}`;
        nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: reason });
        totalToolCallsThisTurn++;
        inTurnRecords.push({ toolName: call.name, success: false, resultText: reason });
        console.warn(`[tool] ${call.name} → pre-auth input rejected: ${detail}`);
        continue;
      }
      call.input = prepared.input;
      const classification = tools.classify(call.name, call.input);
      if (!classification) {
        nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: Unknown tool '${call.name}'` });
        totalToolCallsThisTurn++;
        continue;
      }

      {
        const redirect = forceTierClassifyRedirect(call, signalBus);
        if (redirect) {
          console.warn(`[intent-router] session=${safeSessionId(sessionId)} rejected task_mode_classify(slow) on force-tier deep_explore turn`);
          nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: redirect });
          totalToolCallsThisTurn++;
          inTurnRecords.push({ toolName: call.name, success: false, resultText: redirect });
          continue;
        }
      }

      // 2026-05-10: autonomous turn blacklist check must also be applied inside the main loop branch
      // (previously only checked on initial calls; subsequent iterations were missed)
      if (isAutonomousTurn && AUTONOMOUS_TURN_BLACKLIST.has(call.name)) {
        const reason = autonomousBlacklistReason(call.name);
        (signalBus.blockedTools ??= new Set()).add(call.name);
        console.warn(
          `[autonomous-blacklist] session=${safeSessionId(sessionId)} rejected ${call.name} (in main loop)`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_autonomous_blacklist',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'autonomous_blacklist',
          origin: 'Internal',
          toolName: 'autonomous_tool_blocked',
          sessionId,
          blockedTool: call.name,
        });
        continue;
      }

      // Phase 11 ResearchBeforeRetry(2026-05-14):
      // - calls research tool → unlocks flag (LLM has shown research intent)
      // - calls business tool (non-research, non-plan-gate exempt) and flag=true → blocked
      // - calls plan-gate exempt (plan_* / task_mode_classify) → not affected
      if (
        researchRequiredBeforeBusinessTool &&
        researchTriggerContext &&
        !isResearchTool(call.name) &&
        !isPlanGateExempt(call.name, classification, call.input)
      ) {
        const reminder = buildResearchReminder(
          researchTriggerContext.failedTool,
          researchTriggerContext.signature,
          call.name,
        );
        console.warn(
          `[research-before-retry] session=${safeSessionId(sessionId)} rejected ${call.name} (must research first, signature ${researchTriggerContext.signature})`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reminder,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reminder,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_research_before_retry',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'research_before_retry',
          origin: 'Internal',
          toolName: 'research_before_retry_blocked',
          sessionId,
          blockedTool: call.name,
          failedTool: researchTriggerContext.failedTool,
          signature: researchTriggerContext.signature,
        });
        continue;
      }
      if (researchRequiredBeforeBusinessTool && isResearchTool(call.name)) {
        // LLM chose to do research → unlock. Reset flag; next business tool call will be allowed.
        researchRequiredBeforeBusinessTool = false;
        console.log(
          `[research-before-retry] session=${safeSessionId(sessionId)} unlocked: ${call.name} is a research tool, business tools allowed`,
        );
      }

      // 2026-05-11: in-turn-reflection upgraded — once triggered, remaining calls to **the same tool** within this turn
      // are short-circuited by the mechanism layer (intercepted before PolicyGate). toolName from the signature head determines which.
      // Graceful degradation: if parsing fails → blockedToolAfterReflection stays null; normal flow unaffected.
      if (blockedToolAfterReflection !== null && call.name === blockedToolAfterReflection) {
        const reason =
          `[in-turn-reflection blocked] This turn has detected ≥ 2 same-root-cause failures from ${call.name}; the mechanism layer has disabled this tool until the next user turn.\n` +
          `Do not call ${call.name} again into the same wall. Instead, do one of the following:\n` +
          `  (a) Use store_note(importance=high) to record the root cause you identified (wrong auth? wrong endpoint? credential stored with prefix?), so the user sees it next turn\n` +
          `  (b) Use other tools (list_facts / get_fact / listCredentialNames / search_skills) to gather diagnostic information\n` +
          `  (c) Use the ## For User section to tell the user the blocker and what you need, then close out this turn`;
        console.warn(
          `[in-turn-tool-block] session=${safeSessionId(sessionId)} rejected ${call.name} (mechanism-layer disabled after in-turn-reflection)`,
        );
        nextResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: reason,
        });
        totalToolCallsThisTurn++;
        inTurnRecords.push({
          toolName: call.name,
          success: false,
          resultText: reason,
        });
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          params: call.input,
          result: 'rejected_by_in_turn_reflection',
          success: false,
        });
        audit.append('self_domain_write', {
          source: 'in_turn_tool_block',
          origin: 'Internal',
          toolName: 'in_turn_tool_blocked',
          sessionId,
          blockedTool: call.name,
        });
        continue;
      }
      if (mechanicalRetryTool !== null && call.name === mechanicalRetryTool) {
        if (mechanicalRetriesRemaining > 0) {
          mechanicalRetriesRemaining--;
        } else {
          const reason =
            `[mechanical-retry-limit] ${call.name} already failed twice with the same mechanical error ` +
            `and used its one repair retry this turn. Switch method or report the exact error; do not submit another variant.`;
          console.warn(`[mechanical-retry-limit] session=${safeSessionId(sessionId)} rejected ${call.name}`);
          memory.metrics.increment('inturn.mechanical_retry_blocked');
          nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: reason });
          totalToolCallsThisTurn++;
          inTurnRecords.push({ toolName: call.name, success: false, resultText: reason });
          continue;
        }
      }

      // Cleanup-turn scoping: a pure cleanup command must never perform external writes (prod:
      // clear turns fetched the guide and re-registered the service being cleared, burning invite
      // codes). Local tools and http GET stay available.
      if (signalBus.cleanupIntent) {
        const rejected = cleanupHttpWriteReject(call.name, call.input);
        if (rejected) {
          console.warn(`[cleanup-scope] session=${safeSessionId(sessionId)} rejected external write ${call.name} (cleanup turn)`);
          nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: rejected.error });
          totalToolCallsThisTurn++;
          inTurnRecords.push({ toolName: call.name, success: false, resultText: rejected.error });
          memory.actions.log({
            sessionId: GLOBAL_TIMELINE_SESSION_ID,
            toolName: call.name,
            params: call.input,
            result: 'rejected_by_cleanup_scope',
            success: false,
          });
          audit.append('self_domain_write', {
            source: 'cleanup_scope',
            origin: 'Internal',
            toolName: 'cleanup_http_write_blocked',
            sessionId,
            blockedTool: call.name,
          });
          continue;
        }
      }

      // Spec body guard for ALL turns (plan-loop steps have their own copy): when an installed
      // service skill documents the target host, a write with a non-JSON body or missing
      // documented required fields is corrected BEFORE sending. Prod: the scheduled check-in PUT
      // {content:string} at the memories endpoint every fire → server 500; the plan-loop guard
      // never saw it because scheduled turns run the legacy pipeline.
      if (call.name === 'http') {
        try {
          const skillsRoot = join(process.cwd(), '.philont', 'skills');
          const method = String(call.input.method ?? 'GET').toUpperCase();
          const specHost = new URL(String(call.input.url ?? '')).host.toLowerCase();
          // Same switch as the plan loop: an installed spec.json is an LLM-derived contract, and gating one
          // path while leaving the other enforcing it executes the decision only halfway. Prod 2026-07-20:
          // the plan loop logged `spec: OFF` and a scheduled turn on this path was still blocked by
          // `rejected_by_spec_request_guard` minutes later.
          const installedSpec = specCompileEnabled() ? findSpecForHost(specHost, skillsRoot) : null;
          // Full generic contract guard, driven only by the installed SpecDoc (host/auth/endpoints/body) so
          // every service spec is protected the same way. When the host is governed we check auth-header +
          // endpoint + body; when it is NOT, we check for host-drift against every other installed spec.
          let rej: { error: string; reason: string } | null = null;
          if (installedSpec) {
            const reqRej = specRequestGuard(call.input, installedSpec);
            const bodyRej = reqRej ? null : specBodyGuardReject(call.name, call.input, installedSpec);
            if (reqRej) rej = { ...reqRej, reason: 'rejected_by_spec_request_guard' };
            else if (bodyRej) rej = { ...bodyRej, reason: 'rejected_by_spec_body_guard' };
          } else {
            const driftRej = specHostDriftGuard(method, String(call.input.url ?? ''), skillsRoot);
            if (driftRej) rej = { ...driftRej, reason: 'rejected_by_spec_host_guard' };
          }
          if (rej) {
            console.warn(`[spec-contract-guard] session=${safeSessionId(sessionId)} blocked ${method} ${specHost} (${rej.reason})`);
            nextResults.push({ type: 'tool_result', tool_use_id: call.id, content: rej.error });
            totalToolCallsThisTurn++;
            inTurnRecords.push({ toolName: call.name, success: false, resultText: rej.error });
            memory.actions.log({
              sessionId: GLOBAL_TIMELINE_SESSION_ID,
              toolName: call.name,
              params: call.input,
              result: rej.reason,
              success: false,
            });
            continue;
          }
        } catch { /* unparseable URL — the base runner surfaces its own error */ }
      }

      // 2026-05-11: plan_protocol_gate — slow mode + plan not reviewed → only allow plan_* /
      // task_mode_classify. Forces the plan-review-execute-close protocol (six-step closed loop, inspired by OpenClaw).
      //
      // Trigger conditions:
      //   1. This session's taskMode === 'slow' (set by LLM proactively via classify)
      //   2. AND (no plan) OR (latest plan.status === 'draft')
      //   3. AND current tool is not in the plan_protocol exempt set (plan_* + task_mode_classify
      //      + Phase 10 P0 read-only research set)
      //
      // Unlock conditions: plan_update_step(status='doing') → status='executing' (M3 direct transition),
      // or task_mode_classify(fast) actively rolls back.
      //
      // fast mode / old sessions (no plan but mode=fast) are completely unaffected.
      //
      // Phase 10 P0 (2026-05-14): allow read-only research tools to prevent LLM from writing a plan from memory.
      // 2026-05-14 debug: PHILONT_PLAN_GATE_TRACE=1 enables detailed log to investigate resume path bypassing gate.
      {
        const mode = taskModeStore.get(sessionId);
        const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = sessionPlans[0];
        const exempt = isPlanGateExempt(call.name, classification, call.input);
        if (process.env.PHILONT_PLAN_GATE_TRACE === '1') {
          console.log(
            `[plan-gate-trace][secondary-iter] tool=${call.name} mode=${mode} plan=${lastPlan?.id ?? 'none'} planStatus=${lastPlan?.status ?? 'none'} reviewCount=${lastPlan?.reviewHistory.length ?? 0} exempt=${exempt}`,
          );
        }
      }
      if (taskModeStore.get(sessionId) === 'slow') {
        const sessionPlans = memory.plans.listBySession(sessionId, { limit: 1 });
        const lastPlan = sessionPlans[0];
        // M3 / Phase 11 (2026-05-15) tightened: only 'executing' passes through (same as first-iter).
        // Phase 18 + 2026-06-30 fix (mirror of first-iter): only a terminal plan closed THIS turn is a finished
        // same-turn task (auto-fast ok). A STALE terminal plan from a prior task must NOT downgrade a new slow
        // task — that bypasses the whole plan protocol (mycox: register/post ran with no plan_draft/review/revise).
        const terminalClosedThisTurn = terminalPlanClosedThisTurn(lastPlan?.status, lastPlan?.updatedAt, signalBus.turnStartedAt);
        if (terminalClosedThisTurn) {
          taskModeStore.set(sessionId, 'fast', `auto:terminal-plan:${lastPlan!.status}`);
          console.log(
            `[plan_protocol_gate] session=${safeSessionId(sessionId)} terminal plan ${lastPlan!.id} (${lastPlan!.status}) closed this turn → auto fast, ${call.name} allowed`,
          );
        }
        const planAllowsExec = lastPlan?.status === 'executing';
        const needsPlanReview = !planAllowsExec && !terminalClosedThisTurn;
        // A call the user JUST approved via the auth card is exempt: re-blocking it punishes the
        // approval and (prod 2026-07-07 09:06) left a narrated "sent" with nothing sent.
        const exempt = isPlanGateExempt(call.name, classification, call.input) ||
          signalBus.authApprovedCallId === call.id;
        // A recovery plan for X must not confiscate Y — see autoRecoveryScopedTool.
        const recoveryScoped = needsPlanReview && !exempt && autoRecoveryPlanScopeAllows(lastPlan, call.name);
        if (recoveryScoped) {
          console.log(
            `[plan_protocol_gate] session=${safeSessionId(sessionId)} auto-recovery plan (${lastPlan!.guideRef}) is scoped to its failing tool — ${call.name} allowed`,
          );
        }
        if (needsPlanReview && !exempt && !recoveryScoped) {
          const baseReason = !lastPlan
            ? `In slow mode, plan_draft has not been called to break down the task.`
            : lastPlan.status === 'draft'
              ? `plan ${lastPlan.id} is in draft status (${lastPlan.steps.length} steps, execution not started).`
              : lastPlan.status === 'failed'
                ? `plan ${lastPlan.id} was closed as failed. This plan is abandoned, but the task is unfinished — create a new plan_draft to continue.`
                : lastPlan.status === 'completed'
                  ? `plan ${lastPlan.id} was closed as completed. If you are starting a new task, call plan_draft first; do not run tools directly.`
                  : `plan ${lastPlan.id} is in status ${lastPlan.status} which is not in the allowed-execution set (executing).`;
          const planStateHint = !lastPlan
            ? 'plan_draft({deliverables, steps, task_signature, guide_ref}) — create a plan'
            : lastPlan.isPlaceholder
              ? `plan_revise({plan_id:"${lastPlan.id}", new_steps, new_deliverables, reason}) — promote the placeholder plan (new_deliverables required)`
              : lastPlan.status === 'draft'
                ? `plan_update_step({plan_id:"${lastPlan.id}", step_id:"${firstOpenStepId(lastPlan)}", status:"doing"}) — start executing the first step`
                : lastPlan.status === 'completed' || lastPlan.status === 'failed'
                  // See the zh copy above: a stale terminal plan can neither be revised nor re-closed,
                  // so pointing the model at plan_revise is a guaranteed dead end. Draft a NEW plan.
                  ? 'plan_draft({deliverables, steps, task_signature}) — the previous plan is closed; draft a NEW plan for this task'
                  : `plan_revise({plan_id:"${lastPlan.id}", ...}) — revise the plan path`;
          const closeHint = !lastPlan
            ? '(no active plan — skip to step 2)'
            : lastPlan.status === 'failed' || lastPlan.status === 'completed'
              ? `(plan ${lastPlan.id} is already closed — **do NOT call plan_close again (it will error)**; go straight to step 2 task_mode_classify(fast))`
              : `plan_close({plan_id:"${lastPlan.id}", outcome:"failure", summary:"misclassified task"})`;
          const reason =
            `[plan_protocol_gate] ${baseReason}\n` +
            `Tool ${call.name} has been disabled by the mechanism layer until the plan reaches executing status.\n\n` +
            `**This is not a bug — it is the slow protocol design.** You have 3 choices:\n\n` +
            `A) This task **needs a plan** (multiple deliverables or multi-step dependencies):\n` +
            `   1. ${planStateHint}\n` +
            `   2. plan_update_step({plan_id, step_id, status:"doing"}) — start execution\n` +
            `   3. Then ${call.name} will be unblocked automatically\n\n` +
            `B) This task **does not need a plan** (single call, or read-only research):\n` +
            `   1. ${closeHint} — close the placeholder plan\n` +
            `   2. Wait 60 s cooldown, then call task_mode_classify({mode:"fast", reason:"..."})\n` +
            `   3. Retry ${call.name}\n\n` +
            `C) You are **stuck**:\n` +
            `   - list_facts / search_skills to look up relevant history\n` +
            `   - webFetch guide_ref to re-read the guide\n` +
            `   - plan_revise to revise the plan (if the current path is wrong)\n\n` +
            `**Do not retry ${call.name} unchanged** — it will be blocked again.`;
          console.warn(
            `[plan_protocol_gate] session=${safeSessionId(sessionId)} rejected ${call.name} (slow + planStatus=${lastPlan?.status ?? 'none'})`,
          );
          nextResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: reason,
          });
          totalToolCallsThisTurn++;
          inTurnRecords.push({
            toolName: call.name,
            success: false,
            resultText: reason,
          });
          memory.actions.log({
            sessionId: GLOBAL_TIMELINE_SESSION_ID,
            toolName: call.name,
            params: call.input,
            result: 'rejected_by_plan_protocol_gate',
            success: false,
          });
          audit.append('self_domain_write', {
            source: 'plan_protocol_gate',
            origin: 'Internal',
            toolName: 'plan_protocol_gate_blocked',
            sessionId,
            blockedTool: call.name,
            planStatus: lastPlan?.status ?? 'no-plan',
            planId: lastPlan?.id ?? null,
          });
          continue;
        }
      }

      const { capability, domain } = classification;
      const denial2 = await checker({ toolName: call.name, approval: 'never', params: JSON.stringify(call.input) });
      // 2026-05-28: secondary-iter also uses autogrant (consistent with first-iter 4898).
      // Previously only changed first-iter, missing this one → write/execute in the 2nd+ LLM call
      // still paused → multiple tool_use 401. Sandbox benchmarks must allow both places for fully pause-free operation.
      const autoGrant2 = process.env.PHILONT_AUTO_GRANT === '1';
      const allowed = denial2 === null || autoGrant2 || isAuthExemptManagementCall(call);
      if (autoGrant2 && denial2 !== null) {
        console.warn(
          `[auto-grant] session=${safeSessionId(sessionId)} allowed ${call.name} (${capability}×${domain})[secondary-iter]— PHILONT_AUTO_GRANT=1`,
        );
      }

      if (!allowed) {
        const remainingCalls = response.calls.slice(response.calls.indexOf(call) + 1);
        pendingAuth.set(sessionId, {
          goal: signalBus.carriedExploreGoal ?? carriedIntent.get(sessionId)?.goal ?? findLastUserText(messages) ?? '',
          executionState: 'awaiting_auth',
          callLedger: [
            ...nextResults.map((r) => ({ id: r.tool_use_id, name: ledgerToolName(r.tool_use_id, response.calls), state: 'completed' as const })),
            { id: call.id, name: call.name, state: 'awaiting_auth' as const },
            ...remainingCalls.map((c) => ({ id: c.id, name: c.name, state: 'queued' as const })),
          ],
          capability, domain,
          toolName:   call.name,
          toolCallId: call.id,
          input:      call.input,
          remainingCalls,
          collectedResults: nextResults,
          iteration: i,
          inflightMessages: [...messages],
          priorInTurnRecords: [...(signalBus.inTurnRecords ?? [])],
          ts: Date.now(),
        });
        persistContinuation(sessionId);

        onAuthRequest({ requestId: call.id, toolName: call.name, capability, domain, input: call.input });
        return { outcome: { outcomeType: 'auth_pending' }, auditEvents: audit.length };
      }

      // 2026-05-19 three-stream separation: tool details → onTrace; semantic progress → onStatus
      onTrace?.({
        kind: 'tool-invocation', tier: 3,
        text: summarizeToolInvocation(call.name, call.input),
        meta: { toolName: call.name },
      });
      onStatus?.(semanticToolPhrase(call.name, call.input, statusLang));
      // Same as main loop: sanitize tool input (prevent multiple JSON concatenation)
      const sanitized2 = sanitizeToolInput(call.input);
      let result;
      if (sanitized2.input === null) {
        console.warn(
          `[tool] ${call.name} → input rejected: ${sanitized2.reason ?? 'unknown'} (path=${sanitized2.path})`,
        );
        result = {
          success: false,
          output: '',
          error: `tool input format error, blocked: ${sanitized2.reason ?? 'unknown'}`,
          duration: 0,
        };
      } else {
        if (sanitized2.path !== 'object') {
          console.warn(
            `[tool] ${call.name} → input sanitized: path=${sanitized2.path}`,
          );
        }
        if (isDeepExploreAdvance(call) && deepExploreAdvancesThisTurn >= 1) {
          console.warn(`[deep-explore] blocked 2nd advance this turn (one round/turn cap)`);
          result = { success: true, output: DEEP_EXPLORE_ONE_ROUND_MSG, duration: 0 };
        } else {
          if (isDeepExploreAdvance(call)) deepExploreAdvancesThisTurn++;
          result = await tools.execute(call.name, sanitized2.input);
        }
      }
      settleRunningPendingAuth(sessionId, call.id);
      const originalInput2 = (sanitized2.input ?? call.input) as Record<string, unknown>;
      const repair2 = await maybeMechanicalRepair({ name: call.name, input: originalInput2 }, result);
      result = repair2.result;
      const actualInput2 = repair2.repairedInput ?? originalInput2;
      onTrace?.({
        kind: 'tool-result', tier: 3,
        text: summarizeToolResult(result),
        meta: { toolName: call.name, success: result.success },
      });
      if (!result.success) {
        onStatus?.(semanticToolFailPhrase(call.name, statusLang));
      }
      const rawResultText = formatToolResultContent(result) + repair2.notice;
      nextResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: truncateToolResultContent(rawResultText),
      });
      totalToolCallsThisTurn++;
      const ledgerRows2 = repairLedgerRows({
        originalInput: originalInput2,
        originalFailure: repair2.originalFailure,
        repairedInput: repair2.repairedInput,
        finalResult: result,
      });
      if (repair2.originalFailure && repair2.repairedInput) {
        const originalError = repair2.originalFailure.error ?? repair2.originalFailure.output ?? '';
        inTurnRecords.push({ toolName: call.name, success: false, resultText: originalError });
        const failedRow = ledgerRows2[0];
        memory.actions.log({
          sessionId: GLOBAL_TIMELINE_SESSION_ID,
          toolName: call.name,
          ...failedRow,
          linkedSkill: signalBus.activeSkillName,
        });
      }
      // 2026-05-10: trace for in-turn failure pattern detector (subsequent turns within the main loop also tracked)
      // 2026-05-17: http tool stores toolInput for ScheduleOutcome aggregation at scheduled turn close
      inTurnRecords.push({
        toolName: call.name,
        success: result.success,
        resultText: result.success ? (result.output ?? '') : (result.error ?? result.output ?? ''),
        toolInput: call.name === 'http' ? actualInput2 : undefined,
      });
      rememberFormalVerificationEvidence(sessionId, call.name, actualInput2, result);
      if (result.success && mechanicalRetryTool === call.name) {
        // The repair worked: this is no longer the same mechanical wall, so normal multi-call
        // compute workflows may continue. Only a failed repair exhausts the turn-local latch.
        mechanicalRetryTool = null;
        mechanicalRetriesRemaining = 0;
      }
      // Layer 0.5: subsequent turn actions go into the global timeline
      const finalLedgerRow = ledgerRows2[ledgerRows2.length - 1];
      memory.actions.log({
        sessionId: GLOBAL_TIMELINE_SESSION_ID,
        toolName: call.name,
        ...finalLedgerRow,
      });
    }

    if (nextResults.length === 0) {
      // Production (2026-05-08): after the rescue mechanism, response.type='toolCalls' occasionally appears but
      // calls is empty (LLM outputs stop_reason=tool_use but content has no tool_use blocks,
      // or all calls were discarded by sanitize). Throwing would kill the entire turn and the user gets nothing.
      // Changed to break out of the loop and fall back to deterministic summary, describing what was already done.
      console.warn(
        `[runToolLoop] iter=${i}: response.type=toolCalls but calls=${response.calls.length} → degrading to summary fallback`,
      );
      onTrace?.({
        kind: 'loop-control', tier: 4,
        text: 'LLM returned empty tool_calls, falling back to deterministic summary',
      });
      break;
    }
    messages.push({ role: 'user', content: nextResults });
  }

  // Force deep_explore BEFORE summarizing away a flat run. A model that ignores the deep_explore nudge
  // and flat-searches burns the whole iteration budget doing it, so this cap is precisely where such a
  // turn lands (prod 2026-07-13: owner approved the engine via the ask tier, the model then ran 22
  // webSearches and hit the 20-round cap — summarized flat, engine never entered). Passing '' as the
  // assistant text means only force-START can fire here (force-CONTINUE keys off recited round text,
  // which does not exist yet at the cap) — correct: there is no narration to catch, only a missing engine.
  {
    // Never when the CLOCK ended the loop: a forced round is a fresh 15-minute engine call, and the whole
    // point of stopping early was that there is no time left to spend.
    const forced = outOfTime ? null : await decideForcedDeepExploreCall(sessionId, '', signalBus, Date.now());
    if (forced) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: forced.id, name: forced.name, input: forced.input }] });
      return await runToolLoop(
        sessionId, messages, grants, audit,
        [forced],
        [], 0, // fresh iteration budget: the forced engine round must not inherit the exhausted counter
        onDelta, onAuthRequest, signalBus, onStatus, onTrace, statusLang,
      );
    }
  }

  // maxIterations fallback: force the LLM to summarize all its previous attempts in text-only mode once;
  // no further tool calls allowed (tool_choice='none' is not supported by the current adapter; use a strong system section
  // prompt + pass no tools instead). This gives the user a meaningful wrap-up narrative rather than a cold
  // "⚠️ maxIterations"。
  onStatus?.(summarizingPhrase(statusLang));
  onTrace?.({
    kind: 'loop-control', tier: 4,
    text: outOfTime
      ? 'Out of time for this turn, forcing a summary'
      : `Reached the ${effectiveMax}-round tool limit, forcing a summary`,
    meta: { iteration: effectiveMax },
  });

  // task failure audit: hitting the iter cap → failure_recovery_inject hits on the next turn,
  // injecting "hit cap last time, use planAndExecute this turn" hint.
  {
    const recentToolNames: string[] = [];
    for (let j = messages.length - 1; j >= 0 && recentToolNames.length < 5; j--) {
      const m = messages[j];
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && typeof block === 'object' && (block as any).type === 'tool_use') {
            const n = (block as any).name;
            if (typeof n === 'string') recentToolNames.unshift(n);
            if (recentToolNames.length >= 5) break;
          }
        }
      }
    }
    internalAudit.append('task_failure_mode', {
      sessionId,
      kind: 'iter_cap_hit',
      ts: Date.now(),
      detail: `hit ${effectiveMax}-round tool limit; last ${recentToolNames.length} tools: ${recentToolNames.join(' → ')}`,
    });
  }
  try {
    pushGateDirective(
      messages,
        (outOfTime
          ? `[drive time-budget wrap-up] This turn has used its whole time budget (${Math.round(TURN_HARD_DEADLINE_MS / 60_000)} min) ` +
            `after ${totalToolCallsThisTurn} tool calls, and there is only enough left for this one reply. ` +
            `Say plainly that you ran out of time, and report what you ACTUALLY established — not what you intended to do.`
          : `[drive maxIterations fallback] You have made ${totalToolCallsThisTurn} consecutive tool calls without giving the user a text reply.`) +
        `\n**No more tool calls are allowed.** Write a paragraph telling the user:` +
        `\n  - Which commands / paths you tried (list the 3-5 most important ones)` +
        `\n  - The specific reason each one failed (copy key phrases from the tool_result)` +
        `\n  - What the user can do next (try manually / change approach / provide more information)` +
        INTERNAL_CORRECTION_FOOTER_NL,
    );
    // Call LLM, pass no tools, force text-only output
    let summary = await sendLlmWithRescue(messages, [], sessionId, onTrace);
    // Claim grounding on the THIRD exit. This one had no controllers at all — not honesty, not numeric,
    // not citation — and decideForcedDeepExploreCall's own header notes that a flat-searching model
    // "reliably exits via that last one". A turn that burned its whole iteration budget failing is
    // exactly the turn most tempted to summarise work it did not do.
    if (summary.type === 'text') {
      const fired = await applyClaimGrounding({
        sessionId,
        text: summary.content,
        messages,
        toolNames: [],
        audit,
        signalBus,
        ownerReasoningActive: !!memory.reasoning.getMostRecentActiveSession(sessionId),
        onTrace,
      });
      if (fired) summary = await sendLlmWithRescue(messages, [], sessionId, onTrace);
    }
    if (summary.type === 'text') {
      return emitFinalText({ sessionId, text: summary.content, messages, audit, signalBus, onDelta });
    }
    // If the LLM still wants to call tools (theoretically should not, since toolDefs is empty), it falls to the original maxIterations
  } catch (e) {
    // 2026-05-07: when the LLM fallback summary also fails (60s timeout / API error), use a deterministic
    // summary assembled from tool_result history to give to the user. **Never let the user receive nothing at all**.
    console.warn('[maxIterations fallback] LLM summary failed, falling back to deterministic summary:', e);
    onTrace?.({
      kind: 'system-event', tier: 4,
      text: `LLM summary failed (${String(e).slice(0, 120)}), falling back to local deterministic summary`,
    });
    const recentResults = extractRecentToolResults(messages);
    const detSummary = renderDeterministicMaxIterSummary(
      totalToolCallsThisTurn,
      recentResults,
      effectiveMax,
    );
    onDelta(detSummary);
    memory.raw.appendMessage({
      sessionId: GLOBAL_TIMELINE_SESSION_ID,
      role: 'assistant',
      content: detSummary,
      originSessionId: sessionId,
    });
    return {
      outcome: { outcomeType: 'response', text: detSummary },
      auditEvents: audit.length,
    };
  }
  return { outcome: { outcomeType: 'terminated', reason: 'maxIterations' }, auditEvents: audit.length };
}

// renderDeterministicMaxIterSummary has been extracted to server/src/max_iter_summary.ts
