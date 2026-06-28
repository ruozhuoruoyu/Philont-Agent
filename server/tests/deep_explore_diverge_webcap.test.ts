/**
 * Diverge web-lookup cap — the mechanism backstop for a diverge round browsing instead of generating
 * candidates (observed: 10 web calls, 0 tree commits, round cut for no progress).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWebCallCap } from '../src/deep_explore.js';

const WEB = new Set(['webSearch', 'webFetch']);

test('withWebCallCap: allows `cap` web calls, then blocks with a decompose directive', async () => {
  const seen: string[] = [];
  const base = async (name: string) => { seen.push(name); return { ok: true, output: `ran ${name}` }; };
  const runner = withWebCallCap(base, { cap: 2, webTools: WEB });

  assert.match((await runner('webSearch', {})).output, /ran webSearch/);
  assert.match((await runner('webFetch', {})).output, /ran webFetch/);
  const blocked = await runner('webSearch', {});
  assert.match(blocked.output, /STOP searching/);
  assert.match(blocked.output, /reason_decompose/);
  // non-web tools always pass, even after the web cap is hit
  assert.match((await runner('reason_decompose', {})).output, /ran reason_decompose/);
  assert.deepEqual(seen, ['webSearch', 'webFetch', 'reason_decompose'], 'blocked web call never reached base');
});

test('withWebCallCap: cap=0 blocks web immediately; non-web unaffected', async () => {
  const runner = withWebCallCap(async (n: string) => ({ ok: true, output: `ran ${n}` }), { cap: 0, webTools: WEB });
  assert.match((await runner('webSearch', {})).output, /STOP searching/);
  assert.match((await runner('reason_record', {})).output, /ran reason_record/);
});
