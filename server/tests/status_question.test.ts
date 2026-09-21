/** status_question: a bare "how is it going" runs nothing; anything with an action verb is not a status question. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userAsksProgressStatus, statusQuestionGateReason } from '../src/status_question.js';

test('status questions: short, a status cue, no action cue', () => {
  for (const m of ['进展如何？', '现在什么状态', '到哪一步了', '怎么样了？', "how's it going", 'status?', 'any update?', '完成了吗']) {
    assert.equal(userAsksProgressStatus(m), true, m);
  }
});

test('not status questions: actions, redirections, approvals, long messages', () => {
  for (const m of ['继续推进', '换角度', 'OK', 'ok', '继续lrc证明', '把进度写成报告发我', 'run the status script and fix it',
    '进展如何？如果卡住了就换个方向继续推进，先跑一遍 lean 看结果']) {
    assert.equal(userAsksProgressStatus(m), false, m);
  }
});

test('the gate reason names the tool, quotes the question, and asks for a description not an action', () => {
  const r = statusQuestionGateReason('shell', '进展如何？');
  assert.match(r, /^\[status_question_gate\]/);
  assert.match(r, /"进展如何？"/);
  assert.match(r, /`shell` is an execute\/write tool and was NOT run/);
  assert.match(r, /do not call it in this turn/);
});
