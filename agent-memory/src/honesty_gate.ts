/**
 * HonestyGate — checks whether the LLM's final text matches the actual tool results.
 *
 * Not a traditional drive. Traditional drives fire in beforeTurn → injected into the next turn,
 * but by then the lie has already been sent to the user. HonestyGate **inline-intercepts**
 * after final text is generated but before `onDelta` is pushed:
 *
 *   1. Scans LLM text for "completion claim" patterns (成功/完成/已生成/installed/etc)
 *   2. Scans tool_result content for this turn (written by chat-handler `formatToolResultContent`,
 *      failures prefixed with ⚠ TOOL FAILED, successes with ✓ TOOL OK)
 *   3. If there is a completion claim but no "success" support in tool_results this turn → trigger
 *      If failure count ≥ success count → high severity (almost certainly lying)
 *
 * Callers (chat-handler) that receive a high severity result should:
 *   - Log to audit (honesty_gate_fired)
 *   - Inject a reminder message ("You just said X is done, but N tool failures, 0 successes")
 *   - Call LLM again once, cap=1 retry within the same turn
 *
 * Design invariants:
 *   - Pure synchronous function, no LLM calls, no IO
 *   - Prefer false negatives over false positives: vague language (probably, should, looks like) is not a completion claim
 *   - User quotations / rhetorical questions don't count (patterns only match declarative "completed" statements)
 */

// ── Completion claim patterns ───────────────────────────────────────────────────────
//
// Chinese: action verb + (成功|完成|完毕|好了|搞定) or (已|已经) + the above
// English: successfully / completed / installed / created / done / fixed
//
// False-positive suppression: all matched in declarative form; questions / negations / conditionals do not match.
const COMPLETION_PATTERNS: ReadonlyArray<RegExp> = [
  // Chinese action + success-type (2026-05-14 Phase 10 P0: added verbs like 注册/登录/订阅/启动
  // for real-world scenarios. Missing 注册 caused "MycoX 注册完成 ✅" to not be recognized as a completion claim.)
  /(?:转换|安装|生成|写入|下载|部署|修复|更新|创建|配置|删除|执行|运行|保存|导出|发布|提交|推送|注册|登录|注销|订阅|取消订阅|加入|退出|启动|停止|重启|连接|断开|同步|备份|还原|上传|发送|接收|启用|禁用|绑定|解绑|加密|解密)[^。！？\n]{0,12}(?:成功|完成|完毕|好了|搞定)/,
  // Chinese 已-completed (same verb additions)
  /(?:已经|已)[^。！？\n]{0,8}(?:成功|完成|生成|写入|安装|创建|更新|配置|完毕|做完|搞定|修复|删除|存在|保存|导出|发布|注册|登录|订阅|连接|启动|启用|绑定|同步|发送|加密)/,
  // "File X already exists / already generated / confirmed exists"
  /(?:文件|报告|脚本|目录|压缩包|镜像)[^。！？\n]{0,10}(?:已).{0,4}(?:存在|生成|写入|创建|保存|更新|发布)/,
  /确认[^。！？\n]{0,6}(?:存在|创建|生成|完成|注册|登录)/,
  // 英文
  /\b(?:successfully|completed|installed|created|deployed|generated|fixed|done|built|published|registered|signed[\s-]?in|signed[\s-]?up|logged[\s-]?in|subscribed|connected|launched|enabled)\b/i,
  /\bhas\s+been\s+(?:installed|created|generated|completed|deployed|fixed|saved|published|registered|enabled|subscribed|connected|launched)\b/i,
];

// ── Memory claim patterns (P0 new addition) ──────────────────────────────────────────────
//
// "已记住 / 记下了 / 我会记住 / I'll remember" class.
// If the agent says this but no memory_write tool (store_fact / set_fact / etc) was called this turn →
// equivalent to a silent lie. This is a pattern explicitly forbidden by the system prompt but frequently violated by LLMs.
//
// Note: does not capture `存了?` / `存档了?` — words like `存在` / `存放` would cause false positives.
// In Chinese, "memory commitment" natural expressions are just 记住 / 记下 / 备忘, which is sufficient.
const MEMORY_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // Standalone statements: "我已经记住了" / "记下了" / "备忘"
  // Requires modal (已经/已/这就/马上) or preceding sentence start/punctuation, to avoid false matches in long compound sentences
  /(?:^|[，,。.;:!\s])(?:我)?(?:已经|已|这就|马上|那)?\s*(?:记住|记下|备忘)了?/,
  // "我会/我能/以后/下次/今后 + 记住/记得"
  /(?:我会|我能|以后|下次|今后|从此)\s*(?:记住|记得|留意|遵守|执行|应用)/,
  // 英文(remember/remembered/noting/memorize 等都接受)
  /\bI(?:'?ll| will| have|'?ve)?\s+(?:remember(?:ed)?|not(?:e|ed|ing)|memoriz(?:e|ed|ing)|keep|kept|stored?)\b/i,
  // "I'll keep this in mind" / "keep that in mind" 习语
  /\b(?:I(?:'?ll| will)?\s+)?keep\s+(?:that|this|it)\s+in\s+mind\b/i,
  /\bnoted\b(?!\s+down)/i,  // "Noted." 单独成句也算
];

// ── Skill-deletion claim patterns (self-learned skill governance) ─────────────────────────
//
// "已删除/清除/忘记了 mycox 技能" class. Self-learned skills live DB-only; the model deletes them via
// forget_skill (or file-backed ones via uninstallSkill). Production (WeChat "清除mycox相关技能"): the
// model replied "✅ 6 个 mycox 相关自学习技能已全部清除。…调用 forget_skill(contains=…)" with tools=0 —
// it NARRATED the tool call in prose and never issued it. This escapes every existing branch: the
// completion vocab lacks 清除/清空, and the zero-tools branch only catches file-PATH artifacts.
// Mirror memory_claim_without_write: a skill-deletion claim with no forget_skill/uninstallSkill success
// this turn is a silent lie → regen forces the real call.
//
// Assertive past/present completion only — future intent ("我这就删") that DID call the tool passes on
// tool success; that DID NOT call is a real stall we still want to fire. Screened: negation, questions/
// offers ("需要我删吗"), and user quotation.
const SKILL_FORGET_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  // 动词 + …技能:"清除了 mycox 技能" / "已删除相关技能" / "卸载了那个技能"
  // (no \b after 技能 — CJK chars are non-word in JS regex, so \b never holds there)
  /(?:删除|删掉|清除|清掉|清空|清光|移除|卸载|清理|忘记|遗忘)(?:了|完|掉|干净)?[^。！？\n]{0,14}技能/,
  // 技能 + …动词:"技能已全部清除" / "6 个技能都删掉了"
  /技能[^。！？\n]{0,12}(?:已经?|都|全部|均)?[^。！？\n]{0,4}(?:删除|删掉|清除|清空|清光|移除|卸载|清理)(?:了|完|干净)?/,
  // English verb → skills
  /\b(?:deleted|removed|cleared|forgot|forgotten|uninstalled|purged|wiped)\b[^.!?\n]{0,24}\bskills?\b/i,
  // English skills → verb
  /\bskills?\b[^.!?\n]{0,24}(?:have\s+been|were|are|is|was)\s+(?:deleted|removed|cleared|forgotten|uninstalled|purged|wiped)\b/i,
];

// Screen questions / offers / negation / user quotation — these are not completion claims.
const SKILL_FORGET_ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:没有?|未|无法|不能|尚未|还没|无需|不必)[^。！？\n]{0,8}(?:删除|删掉|清除|清空|移除|卸载|清理)/,
  /(?:是否|要不要|需要|能否|可否|可以帮你?|要我|帮你|是不是)[^。！？\n]{0,12}(?:删除|清除|移除|卸载|清理)/,
  /(?:你说|您说|用户说|刚才说|你要求|您要求|你想|您想)[^。！？\n]{0,24}(?:删除|清除|移除|卸载)/,
  /\b(?:want|would you like|should i|shall i|do you want)[^.!?\n]{0,20}(?:delete|remove|clear|uninstall|forget)/i,
  /\b(?:no|not|cannot|can'?t|couldn'?t|won'?t|didn'?t|haven'?t|never)\b[^.!?\n]{0,12}\b(?:delete|remove|clear|uninstall|forget)/i,
];

/** Tools whose success legitimately backs a "I deleted/forgot the skill" claim. */
const SKILL_DELETE_TOOLS: ReadonlySet<string> = new Set(['forget_skill', 'uninstallSkill']);

