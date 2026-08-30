import test from 'node:test';
import assert from 'node:assert/strict';

import { authRequestCode, matchScopedAuthReply } from '../src/auth_request_id.js';

test('authorization cards have stable short addresses', () => {
  const code = authRequestCode('tool-call-123');
  assert.match(code!, /^[A-F0-9]{6}$/);
  assert.equal(authRequestCode('tool-call-123'), code);
  assert.notEqual(authRequestCode('tool-call-124'), code);
});

test('scoped authorization replies approve only the named card', () => {
  const current = 'tool-call-123';
  const code = authRequestCode(current)!;
  const other = authRequestCode('tool-call-999')!;

  assert.equal(matchScopedAuthReply(`批准 ${code}`, current), 'grant');
  assert.equal(matchScopedAuthReply(`ok #${code}`, current), 'grant');
  assert.equal(matchScopedAuthReply(`拒绝 ${code}`, current), 'deny');
  assert.equal(matchScopedAuthReply(`批准 ${other}`, current), 'mismatch');
  assert.equal(matchScopedAuthReply('ok', current), undefined);
});

