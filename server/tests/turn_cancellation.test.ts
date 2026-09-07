import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInTurnContext, setCurrentTurnSignal, currentTurnSignal, currentTurnStatus, assertTurnActive } from '../src/channels/turn_context.js';

test('late work retains its cancelled turn signal when the same session starts another turn', async () => {
  const old = new AbortController();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let effects = 0;
  const stale = runInTurnContext('same-session', async () => {
    setCurrentTurnSignal(old.signal);
    await waiting;
    assertTurnActive();
    effects++;
  });
  const deadline = new Error('turn deadline');
  old.abort(deadline);
  await runInTurnContext('same-session', async () => {
    const fresh = new AbortController();
    setCurrentTurnSignal(fresh.signal);
    assertTurnActive();
    assert.equal(currentTurnSignal(), fresh.signal);
    release();
    await assert.rejects(stale, (error) => error === deadline);
    assertTurnActive();
  });
  assert.equal(effects, 0);
  assert.equal(currentTurnSignal(), undefined);
});

test('a cached progress callback cannot send after cancellation', async () => {
  const sent: string[] = [];
  await runInTurnContext('status', async () => {
    const controller = new AbortController();
    setCurrentTurnSignal(controller.signal);
    const status = currentTurnStatus()!;
    status('working');
    controller.abort();
    status('late result');
    assert.deepEqual(sent, ['working']);
  }, (text) => { sent.push(text); });
});