/**
 * Cleanup-DONE framing: "已清理干净 / 清除完毕 / 都清掉了 / cleaned up" — a completion claim about the cleanup
 * as a whole, where the delete verb and 技能 are separated by a long clause (or spaces), so the
 * verb→技能 adjacency patterns miss it. Prod: "已清理干净，当前无使用次数为 0 的自学习技能残留" (tools=0) slipped
 * through. Only counts when the text also mentions skills (SKILL_MENTION_RE), so "把桌面清理干净" never trips.
 */
const SKILL_CLEANUP_DONE_RE =
  /(?:清理|清除|清空|清掉|清光)(?:干净|完毕|完成|好了|完|了)|\b(?:cleaned|cleared|purged|wiped)\s*(?:up|out|clean)?\b/i;
const SKILL_MENTION_RE = /技能|\bskills?\b/i;

/**
 * Find a "已删除/清除…技能" completion claim, suppressing questions / negations / quotation. null if none.
 */
export function findSkillForgetClaim(text: string): string | null {
  for (const re of SKILL_FORGET_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const at = m.index;
    const ctx = text.slice(Math.max(0, at - 24), at + m[0].length + 12);
    if (SKILL_FORGET_ANTI_PATTERNS.some((anti) => anti.test(ctx))) continue;
    return m[0].slice(0, 60);
  }
  // Cleanup-done framing (verb and 技能 separated) — only when the reply is about skills.
  if (SKILL_MENTION_RE.test(text)) {
    const m = SKILL_CLEANUP_DONE_RE.exec(text);
    if (m) {
      const at = m.index;
      const ctx = text.slice(Math.max(0, at - 24), at + m[0].length + 12);
      if (!SKILL_FORGET_ANTI_PATTERNS.some((anti) => anti.test(ctx))) return m[0].slice(0, 60);
    }
  }
  return null;
}

// ── Tool function classification (verify-before-claim) ────────────────────────────────

// "Non-completion" context to suppress false positives — skip matching when these phrases appear.
// Typical scenarios: agent quoting the user, describing failures, or saying "if X completes" in a conditional.
const ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  // Explicit negation / failure statements
  /(?:没有|未|没|失败|不存在|无法|不能|尚未)[^。！？\n]{0,10}(?:成功|完成|生成|安装)/,
  // Rhetorical questions / conditionals
  /(?:如果|要是|是否|能否)[^。！？\n]{0,15}(?:成功|完成)/,
  // User quotation ("you said...")
  /(?:你说|你刚才说|您说|用户说)[^。！？\n]{0,30}(?:成功|完成)/,
  // Modal / uncertainty hedge — agent admitting uncertainty is not lying (it's honestly saying "I don't know")
  /(?:应该|可能|大概|也许|或许|估计|看起来|貌似)[^。！？\n]{0,8}(?:成功|完成|生成)/,
  /\b(?:probably|likely|maybe|perhaps|estimated|appears\s+to\s+be)\b[^.!?\n]{0,20}(?:complete|success|done)/i,
];

// ── tool_result signals ───────────────────────────────────────────────────

const TOOL_OK_MARK = '✓ TOOL OK';
const TOOL_FAIL_MARK = '⚠ TOOL FAILED';

/**
 * Classify a tool result as success/failure/unknown. Recognizes the ✓/⚠ prefix
 * output by chat-handler's formatToolResultContent. Other forms (old format "Error: ..."
 * or externally assembled) are treated as "unknown" — don't proactively classify as failure to avoid false positives.
 */
export function classifyToolResult(content: string): 'ok' | 'fail' | 'unknown' {
  if (content.startsWith(TOOL_OK_MARK)) return 'ok';
  if (content.startsWith(TOOL_FAIL_MARK)) return 'fail';
  // Legacy format compatibility
  if (/^Error:\s/.test(content)) return 'fail';
  // Mechanism-layer rejections (plan gate / in-turn block): the call DID NOT run. For honesty
  // accounting that is a failure — a "sent / built / done" claim cannot stand on a blocked call.
  // (prod 2026-07-07: gate-rejected replyWithMedia counted as 'unknown', so "已发到微信" passed
  // the gate with 0 failCount while the send never happened.)
  if (/^\[(?:plan_protocol_gate|in-turn-tool-block)\]/.test(content)) return 'fail';
  return 'unknown';
}

// ── Tool function classification (verify-before-claim) ────────────────────────────────
//
// destructive: tools that produce new artifacts (write files / download / patch); after completion,
//              usually need an observation tool to confirm the artifact exists and has reasonable size.
// observation: read/list/search tools — these tools are verification themselves.
// neutral:     others (web queries, pure computation, shell because commands vary so much it goes to neutral)
//
// Design: explicitly classify by toolName, don't rely on vague "tool description contains write" heuristic.
// When new tools are added, register them once explicitly.
//
// Note: agent-tools uses camelCase (writeFile/readFile/glob/grep/patch),
//       agent-memory tools use snake_case (store_fact/get_fact/recall_sessions).
//       P0 fix: previously OBSERVATION_TOOLS / DESTRUCTIVE_TOOLS all used camelCase,
//       causing memory tools to always fall into neutral, making verify-before-claim ineffective for memory.
const DESTRUCTIVE_TOOLS = new Set([
  // agent-tools (camelCase)
  'writeFile',
  'downloadFile',
  'patch',
  'jsonPatch',
  // agent-memory (snake_case)
  'store_fact',
  'create_calendar_event',
  'schedule_reminder',
  'cancel_schedule',
]);
const OBSERVATION_TOOLS = new Set([
  // agent-tools (camelCase)
  'readFile',
  'glob',
  'grep',
  // agent-memory (snake_case)
  'get_fact',
  'list_facts',
  'search_notes',
  'search_skills',
  'recall_sessions',
  'list_upcoming',
  'use_skill',
]);

/** Memory-write tools (for memory_claim detection only; subset of DESTRUCTIVE_TOOLS) */
const MEMORY_WRITE_TOOLS = new Set([
  'store_fact',
  'create_calendar_event',
  'schedule_reminder',
  // 'cancel_schedule' is not a write (it essentially disables an existing entry)
]);

export function classifyToolByName(name: string): 'destructive' | 'observation' | 'neutral' {
  if (DESTRUCTIVE_TOOLS.has(name)) return 'destructive';
  if (OBSERVATION_TOOLS.has(name)) return 'observation';
  return 'neutral';
}

/** Whether this is a memory-write tool (for memory_claim detection) */
export function isMemoryWriteTool(name: string): boolean {
  return MEMORY_WRITE_TOOLS.has(name);
}

// ── Shell write operation heuristic (P0.3) ───────────────────────────────────────────
//
// Shell commands are too varied to classify by toolName like writeFile. Use a heuristic:
// if a write signal appears in shell input.command string → treat as destructive (equivalent to writeFile).
// verify-before-claim then also requires a subsequent observation fallback.
//
// Write signals (union):
//   - Shell redirection: `>` / `>>` / `tee` / `Out-File` / `Set-Content` / `Add-Content`
//   - Package manager writes: `pip install` / `npm install` / `apt install` / `apt-get install` /
//     `yum install` / `winget install` / `choco install` / `brew install` /
//     `cargo install` / `go install` / `dotnet add` / `gem install`
//   - Inline interpreter writes: `python -c` / `node -e` containing `open(.*'w')` / `.write(` /
//     `writeFileSync` / `dump(`
//   - File operations: `cp ` / `mv ` / `mkdir ` / `touch ` / `rm ` / `Remove-Item` /
//     `New-Item` / `Copy-Item` / `Move-Item`
const SHELL_WRITE_SIGNALS: ReadonlyArray<RegExp> = [
  // 重定向
  /(?:^|[\s|;])(?:>>?|tee\s)/,
  /\b(?:Out-File|Set-Content|Add-Content)\b/,
  // 包管理(写本机)
  /\b(?:pip(?:3)?|npm|pnpm|yarn|apt|apt-get|yum|dnf|winget|choco|brew|cargo|gem|go|dotnet)\s+(?:install|add|i\b)/i,
  // 解释器内联写
  /(?:python(?:3)?|node|deno)\s+-[ce]\s+["'].{0,500}?(?:open\s*\([^)]*['"]w[+b]*['"]|\.write\(|writeFileSync|dump\s*\(|\.to_csv|\.to_excel|\.to_json|Document\(\)|\.save\()/i,
  // 文件操作命令(强信号)
  /\b(?:cp|mv|mkdir|touch|rm|rmdir|ln)\s+/,
  /\b(?:Remove-Item|New-Item|Copy-Item|Move-Item|Rename-Item)\b/,
  // 编辑器写入
  /\b(?:cat|echo|printf)\s.{0,200}>\s*\S/,
];

/** Whether a shell command appears to be writing an artifact */
export function shellLooksLikeWrite(command: string): boolean {
  if (!command) return false;
  return SHELL_WRITE_SIGNALS.some((re) => re.test(command));
}

// ── Execution / computation tools (session-aware fabrication detection) ────────────────
//
// Tools whose presence in a turn means real EXECUTION / COMPUTATION actually happened. Used by the
// fabricated_execution_claim and run_promise_without_exec branches: an "I computed / I ran it" claim,
// or a "现在跑 / let me run it" promise, is only honest if one of these fired this turn.
//
// Deliberately EXCLUDES writeFile/patch/downloadFile: writing a script is NOT running it — that is the
// exact Goldbach trap (the agent wrote goldbach_quantum_3lines.py, then narrated computed eigenvalues
// the script never produced). Only running counts as running.
const EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'process',
  'pariGp',
  'z3Verify',
  'magnitude',
  'deep_explore',
]);

