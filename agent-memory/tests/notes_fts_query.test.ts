/**
 * FTS5 query safety — ordinary search terms must never surface a raw SqliteError.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/index.js';

test('terms containing FTS5 metacharacters do not throw (prod hit this three times)', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: 'registered as agent-pea2yf on the platform' });

  // ':' is FTS5's column filter and '.' is a syntax error, so plain inputs — an agent handle, a dotted
  // fact key — came back as `no such column: pea2yf` / `fts5: syntax error near "."`.
  for (const q of ['agent-pea2yf', 'mycox.actor_id', 'handle: agent-pea2yf', 'project.mycox.guide', 'a.b:c-d']) {
    assert.doesNotThrow(() => notes.search(q), `must not throw: ${q}`);
  }
});

test('quoting keeps search WORKING, not merely non-throwing', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: 'registered as agent-pea2yf on the platform' });
  assert.ok(notes.search('agent-pea2yf').length > 0, 'a hyphenated token must still find its note');
});

test('multiple terms still AND together', () => {
  const { notes } = openMemoryDb(':memory:');
  notes.storeNote({ content: 'alpha beta gamma' });
  notes.storeNote({ content: 'delta epsilon' });
  assert.equal(notes.search('alpha beta').length, 1);
  assert.equal(notes.search('alpha delta').length, 0);
});

test('empty / punctuation-only queries return nothing rather than throwing', () => {
  const { notes } = openMemoryDb(':memory:');
  assert.deepEqual(notes.search(''), []);
  assert.doesNotThrow(() => notes.search('"()*'));
});
