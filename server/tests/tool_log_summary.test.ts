import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolInputForLog, safePathForLog } from '../src/tool_log_summary.js';

test('an argument-less call is visible as such (the writeFile({}) case)', () => {
  const line = summarizeToolInputForLog({});
  assert.equal(line, 'fields=[]');
});

test('paths keep only their shape: which file, roughly where', () => {
  assert.equal(safePathForLog('C:\\Users\\ye.xiaozhou\\.philont\\workspace\\fetched\\a.lean'), 'a.lean (abs, d6)');
  assert.equal(safePathForLog('/home/ye/dev/x.ts'), 'x.ts (abs, d3)');
  assert.equal(safePathForLog('out/k13.lean'), 'k13.lean (rel, d1)');
  const line = summarizeToolInputForLog({ path: 'C:\\Users\\ye.xiaozhou\\out\\k13.lean', content: 'x'.repeat(4271) });
  assert.match(line, /fields=\[path,content\]/);
  assert.match(line, /path=k13\.lean \(abs, d4\)/);
  assert.match(line, /contentBytes=4271/);
  assert.doesNotMatch(line, /ye\.xiaozhou/);
});

test('directories nobody parameterised leak nothing either', () => {
  // The home-folding version covered exactly one shape; these are the ones it did not.
  for (const p of [
    '/root/acme-migration/customer-list.xlsx',
    '//fileserver/legal/2026-Q3/contract.docx',
    '/srv/clients/northwind/report.pdf',
  ]) {
    const out = safePathForLog(p);
    assert.doesNotMatch(out, /acme|fileserver|legal|clients|northwind|srv|root/i, p);
  }
  assert.equal(safePathForLog('/root/acme-migration/customer-list.xlsx'), 'customer-list.xlsx (abs, d2)');
});

test('identifier-shaped values are hashed, not printed — and stay correlatable', () => {
  const a = summarizeToolInputForLog({ namespace: 'project', key: 'lrc.k13.minlaw_mid_lower_lean_2026' });
  const b = summarizeToolInputForLog({ namespace: 'project', key: 'lrc.k13.minlaw_mid_lower_lean_2026' });
  assert.equal(a, b, 'the same object must produce the same line');
  assert.doesNotMatch(a, /minlaw_mid_lower/);
  assert.match(a, /key=#[0-9a-f]{8}/);
  assert.notEqual(
    summarizeToolInputForLog({ key: 'a' }),
    summarizeToolInputForLog({ key: 'b' }),
  );
});

test('bodies are reported by size, never by content', () => {
  const line = summarizeToolInputForLog({ script: 'print(2+2)', prompt: 'private research question' });
  assert.match(line, /scriptBytes=10/);
  assert.match(line, /promptBytes=25/);
  assert.doesNotMatch(line, /print|private/);
});

test('shell keeps the binary, drops the rest of the command line', () => {
  const line = summarizeToolInputForLog({
    command: 'cd /d E:\\dev && lake env lean k13.lean --token=SECRET',
    timeout: 180000,
  });
  assert.match(line, /commandBin=cd/);
  assert.match(line, /commandBytes=/);
  assert.match(line, /timeout=180000/);
  assert.doesNotMatch(line, /SECRET/);
});

test('urls keep the host, drop path and query', () => {
  const line = summarizeToolInputForLog({ url: 'https://api.example.com/v1/x?key=abcd', method: 'POST' });
  assert.match(line, /urlHost=api\.example\.com/);
  assert.match(line, /method=POST/);
  assert.doesNotMatch(line, /abcd/);
});

test('secret-shaped keys are named and nothing else', () => {
  const line = summarizeToolInputForLog({ api_key: 'sk-live-123', context_token: 'AARzJWAF' });
  assert.match(line, /api_key=\[redacted\]/);
  assert.match(line, /context_token=\[redacted\]/);
  assert.doesNotMatch(line, /sk-live|AARzJWAF/);
});

test('never throws on hostile input', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => summarizeToolInputForLog(cyclic));
  assert.equal(summarizeToolInputForLog(null), 'input=none');
  assert.equal(summarizeToolInputForLog('{"a":1}'), 'input=<string>');
});
