import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');

test('the versioned first-turn identity is connected to the live prompt', () => {
  assert.match(source, /DEFAULT_IDENTITY_SELF_DESCRIPTION\s*\+/,
    'a well-tested identity constant that is not concatenated into buildFreshMessages changes nothing');
  assert.doesNotMatch(source, /What sets you apart is that you learn from your own work/,
    'the old unqualified learning claim must not survive in a second hand-written prompt');
});