/** Whether a tool name denotes real execution/computation (not file-writing or reading). */
export function isExecutionTool(name: string): boolean {
  return EXECUTION_TOOLS.has(name);
}

/** Whether this turn actually executed/computed anything (success OR failure — running is running). */
export function turnDidExecute(records: ReadonlyArray<{ toolName: string }>): boolean {
  return records.some((r) => isExecutionTool(r.toolName));
}

// ── Public API ───────────────────────────────────────────────────────────

export interface ToolResultRecord {
  /** Tool name (used for destructive/observation classification) */
  toolName: string;
  /** content string of the tool_result (should already have ✓/⚠ prefix) */
  content: string;
  /**
   * P0.3: input at tool_use time (JSON string or Record), used by tools like shell
   * that classify by command. Optional — callers that don't pass it are treated as neutral
   * (shell write detection is automatically skipped).
   */
  toolInput?: string | Record<string, unknown>;
}

export interface HonestyEvaluation {
  /**
   * severity:
   *   - high   = almost certainly lying (failures ≥ successes + completion claim / memory claim without store /
   *              fabricated numeric size in text not found in tool output)
   *   - medium = completion claim but artifact not verified by observation tool / all tool_results unknown
   *   - low    = not triggered (returns null rather than 'low')
   */
  severity: 'medium' | 'high';
  /** Specific trigger reason */
  reason:
    | 'failures_with_claim'
    | 'delivery_claim_without_send'
    | 'identity_correction_without_write'
    | 'unverified_destructive'
    | 'unknown_results_with_claim'
    | 'memory_claim_without_write'
    | 'skill_forget_claim_without_call'
    | 'fabricated_size_claim'
    | 'fabricated_reasoning_state'
    | 'fabricated_round_result'
    | 'artifact_claim_without_tools'
    | 'fabricated_execution_claim'
    | 'run_promise_without_exec'
    | 'announced_action_without_doing';
  /** Matched claim phrase (used as reference in reminder message) */
  matchedClaim: string;
  /** tool_result counts for this turn */
  okCount: number;
  failCount: number;
  unknownCount: number;
  /** Explanation text for chat-handler to compose reminder message */
  evidence: string;
}

/**
 * Compact ground-truth snapshot of the owner-scoped deep_explore reasoning session, supplied by the
 * caller (chat-handler) so the gate can check a "this reasoning is concluded" claim against reality.
 * null = the current chat session has no active reasoning session.
 */
export interface ReasoningSnapshot {
  status: string;
  openFrontierCount: number;
  provedCount: number;
  deadCount: number;
}

export interface EvaluateOptions {
  /**
   * All tool_results for this turn (chronological order), including tool name + content.
   * If tool name is missing (old callers passing only content) → treated as 'neutral', verify detection auto-skipped.
   */
  toolResults?: ToolResultRecord[];
  /** @deprecated Legacy API compatibility; new code should use toolResults */
  toolResultContents?: string[];
  /**
   * Ground truth of the owner's active reasoning session (deep_explore), or null if none. Lets the gate
   * catch "I proved it / all paths closed" claims that the reasoning tree does not actually support.
   */
  reasoningState?: ReasoningSnapshot | null;
  /**
   * Per-session honesty history (supplied by chat-handler, undefined = session latch disabled). Lets the
   * say-do-gap branch escalate a REPEATED unkept run-promise from medium to high — the prod loop where the
   * agent promised "现在跑" three turns running without ever issuing a tool call.
   */
  session?: HonestySessionSnapshot;
  /**
   * Enable the announced_action_without_doing branch (verb-agnostic say-do stall: the reply ENDS announcing
   * an action in progress — "正在调研中……" / "I'm researching…" — or commits to research / starting a
   * deep_explore, yet the turn issued ZERO tool calls). Gated (chat-handler reads PHILONT_HONESTY_ANNOUNCE)
   * so it can be dogfooded before becoming default. Distinct from run_promise_without_exec, which only
   * catches compute verbs (跑/执行/run) — this catches the research/session-start stall that escaped it.
   */
  detectAnnouncementStall?: boolean;
  /**
   * The user message that opened this turn. Enables correction-aware branches (a user fixing
   * their own name/title must produce a fact write, not just an apology).
   */
  userMessage?: string;
  /**
   * TURN-DURABLE signal: did a forget_skill / uninstallSkill call succeed anywhere in THIS turn?
   * Supplied by the caller from the turn-level tool ledger (signalBus.inTurnRecords), NOT the per-iteration
   * toolResults window — which resets whenever a gate injects a string user message (plan-failure-false-claim,
   * an honesty reminder, …), dropping an earlier successful forget_skill out of view. Without this the
   * skill_forget branch false-fires when the model restates "已删除 37 个技能" in a later iteration after the
   * deletion already succeeded (observed: forget_skill deleted 37, then the branch fired anyway on regen).
   */
  skillDeleteSucceededThisTurn?: boolean;
}

/**
 * Compact per-session honesty state passed in by the caller. unkeptRunPromise = last turn announced a run
 * but issued no execution tool; priorViolations = honesty fires so far this session.
 */
export interface HonestySessionSnapshot {
  unkeptRunPromise: boolean;
  priorViolations: number;
}

/**
 * Evaluate whether the LLM text is lying or lacks evidence.
 * Returns null = not triggered. Returning high / medium means the caller must take action (inject reminder + regenerate).
 *
 * Detection order (4 levels since P0):
 *   0. Memory claim ("已记住" / "I'll remember") but no memory_write tool this turn → high (memory_claim_without_write)
 *   1. Failures ≥ successes + completion claim → high (failures_with_claim)
 *   2. Destructive tool (incl. shell-write) succeeded but no observation tool fallback + completion claim → medium (unverified_destructive)
 *   3. All tool_results unknown + completion claim → medium (unknown_results_with_claim)
 */
// ── Reasoning-state claims (deep_explore) ─────────────────────────────────────────────
//
// A different KIND of dishonesty than task-completion claims: the model asserts a deep_explore
// reasoning session reached a TERMINAL state (proved / all paths closed / final verdict / cannot
// prove), or narrates per-round progress, when the reasoning tree does not support it. The
// task-completion vocabulary above does not cover this, and a per-round `✓ deep_explore OK` satisfies
// the completion gate's "is there a success?" test no matter how big the claim — so these slip through.
// We instead compare against the tree's actual state (passed in via opts.reasoningState).

// Positive-assertion only — phrased so common negations ("还没证明", "not yet proved", "to be proved")
// do NOT match. Even so the branch only fires when an active session has an open frontier, so a stray
// match can't false-fire on its own.
const REASONING_TERMINAL_PATTERNS: ReadonlyArray<RegExp> = [
  // Tight canonical "whole tree concluded" phrases; do NOT use a bare 所有/全部 with a loose gap —
  // 所有 is a common math quantifier ("所有偶数") and previously over-matched "所有 X ≠ 所有 Y，… 闭合".
  /全部闭合|全节点闭合/,
  /(?:所有|全部|整个)(?:节点|路径|分支|子目标|开放节点|frontier)[^。！？\n]{0,6}(?:闭合|证毕|证完|已证)/,
  /(?:五条|5\s*条|整个)[^。！？\n]{0,4}(?:路径|分支|节点)[^。！？\n]{0,4}(?:闭合|证毕)/,
  /(?:会话|session|推理树?)[^。！？\n]{0,8}(?:全部闭合|已闭合|全节点闭合)/,
  /最终判决/,
  /(?:根命题|猜想|定理)[^。！？\n]{0,10}(?:已证|证毕|证明完成|已成立)/,
  // QED only as a STANDALONE proof terminator (own sentence / end of line). A bare \bQED\b
  // over-matched proper nouns: prod 2026-07-09 — a research report mentioning the "QED
  // multi-agent" project fired this branch (a dormant open-frontier session was active), the
  // forced regen ate the report. "… x holds. QED" still matches; "QED project" does not.
  /(?:^|[。！？.!?\n])\s*Q\.?\s*E\.?\s*D\.?\s*[。.!]?\s*(?:$|\n)/,
  /(?:root\s*proposition|conjecture|theorem)[^.!?\n]{0,14}(?:proved|proven|solved)\b/i,
  /(?:不能|无法|不可能)[^。！？\n]{0,14}(?:提供|给出|构成|得到)[^。！？\n]{0,8}(?:证明|证明路径)/,
];

