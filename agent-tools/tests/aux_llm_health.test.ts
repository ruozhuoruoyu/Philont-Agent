import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeAuxLLM, auxLLMHealth, callAuxLLM } from '../src/index.js';

// These run with no AUX_LLM_* and no registered main LLM → aux is "not configured".
test('probeAuxLLM: unconfigured aux reports not-ok with a clear reason (never throws)', async () => {
  const prevBase = process.env.AUX_LLM_BASE_URL;
  delete process.env.AUX_LLM_BASE_URL;
  try {
    const r = await probeAuxLLM();
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /not configured/);
  } finally {
    if (prevBase !== undefined) process.env.AUX_LLM_BASE_URL = prevBase;
  }
});

test('auxLLMHealth: a failed call increments the error counter (surfaceable, not silent)', async () => {
  const before = auxLLMHealth();
  await assert.rejects(() => callAuxLLM({ user: 'x' }), /not configured/i);
  const after = auxLLMHealth();
  assert.equal(after.errors, before.errors + 1, 'the error is counted so it can be surfaced');
  assert.equal(after.calls, before.calls + 1);
  assert.match(after.lastError ?? '', /not configured/i);
});
