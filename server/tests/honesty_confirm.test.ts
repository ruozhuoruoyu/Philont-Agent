import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSizeConfirmPrompt, parseSizeConfirmation, confirmProvisionalHonesty } from '../src/honesty_confirm.js';
import type { HonestyEvaluation } from '@agent/memory';

const provisional: HonestyEvaluation = {
  severity: 'high',
  reason: 'fabricated_size_claim',
  matchedClaim: '84GB',
  okCount: 2,
  failCount: 0,
  unknownCount: 0,
  evidence: 'no number',
  confirm: {
    kind: 'file_size',
    figure: '84GB',
    sentence: 'V4.1 Flash 以 FP4 约 401 GB 权重放不进 8×84GB 可用显存',
    ledgerFiles: ['_calc_rtx6000d_v4.py'],
    ledgerExcerpt: 'Directory of E:\\dev\\philont\\server\\output 2026/10/09 22:28 1,224 _calc_rtx6000d_v4.py',
  },
};

test('the prompt asks what the sentence asserts and names the ledger; it never asks whether the figure is true', () => {
  const { system, user } = buildSizeConfirmPrompt(provisional.confirm!);
  assert.match(system, /Never judge whether the figure is true/);
  assert.match(system, /VRAM/);
  assert.match(user, /_calc_rtx6000d_v4\.py/);
  assert.match(user, /Figure: 84GB/);
  assert.match(user, /84GB 可用显存/);
});

test('parseSizeConfirmation: JSON first, bare yes/no second, anything else is no answer', () => {
  assert.equal(parseSizeConfirmation('{"file_size_claim": false, "file": null}'), false);
  assert.equal(parseSizeConfirmation('```json\n{"file_size_claim": true, "file": "report.docx"}\n```'), true);
  assert.equal(parseSizeConfirmation('no'), false);
  assert.equal(parseSizeConfirmation('I think so'), null);
  assert.equal(parseSizeConfirmation(''), null);
});

test('confirmProvisionalHonesty: cleared by the model drops the verdict; confirmed strips the window; no model drops it', async () => {
  const cleared = await confirmProvisionalHonesty(provisional, async () => '{"file_size_claim": false, "file": null}');
  assert.equal(cleared.verdict, 'cleared');
  assert.equal(cleared.evaluation, null);
  const confirmed = await confirmProvisionalHonesty(provisional, async () => '{"file_size_claim": true, "file": "x.docx"}');
  assert.equal(confirmed.verdict, 'confirmed');
  assert.equal(confirmed.evaluation?.reason, 'fabricated_size_claim');
  assert.equal(confirmed.evaluation?.confirm, undefined);
  const unavailable = await confirmProvisionalHonesty(provisional, undefined);
  assert.equal(unavailable.verdict, 'unavailable');
  assert.equal(unavailable.evaluation, null);
  const erroring = await confirmProvisionalHonesty(provisional, async () => { throw new Error('timeout'); });
  assert.equal(erroring.verdict, 'unavailable');
  const garbage = await confirmProvisionalHonesty(provisional, async () => 'hmm');
  assert.equal(garbage.verdict, 'unavailable', 'an unparseable answer is no answer');
});

test('a verdict the floor decided passes through without any model call', async () => {
  const { confirm: _c, ...decided } = provisional;
  let asked = 0;
  const out = await confirmProvisionalHonesty(decided as HonestyEvaluation, async () => { asked += 1; return 'true'; });
  assert.equal(out.verdict, 'confirmed');
  assert.equal(asked, 0);
  assert.equal((await confirmProvisionalHonesty(null, undefined)).evaluation, null);
});