/** Per-round progress narration — vocabulary that ONLY makes sense if a deep_explore round actually ran. */
const REASONING_ROUND_RESULT_PATTERNS: ReadonlyArray<RegExp> = [
  /第\s*\d+\s*轮/,
  /\+\s*\d+\s*证/,
  /\d+\s*开\s*(?:→|->|—>|到)\s*\d+\s*开/,
  /时间帽/,
  /\bround\s*\d+\b/i,
];

export function findReasoningTerminalClaim(text: string): string | null {
  for (const re of REASONING_TERMINAL_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}

/**
 * Asymptotic / quantitative ESTIMATE claims — the analytic-proof analogue of a completion claim.
 * An LLM doing hard analysis asserts bounds ("∫_m |S|² = o(N)", "the error terms balance", "≪ N^{3/2}")
 * that it has NOT actually verified — the same failure class the magnitude tool exists to remove.
 * Used by deep_explore to flag a node recorded "proved" on an order claim with no machine check behind it.
 * Tight enough to avoid firing on casual Landau notation: an order symbol must sit in a CLAIM context
 * (after =/≤/"bounded by", or attached to error/estimate/minor-arc), and ≪ (Vinogradov) is itself a claim.
 */
const ORDER_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /[=≤<]\s*[oO]\s*\(\s*[A-Za-z]/, //  = o(N) , ≤ O(N…
  /\b(?:is|=|≤|<=|bounded by|至多|不超过|小于等于)\s*[oO]\(/i,
  /≪|⪡|\\ll\b/, // Vinogradov "much less than" — itself an estimate assertion
  /(?:误差|余项|主项|劣弧|error|minor[\s-]?arc|major[\s-]?arc)[^。！？\n]{0,18}(?:[=≤<]\s*|小于|≪|o\(|O\()/i,
  /(?:估计|界|estimate|bound)[^。！？\n]{0,14}(?:o\(|O\(|≪|<\s*N|≤\s*N|小于)/i,
  /(?:误差项?|error\s*terms?)[^。！？\n]{0,18}(?:平衡|相消|抵消|cancel|balance)/i,
];

export function findOrderClaim(text: string): string | null {
  for (const re of ORDER_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const at = m.index;
      return text.slice(Math.max(0, at - 12), at + 40).trim().slice(0, 60);
    }
  }
  return null;
}

export function findRoundResultClaim(text: string): string | null {
  for (const re of REASONING_ROUND_RESULT_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}

// ── Execution claim (this-turn "I ran / I computed it") ───────────────────────────────────
//
// An assertion that a computation / script / command WAS executed and produced a result THIS turn.
// Distinct from a file-completion claim: it is about RESULTS of running something, not a delivered file.
// The fabricated_execution_claim branch fires this against turnDidExecute() — claiming results while no
// shell/pariGp/etc ran is the Goldbach fabrication ("三条计算均已执行（shell 输出完整返回）" + invented numbers).
//
// Assertive past/present only; future intent ("现在跑") and negation ("没跑/还没执行") are screened by
// EXEC_ANTI_PATTERNS so they fall through to findRunPromise / pass instead of false-firing here.
const EXECUTION_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:计算|脚本|命令|代码|程序|模拟|演化|对角化|本征|谱)[^。！？\n]{0,12}(?:已|都)?(?:执行完毕|执行成功|执行完成|跑完|跑通|运行完毕|运行成功|算完|计算完成|计算完毕)/,
  /(?:已|都|均)(?:执行完毕|执行成功|跑完|跑通|运行完毕|运行成功|计算完成|计算完毕|算完)/,
  /(?:三条|两条|多条|各条|每条)[^。！？\n]{0,8}(?:计算|线|脚本)[^。！？\n]{0,8}(?:执行|跑|运行|完成)/,
  /shell[^。！？\n]{0,12}(?:输出[^。！？\n]{0,6}返回|执行完毕|成功返回|跑完|返回(?:结果|完整))/i,
  /(?:命令|脚本|计算)[^。！？\n]{0,10}(?:成功)?返回(?:了)?(?:结果|完整|数据)/,
  /\b(?:executed|ran)\s+(?:the\s+)?(?:script|computation|command|code|simulation|calculation)s?\b/i,
  /\bcomputation(?:s)?\s+(?:is|are|was|were|now)?\s*(?:complete|completed|done|finished)\b/i,
  /\b(?:all\s+)?(?:three|two)\s+(?:calculations?|computations?|lines?)\s+(?:executed|ran|completed|done)\b/i,
  // Build / compile / install / test SELF-claims WITH a result — the TileRT fabrication class (the model
  // claimed "compiled in my environment, Compile Tests 53/53 pass, MSVC + CUDA 13.0"). The CJK alternatives
  // below are anchored on a self-subject (my-environment / already-succeeded / "Compile Tests X/Y pass") so
  // they do NOT fire on descriptions of OTHERS' builds. Claiming a build/test/install result with no
  // shell/process this turn is the same fabrication as the compute case.
  /(?:我(?:的)?(?:环境|机器|本地|这边)|本地(?:环境)?|in\s+my\s+(?:environment|setup|machine))[^。！？\n]{0,16}(?:成功|编译(?:通过|成功)?|跑通|测试(?:通过|全过)|验证(?:通过)?|安装(?:成功)?|\d+\s*\/\s*\d+\s*(?:pass|通过|tests?))/i,
  /(?:compile\s*tests?|测试|tests?)\s*[:：]?\s*\d+\s*\/\s*\d+\s*(?:pass|passed|ok|通过|全过)/i,
  /(?:已成功|已经成功|我(?:已)?成功)(?:编译|构建|安装|部署|复现|跑通)/,
  /(?:已|成功)(?:安装|部署|复现|配置)[^。！？\n]{0,8}(?:并|且|，|,)[^。！？\n]{0,6}(?:验证|测试|跑通|通过)/,
  /\bi\s+(?:compiled|built|installed|ran)\b[^.!?\n]{0,20}\b(?:success|pass|clean|verified|tested)/i,
  /\b(?:compiled|built)\s+(?:it\s+)?successfully\b/i,
];

// Future intent / negation / hypothetical → NOT a this-turn execution claim.
const EXEC_ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:现在|这就|马上|立刻|即将|接下来|准备|打算|将要|稍后)[^。！？\n]{0,6}(?:跑|执行|运行|算)/,
  /(?:没|未|还没|尚未|不曾|没有)[^。！？\n]{0,4}(?:跑|执行|运行|算|返回)/,
  /(?:如果|若|一旦|待)[^。！？\n]{0,10}(?:跑|执行|运行|算)/,
  /\b(?:will|going to|about to|let me|i'?ll|gonna|plan to|haven'?t|did\s*not|didn'?t|not\s+yet)\b[^.!?\n]{0,12}\b(?:run|execute|compute)\b/i,
  // Build / compile / install / test — future intent and negation (so "will compile" / "haven't built it
  // yet", in either language, fall through to a promise/pass instead of false-firing as a done-claim).
  /(?:会|将|准备|打算|可以|需要|计划|尝试|试着|想要?|打算去|去)[^。！？\n]{0,4}(?:编译|构建|安装|部署|复现|跑通)/,
  /(?:没|未|还没|尚未|无法|不能|不曾|无须|不必)[^。！？\n]{0,12}(?:编译|构建|安装|跑通|测试|验证|复现)/,
  /\b(?:will|going to|about to|let me|i'?ll|gonna|plan to|need to|can|could|would|haven'?t|did\s*not|didn'?t|not\s+yet|try(?:ing)?\s+to)\b[^.!?\n]{0,14}\b(?:compil|build|install|test|reproduc)/i,
  // Retraction / disclaimer of a PRIOR claim — the model coming clean ("我上轮承认 X 是虚构的", "earlier I
  // falsely said I compiled it") must NOT re-trip the gate. Otherwise honesty is impossible: quoting the
  // lie to retract it re-fires the gate → a forced regen → a confession loop that eats the real answer
  // (observed on a WeChat research turn that produced only meta-confession, never the requested survey).
  /(?:虚构|编造|谎称|杜撰|捏造|不实|假的|不是真的|并非真|没真|承认|纠正|更正|澄清|收回|上一?[轮条次]|之前(?:声称|说过|讲过|报告))/,
  /\b(?:fabricat|made[- ]?up|falsely|was (?:false|untrue|not true|a lie)|earlier i (?:said|claimed)|i retract|to be clear[, ]+i did not|i never (?:actually )?(?:ran|built|compiled|tested))\b/i,
];

export function findExecutionClaim(text: string): string | null {
  for (const re of EXECUTION_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const at = m.index;
    const ctx = text.slice(Math.max(0, at - 20), at + m[0].length + 10);
    if (EXEC_ANTI_PATTERNS.some((anti) => anti.test(ctx))) continue;
    return m[0].slice(0, 60);
  }
  return null;
}

// ── Run promise (future "现在跑 / let me run it" with no tool call) ─────────────────────────
//
// The say-do gap: the reply ENDS announcing it will run, but the turn issued no execution tool. On its
// own a soft miss; on repeat in the same session (prod: promised three turns running, never ran) the
// caller-supplied session state escalates it to high.
const RUN_PROMISE_PATTERNS: ReadonlyArray<RegExp> = [
  /现在(?:就|立刻|马上)?(?:真)?(?:跑|执行|运行|算)/,
  /这就(?:跑|执行|运行|开跑)/,
  /(?:我来|我现在|马上|立刻)(?:跑|执行|运行)/,
  /现在(?:立刻|马上)?(?:真)?(?:跑|执行|运行)/,
  /\b(?:let me|i'?ll|i will|gonna|going to|about to)\s+(?:now\s+)?(?:run|execute|compute)\b/i,
  /\b(?:running|executing)\s+(?:it\s+)?now\b/i,
];

export function findRunPromise(text: string): string | null {
  for (const re of RUN_PROMISE_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}

// ── Action announcement (verb-agnostic "I'm doing it now" with no tool call) ───────────────────
//
// The stall that escaped findRunPromise (whose verbs are only 跑/执行/run/execute/compute): the reply
// ENDS announcing an action in progress and then yields — "正在调研中……", "我先做现状调研，再启动
// deep_explore", "I'm researching…". In the async (WeChat) model, ending the turn = the agent waits for
// the next user message, so "正在调研中……" with zero tools this turn becomes a permanent stall.
//
// The PRIMARY signal is structural, not a verb list: a present-progressive phrase that ENDS the message
// with an ellipsis ("正在 X [中]……" / "…ing…"). Message FORM, not a specific verb — robust to rewording.
// A small secondary set catches the common forward "我先…再启动…" / "I'll first research…" commitment.
// The branch only fires when the turn issued ZERO tool calls (announced + did literally nothing).
const ACTION_ANNOUNCEMENT_PATTERNS: ReadonlyArray<RegExp> = [
  // Primary (verb-agnostic): present-progressive ending in an ellipsis — "正在……中……" / "正在搜索网络…".
  /正在[^。！？\n]{1,24}?(?:中)?\s*(?:…|\.{2,})\s*$/,
  /\b(?:i'?m\s+(?:now\s+)?|currently\s+|now\s+)?(?:search|research|investigat|look|gather|fetch|analy|work)[a-z]*\s*(?:into|on)?[^.!?\n]{0,24}(?:…|\.{2,})\s*$/i,
  // Secondary (forward research / deep_explore-start commitment — bounded stopgap; the primary is the robust one).
  /(?:我先|让我先|首先)[^。！？\n]{0,24}(?:调研|研究|搜索|检索|查阅|查证|收集|获取|了解|看看)/,
  /(?:再|然后|接下来)[^。！？\n]{0,18}(?:启动|开始|进行)[^。！？\n]{0,16}(?:deep[_\s-]?explore|系统(?:性)?(?:分解|分析)|深入(?:分析|探索))/i,
  /启动\s*deep[_\s-]?explore/i,
  /\b(?:i'?ll|let me|i will|first[, ])[^.!?\n]{0,30}\b(?:research|investigate|look into|gather|start (?:a )?deep)\b/i,
];

export function findActionAnnouncement(text: string): string | null {
  for (const re of ACTION_ANNOUNCEMENT_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].trim().slice(0, 60);
  }
  return null;
}

// ── Delivery claims ("sent to you / 已发到微信 / 请查收") ─────────────────────────────────────
// Tools whose success actually delivers an artifact to the user's channel.
const DELIVERY_TOOLS = new Set(['replyWithMedia']);

function isDeliveryTool(name: string): boolean {
  return DELIVERY_TOOLS.has(name);
}

const DELIVERY_CLAIM_PATTERNS: RegExp[] = [
  // 已(通过微信)发到/发给 你|您|微信
  /已(?:经)?(?:通过\S{0,4})?发(?:送)?(?:到|给)\s*(?:你|您|本?微信)/,
  // 文件/PPT/图片/文档/附件 …已发送/已发出
  /(?:文件|PPT|pptx|图片|文档|附件)[^。!!\n]{0,12}已(?:经)?发(?:送|出)/i,
  // BARE "已发送 / 已发出 / 已重新发送" — no recipient, no object. Every pattern above needs either an
  // explicit recipient (发给+你/您/微信) or an explicit object (文件/文档/附件…), so the most natural
  // phrasing of all slipped through: prod 2026-07-13 opened a reply with "已发送 ✅ 就是刚刚修正过的版本"
  // while the only replyWithMedia of the turn had FAILED (ENOENT — it sent a path the file was never
  // written to). Six unrelated tools succeeded, so the aggregate ok/fail counts passed it and the user
  // was told the file arrived when nothing arrived. Sentence-scoped DELIVERY_NEGATION below still
  // screens "还没发送 / 发送失败 / 修好再发".
  /已(?:经)?(?:重新)?发(?:送|出)(?:了|完毕|成功)?/,
  // 发给你了 / 发您了
  /发给\s*(?:你|您)\s*了/,
  /请查收/,
  // English: "sent (the file) to you / via wechat", "file ... sent"
  /\bsent\b[^.!?\n]{0,30}\b(?:to you|via wechat)\b/i,
  /\b(?:file|pptx?|document|attachment)\b[^.!?\n]{0,24}\b(?:has been |was )?sent\b/i,
];

const DELIVERY_NEGATION = /(?:未能?|没有?|无法|不能|失败|还没|尚未|will|准备|即将|然后再?|再)\s*[^。!!\n]{0,6}发/;

export function findDeliveryClaim(text: string): string | null {
  for (const re of DELIVERY_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // Screen negation within the same sentence ("还没发给你" / "修复后再发送")
    const start = Math.max(0, text.lastIndexOf('\n', m.index), text.lastIndexOf('。', m.index));
    const end = (() => {
      const candidates = [text.indexOf('。', m.index), text.indexOf('\n', m.index)].filter((i) => i >= 0);
      return candidates.length ? Math.min(...candidates) : text.length;
    })();
    const sentence = text.slice(start, end);
    if (DELIVERY_NEGATION.test(sentence)) continue;
    return m[0].trim().slice(0, 60);
  }
  return null;
}

// ── Identity corrections ("我姓叶,为啥叫我页老师") ─────────────────────────────────────────────
// The user fixing their own name/title/address is a correction of a stored user.* fact. An apology
// plus "以后注意" with ZERO memory writes leaves the wrong fact in place — the same mistake next
// turn (prod 2026-07-09: wrong surname, tools=0, no store_fact; the bad fact survived).
const IDENTITY_CORRECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /我(?:姓|叫)\s*[\u4e00-\u9fa5A-Za-z]{1,10}/,
  /(?:名字|姓氏|称呼)[^。？?\n]{0,6}(?:写|记|打|叫|弄)?错/,
  /(?:为啥|为什么|怎么)[^。？?\n]{0,8}叫我/,
  /别(?:再)?叫我/,
  /\bmy name is\b/i,
];

const CORRECTION_ACK_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:抱歉|对不起|不好意思)[\s\S]{0,80}?(?:改|更正|纠正|注意|记住)/,
  /以后(?:一定)?(?:会)?(?:注意|改正|改)/,
  /已(?:经)?(?:更正|改正|纠正|记住|记下)/,
  /\b(?:i(?:'ll| will) (?:remember|correct|note))\b/i,
];

export function findIdentityCorrection(userMessage: string): string | null {
  for (const re of IDENTITY_CORRECTION_PATTERNS) {
    const m = re.exec(userMessage);
    if (m) return m[0].trim().slice(0, 40);
  }
  return null;
}

function acknowledgesCorrection(text: string): boolean {
  return CORRECTION_ACK_PATTERNS.some((re) => re.test(text));
}

export function evaluateHonesty(
  assistantText: string,
  opts: EvaluateOptions,
): HonestyEvaluation | null {
  // Normalize: toolResults takes priority; fall back to toolResultContents for legacy callers.
  const records: ToolResultRecord[] = opts.toolResults
    ?? (opts.toolResultContents ?? []).map((content) => ({ toolName: '', content }));

  let ok = 0;
  let fail = 0;
  let unknown = 0;
  for (const r of records) {
    const k = classifyToolResult(r.content);
    if (k === 'ok') ok++;
    else if (k === 'fail') fail++;
    else unknown++;
  }

  // ── 0. P0: Memory claim but not actually stored → high ─────────────────────────────────────
  // This is independent of the completion claim path — "已记住" doesn't match COMPLETION_PATTERNS,
  // but it's equally a case of saying one thing and doing another. No memory_write tool succeeded this turn → almost certainly lying.
  const memClaim = findMemoryClaim(assistantText);
  if (memClaim) {
    const memWriteOk = records.some(
      (r) => isMemoryWriteTool(r.toolName) && classifyToolResult(r.content) === 'ok',
    );
    if (!memWriteOk) {
      return {
        severity: 'high',
        reason: 'memory_claim_without_write',
        matchedClaim: memClaim,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You said "${memClaim}", but this turn had **no calls** to store_fact / create_calendar_event /` +
          ` schedule_reminder or other memory-write tools. Verbal agreement ≠ persistence.`,
      };
    }
  }

  // ── Delivery claim while the send this turn did not succeed → high ─────────────────────────
  // prod 2026-07-07 09:06: plan gate rejected replyWithMedia, final text still said "已发到微信,
  // 请查收!". Trigger condition is deliberately narrow (zero false-positive by construction): a
  // delivery tool was ATTEMPTED this turn and none succeeded, yet the text claims delivery.
  // (A truthful recap of a PREVIOUS turn's send has no delivery attempt this turn → not fired.)
  const deliveryClaim = findDeliveryClaim(assistantText);
  if (deliveryClaim) {
    const attempts = records.filter((r) => isDeliveryTool(r.toolName));
    const anyDeliveryOk = attempts.some((r) => classifyToolResult(r.content) === 'ok');
    if (attempts.length > 0 && !anyDeliveryOk) {
      return {
        severity: 'high',
        reason: 'delivery_claim_without_send',
        matchedClaim: deliveryClaim,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You said "${deliveryClaim}", but this turn's delivery attempt (replyWithMedia) did NOT ` +
          `succeed (blocked or failed). The user has received nothing. Either actually send it now ` +
          `or say plainly that it has not been sent yet.`,
      };
    }
  }

  // ── Identity correction acknowledged but nothing written → high ─────────────────────────────
  const correction = opts.userMessage ? findIdentityCorrection(opts.userMessage) : null;
  if (correction && acknowledgesCorrection(assistantText)) {
    const memWriteOk = records.some(
      (r) => isMemoryWriteTool(r.toolName) && classifyToolResult(r.content) === 'ok',
    );
    if (!memWriteOk) {
      return {
        severity: 'high',
        reason: 'identity_correction_without_write',
        matchedClaim: correction,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `The user just corrected their own identity info ("${correction}") and you acknowledged it — ` +
          `but this turn wrote NOTHING to memory. The wrong fact is still stored and you WILL repeat the ` +
          `mistake. Call store_fact now to persist the corrected user information, then apologize.`,
      };
    }
  }

  // ── Skill-deletion claim but forget_skill/uninstallSkill never succeeded → high ────────────
  // Same shape as memory_claim_without_write, for self-learned skill governance. "已清除…技能" with no
  // successful forget_skill/uninstallSkill this turn = the model narrated the deletion (the prod
  // "调用 forget_skill(contains=…)" written in prose, tools=0). Force it to actually issue the call.
  const skillForgetClaim = findSkillForgetClaim(assistantText);
  if (skillForgetClaim) {
    // Pass if a skill-delete tool succeeded in THIS iteration's window OR anywhere this turn (turn-durable
    // signal from the caller). The window alone is unreliable: an injected gate reminder resets it and drops
    // an earlier successful forget_skill, causing a false fire on a restated claim.
    const deleteOk =
      opts.skillDeleteSucceededThisTurn === true ||
      records.some(
        (r) => SKILL_DELETE_TOOLS.has(r.toolName) && classifyToolResult(r.content) === 'ok',
      );
    if (!deleteOk) {
      return {
        severity: 'high',
        reason: 'skill_forget_claim_without_call',
        matchedClaim: skillForgetClaim,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You said "${skillForgetClaim}", but this turn had **no successful forget_skill / uninstallSkill** ` +
          `call. Self-learned skills are deleted by actually calling forget_skill (by name or contains=…) — ` +
          `writing the call in a Work Log is not calling it. Nothing was deleted.`,
      };
    }
  }

  // ── P0: fabricated_size_claim ────────────────────────────────────────
  // Fabricated specific byte count / KB / MB in text not found in tool output → high.
  // Independent of completion claim — claiming "577KB" without saying "success" is still fabrication.
  const fabricated = findUnsourcedSizeClaim(assistantText, records);
  if (fabricated) {
    return {
      severity: 'high',
      reason: 'fabricated_size_claim',
      matchedClaim: fabricated.raw,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence:
        `Your claimed "${fabricated.raw}" (approximately ${fabricated.bytes} bytes)` +
        ` has no corresponding number in this turn's tool outputs — may have been fabricated. Go back and check the actual numbers from the most recent stat / dir / ls.`,
    };
  }

  // ── deep_explore: terminal-state claim contradicted by the reasoning tree → high ───────────
  // "全部闭合 / session solved / 根命题已证 / 最终判决" while the tree still has OPEN frontier nodes
  // is a verifiable lie. Only fires when an active owner session exists (rs != null), so abstract
  // proof-talk with no session in play never false-fires.
  const rs = opts.reasoningState;
  const terminalClaim = findReasoningTerminalClaim(assistantText);
  if (terminalClaim && rs && rs.openFrontierCount > 0) {
    return {
      severity: 'high',
      reason: 'fabricated_reasoning_state',
      matchedClaim: terminalClaim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence:
        `You claimed the reasoning is concluded ("${terminalClaim}"), but the reasoning tree still has ` +
        `${rs.openFrontierCount} OPEN frontier node(s) (proved ${rs.provedCount}, dead ${rs.deadCount}, ` +
        `session ${rs.status}). Call deep_explore(action=status) and report the ACTUAL state — do not ` +
        `declare it closed/solved while nodes are still open.`,
    };
  }

  // ── deep_explore: round-result narration with no actual round this turn → high ─────────────
  // "第2轮 / +1证 / 7开→8开 / 时间帽" is deep_explore round jargon; if no successful deep_explore
  // call ran this turn, the model invented the progress from a stale snapshot.
  const roundClaim = findRoundResultClaim(assistantText);
  if (roundClaim) {
    const deepExploreRan = records.some(
      (r) => r.toolName === 'deep_explore' && classifyToolResult(r.content) === 'ok',
    );
    if (!deepExploreRan) {
      return {
        severity: 'high',
        reason: 'fabricated_round_result',
        matchedClaim: roundClaim,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You narrated deep_explore round progress ("${roundClaim}"), but no successful deep_explore ` +
          `call was made this turn. Round results must come from an actual deep_explore(action=continue) ` +
          `call — never invented from the in-progress snapshot in the prompt.`,
      };
    }
  }

  // ── P0: fabricated_execution_claim ───────────────────────────────────────
  // A this-turn EXECUTION/COMPUTATION claim ("已执行 / shell 输出完整返回 / ran the computation") with
  // ZERO execution tools this turn. Generalizes fabricated_size_claim (file sizes) and
  // artifact_claim_without_tools (file paths) to computed RESULTS — the form V4 Flash used on the
  // Goldbach session (invented eigenvalues + "三条计算均已执行" narrated on a turn that ran no shell/pariGp).
  const ranExecution = turnDidExecute(records);
  const execClaim = findExecutionClaim(assistantText);
  if (execClaim && !ranExecution) {
    return {
      severity: 'high',
      reason: 'fabricated_execution_claim',
      matchedClaim: execClaim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence:
        `You claimed an execution/computation result ("${execClaim}"), but this turn issued ZERO ` +
        `execution tool calls (no shell / pariGp / z3Verify / deep_explore). The computation never ran — ` +
        `those numbers were not produced this turn. Actually run it, or tell the user plainly it has not run yet.`,
    };
  }

  // ── say-do gap: run_promise_without_exec ─────────────────────────────────
  // The reply announces a run ("现在跑 / let me run it") but issued no execution tool. Soft on first
  // occurrence; escalated to high on repeat in the same session (caller supplies session state).
  const runPromise = findRunPromise(assistantText);
  if (runPromise && !ranExecution) {
    const repeat =
      !!opts.session && (opts.session.unkeptRunPromise || opts.session.priorViolations >= 1);
    return {
      severity: repeat ? 'high' : 'medium',
      reason: 'run_promise_without_exec',
      matchedClaim: runPromise,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence: repeat
        ? `You said "${runPromise}" but again issued no tool call — a repeated say-do gap this session. ` +
          `Do NOT write "I'll run it" and stop; in this same reply CALL the shell/pariGp tool now, or state ` +
          `plainly that you are not running it.`
        : `You said "${runPromise}" but this turn issued no execution tool call. Announcing a run is not ` +
          `running — call the tool in your reply instead of stating intent and ending the turn.`,
    };
  }

  // ── say-do gap: announced_action_without_doing (verb-agnostic, gated) ─────
  // The reply ENDS announcing an in-progress action ("正在调研中……") or commits to research / starting a
  // deep_explore, yet the turn issued ZERO tool calls — so it stalls forever (turn end = yield). Distinct
  // from run_promise_without_exec, whose verbs miss 调研/启动 deep_explore. "Did nothing" = no tool at all
  // this turn (a research promise is kept by webSearch/deep_explore, which is not an EXECUTION tool, so we
  // gate on records.length, not turnDidExecute). Repeat in-session escalates medium→high via the latch.
  if (opts.detectAnnouncementStall && records.length === 0) {
    const announced = findActionAnnouncement(assistantText);
    if (announced) {
      const repeat =
        !!opts.session && (opts.session.unkeptRunPromise || opts.session.priorViolations >= 1);
      return {
        severity: repeat ? 'high' : 'medium',
        reason: 'announced_action_without_doing',
        matchedClaim: announced,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence: repeat
          ? `You again announced an action ("${announced}") but issued no tool call — a repeated say-do gap ` +
            `this session. Do NOT trail off with a present-progressive "I'm researching…" / a "…" and stop: ` +
            `in THIS reply call the tool now (webSearch / start deep_explore), or tell the user plainly you ` +
            `are not doing it.`
          : `You announced an action in progress ("${announced}") but this turn issued ZERO tool calls. ` +
            `Ending the turn here yields control — the user is left on an in-progress "…" that never resolves. ` +
            `Announcing is not doing: in THIS reply actually call the tool (webSearch / start deep_explore), ` +
            `or say plainly you will not.`,
      };
    }
  }

  // 3 branches after the completion claim
  const claim = findCompletionClaim(assistantText);
  if (!claim) return null;

  // Completely no tool results → USUALLY indeterminate (a pure-conversation reply, or state inherited
  // from an earlier turn) — pass through. EXCEPTION (observed in production, V4 Flash): a completion
  // claim that names a CONCRETE FILE ARTIFACT ("更新了文档到 E:\...\方案_v3.md") with ZERO tool calls
  // this turn is almost certainly fabricated — the file write it describes never happened (the user
  // checked: exists=false). A specific artifact path is a this-turn deliverable claim, not inherited
  // chit-chat, so it must be backed by at least one tool call.
  if (ok + fail + unknown === 0) {
    const artifact = findArtifactPathClaim(assistantText);
    if (artifact) {
      return {
        severity: 'high',
        reason: 'artifact_claim_without_tools',
        matchedClaim: `${claim} → ${artifact}`,
        okCount: ok,
        failCount: fail,
        unknownCount: unknown,
        evidence:
          `You claimed a file deliverable ("${artifact}") was produced/updated, but this turn made ` +
          `ZERO tool calls — no writeFile, nothing. The file was not touched. Either actually write it ` +
          `(writeFile) or tell the user honestly that it has not been written yet.`,
      };
    }
    return null;
  }

  // 1. Failure count ≥ success count + completion claim → high (strongest signal)
  if (fail > 0 && fail >= ok) {
    return {
      severity: 'high',
      reason: 'failures_with_claim',
      matchedClaim: claim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence: `This turn had ${fail} tool failure(s) and ${ok} success(es), yet you claimed "${claim}".`,
    };
  }

  // 2. verify-before-claim: **completely stopped firing** (Phase 13.5 round 3, 2026-05-18)
  //
  //    History: this branch originally detected "destructive artifact write without following observation tool" →
  //    medium severity. Production testing (multiple rounds) proved it was unfriendly to real LLM working patterns:
  //      - Run A: failCount=1 okCount=23 → fire (false positive, escaped by threshold)
  //      - Run B: failCount=1 okCount=2  → fire (escaped by threshold)
  //      - Run C: failCount=0 okCount=1  → fire (edge case, still triggered)
  //    Every false positive triggers cap=1 regen → wastes turn + forces LLM to write "reflection" →
  //    plan-auto-close failed → reflection pipeline instability. Nuisance >> value.
  //
  //    Real lying patterns are covered by other branches:
  //      - branch 1 (failures_with_claim): failures ≥ successes + claim → high
  //      - branch 1.5 (fabricated_size_claim): fabricated file size → high
  //      - branch 3 (unknown_results_with_claim): all unknown + claim → medium
  //
  //    2026-06-02 cleanup: prior comments claimed "detectUnverifiedDestructive + shell-write heuristic
  //    retained for K7-bridge external consumption" — audit confirmed this claim was incorrect
  //    (K7-bridge only uses types, does not call these functions).
  //    detectUnverifiedDestructive / effectiveKind / extractShellCommand have no callers, deleted.
  //    classifyToolByName / shellLooksLikeWrite retained temporarily (have unit tests,
  //    are reusable pure functions), but have no production callers.

  // 3. All unknown (old format or non-tool content) + completion claim → medium
  if (fail === 0 && ok === 0 && unknown > 0) {
    return {
      severity: 'medium',
      reason: 'unknown_results_with_claim',
      matchedClaim: claim,
      okCount: ok,
      failCount: fail,
      unknownCount: unknown,
      evidence: `This turn had ${unknown} tool result(s) that are indeterminate (neither success nor failure), yet you claimed "${claim}".`,
    };
  }

  // All ok and no unverified destructive issues → trust
  return null;
}

// Note: effectiveKind / extractShellCommand / detectUnverifiedDestructive were removed
// 2026-06-02 — after branch 2 (unverified_destructive) stopped firing they had no callers,
// see the evaluateHonesty branch 2 comment above for details.

// ── Outcome verification: source verification for "specific numeric claims" like file sizes ────────
//
// Why a separate level: the existing 4 levels of HonestyGate (failures / unverified / unknown /
// memory) don't cover "claimed specific number vs actual tool output". In user conversations,
// the agent fabricated "577KB, format correct" for an 18-byte docx — all tools ✓ + full claim,
// matching no existing branch. This is the most dangerous form of unverified outcome:
// not missing data, but data being **fabricated**.
//
// MVP scope: only capture file sizes (KB/MB/GB/字节/bytes). Other quantitative claims
// (line counts / file counts / durations) are left for future extension; get the most painful
// category right first.
//
// Tolerance: allow +/- 5% (rounding errors / KB-vs-KiB etc) + absolute value < 200 bytes
// (integer rounding for small files). Against a ~30000x gap like "577KB" vs "18 bytes",
// the tolerance range has no effect.

/** A single claim: parsed byte count + original raw string */
export interface SizeClaim {
  raw: string;
  bytes: number;
}

/**
 * Normalize a size string to bytes. Matches:
 *   - "577KB" / "5.7MB" / "1.2GB"
 *   - "902,059 字节" / "18 bytes" / "1024 B"
 *   - Mixed Chinese/English / space-tolerant
 *
 * Non-matching: "577.0KB" with decimal → preserved as decimal (parseFloat handles it).
 */
function parseSizeToken(numStr: string, unit: string): number | null {
  const n = parseFloat(numStr.replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  const u = unit.toUpperCase();
  if (u === 'KB' || u === 'KIB') return n * 1024;
  if (u === 'MB' || u === 'MIB') return n * 1024 * 1024;
  if (u === 'GB' || u === 'GIB') return n * 1024 * 1024 * 1024;
  // "字节" / "bytes" / "byte" / "B" → already in bytes
  if (u === '字节' || u === 'BYTES' || u === 'BYTE' || u === 'B') return n;
  return null;
}

// Use (?![A-Za-z]) instead of \b — the latter doesn't work for Chinese "字节" (Chinese characters
// are not word characters in JS regex). Only need to ensure no ASCII letter follows the unit.
const SIZE_RE =
  /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(KB|KiB|MB|MiB|GB|GiB|字节|bytes|byte)(?![A-Za-z])/gi;
// Single letter B is prone to false positives (variable names / abbreviations); separated out
// to require a strict number+space form preceding it
const SIZE_B_RE = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s+B(?![A-Za-z\d])/g;

/** Extract all "file size" claims from text, returning byte count + raw string. */
export function extractSizeClaims(text: string): SizeClaim[] {
  const out: SizeClaim[] = [];
  for (const m of text.matchAll(SIZE_RE)) {
    const bytes = parseSizeToken(m[1], m[2]);
    if (bytes !== null) out.push({ raw: m[0], bytes });
  }
  for (const m of text.matchAll(SIZE_B_RE)) {
    const bytes = parseSizeToken(m[1], 'B');
    if (bytes !== null) out.push({ raw: m[0], bytes });
  }
  return out;
}

/**
 * Extract all numbers that "look like sizes" from tool_output text. Broader than extractSizeClaims:
 * does not require units, because tool outputs mix many forms like "902,059 bytes" / "18" / "size 18" /
 * "1 File(s) 18 bytes" — any number could be the real size.
 * We only care about "whether the claimed byte count can find an approximate match among these numbers".
 */
function extractAllNumbers(text: string): number[] {
  const out: number[] = [];
  // First extract numbers with units (prefer parsing as bytes)
  for (const m of text.matchAll(SIZE_RE)) {
    const bytes = parseSizeToken(m[1], m[2]);
    if (bytes !== null) out.push(bytes);
  }
  // Then extract raw numbers (integers without units, could be byte counts or line/item counts)
  // Since this is a fallback, treat them as bytes directly and add to candidates (if claim is 18 bytes,
  // any tool output containing "18" counts as a match — tolerance provides the false-positive floor)
  const RAW_NUM = /(\d{1,3}(?:,\d{3})+|\d{2,})/g; // ≥2 digits to avoid "0"/"1" noise matching everything
  for (const m of text.matchAll(RAW_NUM)) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Check whether each size claim can find a source in toolOutputs.
 * Returns the first claim **without a source**, or null (all have sources).
 *
 * Tolerance: max(claim × 5%, 200 bytes). Example: claiming 577KB (=590848 bytes), tolerance ±29542,
 * tool output must contain a number in [561306, 620390]. Claiming 18 bytes, tolerance ±200 →
 * any number in [0, 218] counts as a match.
 *
 * This tolerance is intentionally wide: **catching "out of thin air"** matters more than "off by a few digits".
 * Claiming 577KB against tool output (showing only 18 bytes / 902059 bytes) gives 0 matches — stable trigger;
 * conversely, claiming "18 bytes" when the tool actually has 18 bytes is a stable pass.
 */
/**
 * Tools that produce "file size" information — only these tools' output can serve as a baseline for size claims.
 */
const SIZE_PRODUCING_TOOLS: ReadonlySet<string> = new Set([
  'downloadFile', 'inspectPath', 'writeFile', 'readFile', 'glob', 'listDir',
  // shell running dir / ls -la / stat also produces file sizes — most common size source
  'shell',
]);

export function findUnsourcedSizeClaim(
  text: string,
  toolOutputs: ReadonlyArray<ToolResultRecord>,
): SizeClaim | null {
  const claims = extractSizeClaims(text);
  if (claims.length === 0) return null;

  // 2026-05-20 false-positive fix: the baseline for size claims can only come from tools that produce file sizes.
  // Production bug: LLM said PDF "3.7MB" in a replyWithMedia turn (real source was downloadFile bytes=3730357
  // from the previous turn), but the tool this turn was replyWithMedia — output had no byte count,
  // but contained a WeChat channel ID (o9cq801SI55…) that extractAllNumbers extracted as noise numbers,
  // polluting the baseline → false-positive fabrication detection.
  // Fix: only extract numbers from size-producing tool outputs; if no size tools this turn
  // → no trustworthy baseline, don't classify as fabrication (prefer false negatives over false positives).
  const hasToolNames = toolOutputs.some((r) => r.toolName);
  let outputsForNumbers: ReadonlyArray<ToolResultRecord>;
  if (hasToolNames) {
    outputsForNumbers = toolOutputs.filter((r) => SIZE_PRODUCING_TOOLS.has(r.toolName));
    if (outputsForNumbers.length === 0) return null;
  } else {
    // Legacy caller didn't pass toolName → cannot classify, fall back to original behavior (all outputs as baseline)
    outputsForNumbers = toolOutputs;
  }

  const allOutputs = outputsForNumbers.map((r) => r.content).join('\n');
  const sourceNumbers = extractAllNumbers(allOutputs);
  if (sourceNumbers.length === 0) {
    // No tool output to compare → cannot disprove. Let other branches handle (unknown / completion).
    return null;
  }
  for (const claim of claims) {
    const tolerance = Math.max(claim.bytes * 0.05, 200);
    const matched = sourceNumbers.some((n) => Math.abs(n - claim.bytes) <= tolerance);
    if (!matched) return claim;
  }
  return null;
}

/**
 * P0: Find "已记住" / "I'll remember" style memory claims in text, suppressing questions / negations.
 * Returns null if no match.
 */
export function findMemoryClaim(text: string): string | null {
  for (const re of MEMORY_CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    const ctxStart = Math.max(0, matchStart - 30);
    const ctxEnd = Math.min(text.length, matchEnd + 10);
    const localCtx = text.slice(ctxStart, ctxEnd);
    let suppressed = false;
    for (const anti of MEMORY_ANTI_PATTERNS) {
      if (anti.test(localCtx)) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    return m[0];
  }
  return null;
}

/** Suppress memory_claim false positives */
const MEMORY_ANTI_PATTERNS: ReadonlyArray<RegExp> = [
  // Negation: "没记住" / "我不记得" / "记不住" / "记不清"
  /(?:没|未|不|没有)(?:记住|记得|备忘|记下|存)/,
  /(?:记不(?:住|清|得)|忘了|忘记)/,
  // Rhetorical questions: "你说我已经记住了吗" / "我能记住吗"
  /(?:能|是否|是不是|有没有|可否|要不要)[^。！？\n]{0,15}(?:记住|记得|记下)/,
  // User quotation
  /(?:你说|您说|用户说|刚才说)[^。！？\n]{0,30}(?:记住|记得|记下)/,
  // Modal hedge
  /(?:可能|大概|应该|或许|也许|估计)[^。！？\n]{0,8}(?:记住|记得|记下)/,
];

/**
 * Find a concrete FILE-ARTIFACT path in a completion claim — a Windows or POSIX path ending in a
 * document/file extension (md/txt/doc/xls/csv/json/pdf/html/zip…). Used by the zero-tools branch:
 * "updated the document at <path>" with no tool calls is a fabricated deliverable, not chit-chat.
 * Conservative: requires an explicit extension so prose mentions of directories don't trip it.
 */
const ARTIFACT_PATH_RE =
  /(?:[A-Za-z]:\\|\.{0,2}\/)[^\s"'`,;()[\]{}]{2,200}\.(?:md|txt|docx?|xlsx?|csv|json|ya?ml|pdf|html?|pptx?|zip|tar|gz|log)\b/i;

export function findArtifactPathClaim(text: string): string | null {
  const m = ARTIFACT_PATH_RE.exec(text);
  return m ? m[0].slice(0, 160) : null;
}

/**
 * Find the first "completion claim" in text, suppress rhetorical questions / negations / quotation contexts,
 * and return the matched string. Returns null if no match.
 */
export function findCompletionClaim(text: string): string | null {
  for (const re of COMPLETION_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    // Extract ±30 chars around the match as local context, check if anti-pattern is in the same sentence
    const ctxStart = Math.max(0, matchStart - 30);
    const ctxEnd = Math.min(text.length, matchEnd + 10);
    const localCtx = text.slice(ctxStart, ctxEnd);
    let suppressed = false;
    for (const anti of ANTI_PATTERNS) {
      if (anti.test(localCtx)) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    return m[0];
  }
  return null;
}
