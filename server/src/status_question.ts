/**
 * Status-question gate (2026-09-21).
 *
 * Prod 2026-09-21 10:42: the owner asked "进展如何？" (how is it going). The router said `direct`
 * (0.95); the model listed the explore sessions, grepped, then ran a two-minute shell command — so
 * the owner's first reply was an authorization card, and the answer came 145 seconds later after
 * the command failed. A status question is answered from what is already known: the reasoning
 * tree, facts, notes, the last reports. Nothing needs to run or be written to say where things
 * stand. When the message is unmistakably a status question, execute- and write-class tools are
 * refused for the turn with a tool_result that says so; read tools stay open.
 *
 * Pure. The message shape is deliberately narrow: short, a status cue, and no action cue. "继续推进"
 * (an action) and "换角度" (a redirection) never match; "进展如何？", "现在什么状态", "how's it going"
 * do. The cost of a miss is one authorization card, the cost of a false hit is one turn in which the
 * model must describe instead of act — so the detector errs toward missing.
 */

const STATUS_CUE_RE =
  /进展|进度|状态|到哪(?:一步|了|儿)?|怎么样了|如何了|情况(?:如何|怎样|怎么样)?|结果(?:呢|如何|怎样)|完成了[吗么]|做完了[吗么]|好了[吗么]|how(?:'s| is| are| was)\s+(?:it|things|the|that|progress|this)\b|\bstatus\b|\bprogress\b|where (?:are we|is it|do we stand)|any (?:update|news|progress)|what(?:'s| is) the (?:status|state|progress)/i;

const ACTION_CUE_RE =
  /继续|推进|开始|执行|运行|跑|写|改|修|做|试|换|重来|再来|再试|部署|安装|删|加|生成|创建|发送|提交|证明|推导|计算|搜|查一下|帮我|请你|\bcontinue\b|\brun\b|\bstart\b|\bwrite\b|\bfix\b|\bmake\b|\bdo it\b|\bretry\b|\bbuild\b|\bprove\b|\bcompute\b|\bdeploy\b|\bsearch\b|\bfetch\b|\bimplement\b|\bgenerate\b/i;

const MAX_STATUS_QUESTION_CHARS = 40;

/** True when the owner's message is a short, action-free question about how things stand. */
export function userAsksProgressStatus(message: string): boolean {
  const m = (message ?? '').trim();
  if (!m || m.length > MAX_STATUS_QUESTION_CHARS) return false;
  if (!STATUS_CUE_RE.test(m)) return false;
  if (ACTION_CUE_RE.test(m)) return false;
  return true;
}

/** The tool_result handed back for an execute/write call on a status-question turn. */
export function statusQuestionGateReason(toolName: string, message: string): string {
  const q = (message ?? '').trim().slice(0, 60);
  return (
    `[status_question_gate] The owner asked a STATUS question ("${q}"). This turn answers from what is already ` +
    `known — deep_explore status/list, facts, notes, the last reports — and runs nothing: \`${toolName}\` is an ` +
    'execute/write tool and was NOT run. Report the current state plainly (what is closed, what is open, what the ' +
    'last round did, what is blocked). If something must be run to answer, say what you would run and why, and let ' +
    'the owner decide; do not call it in this turn.'
  );
}
