/** owner_recent: a curiosity token the owner literally saw recently makes its finding owner-visible. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenOfTargetRef, ownerMentionedToken } from '../src/owner_recent.js';

test('tokenOfTargetRef: only token refs, and only substantial ones', () => {
  assert.equal(tokenOfTargetRef('curiosity token:https://github.com/openai/ten-proofs'), 'https://github.com/openai/ten-proofs');
  assert.equal(tokenOfTargetRef('token:arXiv:2404.12117'), 'arXiv:2404.12117');
  assert.equal(tokenOfTargetRef('pursuit:compass-philont-itself-46e1027b'), null);
  assert.equal(tokenOfTargetRef('gap fact:3117b3b7-0cdb'), null);
  assert.equal(tokenOfTargetRef('token:abc'), null, 'too short to be a real mention');
});

test('ownerMentionedToken: literal, case- and scheme-insensitive, never fuzzy', () => {
  const texts = ['这条推文说的"GPT-6 Astra 证了哥德巴赫类猜想"，来源是 github.com/openai/ten-proofs 和 arXiv 2404.12117', '继续推进'];
  assert.equal(ownerMentionedToken('https://github.com/openai/ten-proofs', texts), true);
  assert.equal(ownerMentionedToken('HTTPS://GITHUB.COM/openai/ten-proofs/', texts), true);
  assert.equal(ownerMentionedToken('arXiv:2404.12117', texts), false, 'the colon form was not what the owner saw');
  assert.equal(ownerMentionedToken('openai/ten-proofs-v2', texts), false);
  assert.equal(ownerMentionedToken('short', texts), false);
  assert.equal(ownerMentionedToken('ten-proofs', []), false);
});
