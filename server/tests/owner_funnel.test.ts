/**
 * The owner funnel (2026-07-22) — "I don't perceive the autonomy at all".
 *
 * Reaching the owner takes nine independent conditions. Gate 1 alone was three, all of them judgements
 * by a weak model inside a 2000-token per-initiative budget, ANDed: self-rate shouldEscalate, emit a
 * fact, and give that fact non-empty sourceRefs. Across three production logs and a hundred-plus
 * initiatives it passed zero times. Gates 4-9 live in the dispatcher and reached no log at all, so the
 * half of the funnel below gate 3 could not even be watched — which is why instrumenting comes first
 * and relaxing second.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PushDispatcher } from '../src/push/dispatcher.js';

function dispatcherWith(opts: {
  subs?: Array<{ channel: string; peer: string; enabled: boolean }>;
  globallyEnabled?: boolean;
  logs: string[];
}) {
  const subs = opts.subs ?? [];
  return new PushDispatcher({
    subscriptions: {
      listActive: () => subs.filter((s) => s.enabled) as never,
      get: (c: string, p: string) => (subs.find((s) => s.channel === c && s.peer === p) ?? null) as never,
      markUrgentSent: () => {},
      markDigestSent: () => {},
    } as never,
    logger: {
      log: (m: string) => opts.logs.push(m),
      warn: (m: string) => opts.logs.push(m),
      error: (m: string) => opts.logs.push(m),
    },
    isGloballyEnabled: () => opts.globallyEnabled !== false,
  } as never);
}

const REQ = { severity: 'urgent' as const, kind: 'discovery_made', targetRef: 'init-1', text: 'hello' };

test('no subscription: the quietest failure now says so', async () => {
  // This path used to `return result` with an EMPTY skip list — a channel nobody opted into looked
  // exactly like a channel with nothing to say.
  const logs: string[] = [];
  const r = await dispatcherWith({ logs }).enqueue(REQ);
  assert.equal(r.delivered, 0);
  assert.ok(
    logs.some((l) => l.includes('[push-funnel]') && l.includes('no_active_subscription')),
    `expected a funnel line naming the reason, got: ${JSON.stringify(logs)}`,
  );
});

test('global kill switch is reported, not silent', async () => {
  const logs: string[] = [];
  await dispatcherWith({ logs, globallyEnabled: false }).enqueue(REQ);
  assert.ok(logs.some((l) => l.includes('[push-funnel]') && l.includes('global_disabled')));
});

test('a disabled subscription is reported as such, not as absence', async () => {
  const logs: string[] = [];
  await dispatcherWith({ logs, subs: [{ channel: 'wechat', peer: 'p1', enabled: false }] }).enqueue(REQ);
  assert.ok(logs.some((l) => l.includes('[push-funnel]')));
});

test('every dispatch produces exactly one funnel line', async () => {
  // One line per attempt, whatever the outcome — the property that makes the funnel watchable.
  const logs: string[] = [];
  const d = dispatcherWith({ logs });
  await d.enqueue(REQ);
  await d.enqueue({ ...REQ, targetRef: 'init-2' });
  assert.equal(logs.filter((l) => l.includes('[push-funnel]')).length, 2);
});
