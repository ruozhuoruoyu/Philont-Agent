/** owner_verdict: whole-message acceptance by floor; rejection candidates confirmed by the aux model; never a grade. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdictPrompt, detectOwnerVerdict, parseVerdict, renderRejectionDirective, verdictFloor } from '../src/owner_verdict.js';

test('floor: whole-message acknowledgements accept; rejection cues are only candidates; long messages are nothing', () => {
  for (const m of ['好的', 'ok', 'OK!', '可以', '谢谢', 'thanks', '对']) assert.equal(verdictFloor(m), 'accept', m);
  for (const m of ['不对', '错了，不是这个文件', 'that is wrong', "it didn't work", '重来']) assert.equal(verdictFloor(m), 'reject-candidate', m);
  for (const m of ['继续', '换角度', '进展如何？', '好的，那接下来把第二章也写了并且发我邮箱，另外记得附上参考文献列表和图表，谢谢你了', '']) {
    assert.equal(verdictFloor(m), 'none', m);
  }
});

test('parseVerdict is strict about the one word', () => {
  assert.equal(parseVerdict('rejected'), 'rejected');
  assert.equal(parseVerdict('Accepted.'), 'accepted');
  assert.equal(parseVerdict('neither'), 'none');
  assert.equal(parseVerdict('The user rejected it'), 'none');
  assert.equal(parseVerdict(null), 'none');
});

test('detect: acceptance needs no model; a rejection candidate is confirmed by the model; failures are none', async () => {
  const calls: string[] = [];
  const ask = async (req: { user: string }) => { calls.push(req.user); return 'rejected'; };
  assert.deepEqual(await detectOwnerVerdict({ message: '好的', previousReply: 'x', ask }), { verdict: 'accepted', basis: 'floor' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await detectOwnerVerdict({ message: '不对，少了第三章', previousReply: '报告已生成', ask }), { verdict: 'rejected', basis: 'llm' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /报告已生成/);
  assert.deepEqual(await detectOwnerVerdict({ message: '不对，少了第三章', previousReply: 'x' }), { verdict: 'none', basis: 'none' }, 'no model → no rejection');
  const neither = await detectOwnerVerdict({ message: '不是这个，帮我查另一个', previousReply: 'x', ask: async () => 'neither' });
  assert.equal(neither.verdict, 'none');
  const broken = await detectOwnerVerdict({ message: '不对', previousReply: 'x', ask: async () => { throw new Error('aux down'); } });
  assert.equal(broken.verdict, 'none');
});

test('the prompt classifies the message and forbids grading the reply; the directive frames a repair', () => {
  const { system, user } = buildVerdictPrompt('不对', '上一条回复');
  assert.match(system, /Never judge whether the reply was good/);
  assert.match(user, /上一条回复/);
  assert.match(renderRejectionDirective('不对，少了第三章'), /REPAIR of that reply/);
});
