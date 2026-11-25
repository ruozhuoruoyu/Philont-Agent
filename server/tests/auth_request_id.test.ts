import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authRequestCode,
  isBarePredeliveryAuthReply,
  matchScopedAuthReply,
} from '../src/auth_request_id.js';

test('authorization cards have stable one-character addresses without look-alikes', () => {
  const code = authRequestCode('tool-call-123');
  assert.match(code!, /^[A-HJKMNP-Z2-9]$/);
  assert.equal(authRequestCode('tool-call-123'), code);
  // Spread across the alphabet, not stuck on a few symbols.
  const seen = new Set(Array.from({ length: 400 }, (_, i) => authRequestCode(`tool-call-${i}`)));
  assert.ok(seen.size >= 28, `only ${seen.size} distinct codes`);
});

test('scoped authorization replies approve only the named card', () => {
  const current = 'tool-call-123';
  const code = authRequestCode(current)!;
  let otherId = 'tool-call-999';
  for (let i = 0; authRequestCode(otherId) === code; i++) otherId = `tool-call-other-${i}`;
  const other = authRequestCode(otherId)!;

  assert.equal(matchScopedAuthReply(`批准 ${code}`, current), 'grant');
  assert.equal(matchScopedAuthReply(`批准${code.toLowerCase()}`, current), 'grant', 'case-insensitive, space optional');
  assert.equal(matchScopedAuthReply(`ok #${code}`, current), 'grant');
  assert.equal(matchScopedAuthReply(`拒绝 ${code}`, current), 'deny');
  assert.equal(matchScopedAuthReply(`批准 ${other}`, current), 'mismatch');
  assert.equal(matchScopedAuthReply('批准 0', current), 'mismatch', 'a symbol outside the alphabet fails closed');
  assert.equal(matchScopedAuthReply('ok', current), undefined);
});

test('a six-hex code from a card delivered before the upgrade still matches exactly', async () => {
  const { createHash } = await import('node:crypto');
  const current = 'tool-call-123';
  const legacy = createHash('sha256').update(current).digest('hex').slice(0, 6).toUpperCase();
  assert.equal(matchScopedAuthReply(`批准 ${legacy}`, current), 'grant');
  assert.equal(matchScopedAuthReply(`拒绝 ${legacy}`, current), 'deny');
  assert.equal(matchScopedAuthReply('批准 AFED9E', current), 'mismatch', 'a stale legacy code never falls through to the classifier');
});

test('only bare ok/okay get the non-authorizing pre-delivery compatibility treatment', () => {
  assert.equal(isBarePredeliveryAuthReply('ok'), true);
  assert.equal(isBarePredeliveryAuthReply('OK!'), true);
  assert.equal(isBarePredeliveryAuthReply('okay'), true);
  assert.equal(isBarePredeliveryAuthReply('不要拉取缓存，本地有版本'), false);
  assert.equal(isBarePredeliveryAuthReply('继续LRC任务'), false);
  assert.equal(isBarePredeliveryAuthReply('可以'), false);
});
