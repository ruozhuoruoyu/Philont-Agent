import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolInputForLog, safePathForLog } from '../src/tool_log_summary.js';

test('an argument-less call is visible as such (the writeFile({}) case)', () => {
  const line = summarizeToolInputForLog({});
  assert.equal(line, 'fields=[]');
});

test('paths keep their shape but not the account name', () => {
  assert.equal(safePathForLog('C:\\Users\\ye.xiaozhou\\.philont\\workspace\\fetched\\a.lean'), '~/.philont/workspace/fetched/a.lean');
  assert.equal(safePathForLog('/home/ye/dev/x.ts'), '~/dev/x.ts');
  const line = summarizeToolInputForLog({ path: 'C:\\Users\\ye.xiaozhou\\out\\k13.lean', content: 'x'.repeat(4271) });
  assert.match(line, /fields=\[path,content\]/);
  assert.match(line, /path=~\/out\/k13\.lean/);
  assert.match(line, /contentBytes=4271/);
  assert.doesNotMatch(line, /ye\.xiaozhou/);
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
