/**
 * Is the policy layer actually on the path?
 *
 * Five separate holes were found in two days, and they were the same hole five times: a control that
 * was written, unit-tested and carefully commented, sitting next to a call site that did not go
 * through it.
 *
 *   · the command gate — filtered out of the chain it was written for
 *   · classifyTool     — handed a lambda that dropped the params the decision needs
 *   · the plan sub-loop — calling the bare registry
 *   · the autonomous loop — same, on the path that runs unattended
 *   · grant_research_tool — minting the grants that make the rest of it optional
 *
 * None of them failed a test, because each mechanism's own tests passed: the mechanisms worked. What
 * was broken was their REACHABILITY, and nothing in a codebase this size makes that visible by
 * reading. Density has passed the point where "is this control in force?" is answerable by eye.
 *
 * So it is answered here instead. These are not tests of behaviour — the behaviour has its own tests
 * — they are tests that the behaviour is connected to anything. A new bypass has to be written down
 * as a deliberate exception, which is the point: the failures above were all silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const chatHandler = readFileSync(join(SRC, 'chat-handler.ts'), 'utf8');

/**
 * Every place that reaches the bare registry, and why that is allowed. `tools.execute()` performs no
 * authorization of any kind — it looks a tool up and invokes it — so each call site is either behind
 * a checker or is a deliberate exception with a reason someone had to write.
 */
const BARE_EXECUTE_EXCEPTIONS: Array<{ contains: string; why: string }> = [
  {
    contains: 'const r = await tools.execute(name, input);',
    why: 'subTurnToolRunner — checked immediately above by getSubLoopChecker (see the runner test below)',
  },
  {
    contains: 'const result = await tools.execute(',
    why: 'autonomousToolRunner — checked immediately above by getSubLoopChecker (see the runner test below)',
  },
  {
    contains: 'const validation = await tools.execute(call.name, call.input);',
    why: 'askUserQuestion schema validation only; the call itself was already checked in the loop',
  },
  {
    contains: 'result = await tools.execute(call.name, sanitized.input);',
    why: 'main tool loop, after checker() decided this call',
  },
  {
    contains: 'result = await tools.execute(call.name, sanitized2.input);',
    why: 'main tool loop second iteration, after checker() decided this call',
  },
];

function callSites(source: string, needle: RegExp): Array<{ line: number; text: string }> {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((l) => needle.test(l.text) && !l.text.startsWith('*') && !l.text.startsWith('//'));
}

test('every path to the bare registry is either checked or a written-down exception', () => {
  const sites = callSites(chatHandler, /\btools\.execute\(/);
  assert.ok(sites.length > 0, 'the scan itself must not silently match nothing');

  const unexplained = sites.filter(
    (s) => !BARE_EXECUTE_EXCEPTIONS.some((e) => s.text.includes(e.contains.trim())),
  );
  assert.deepEqual(
    unexplained.map((s) => `chat-handler.ts:${s.line}: ${s.text}`),
    [],
    'A new call to tools.execute() reaches tools with NO authorization of any kind — no matrix, no ' +
      'grants, no validator chain, no path ACL, no command gate. Route it through a checker, or add ' +
      'it to BARE_EXECUTE_EXCEPTIONS with the reason it is safe.',
  );
});

test('the exception list stays honest: every entry still exists in the source', () => {
  for (const e of BARE_EXECUTE_EXCEPTIONS) {
    assert.ok(
      chatHandler.includes(e.contains),
      `stale exception — this call site is gone, so the entry should be too: ${e.contains}`,
    );
  }
});

/**
 * The two runners that feed a sub-agent loop. Both spent their whole life calling the bare registry;
 * a sub-model composed the arguments and nothing read them.
 */
test('sub-agent runners consult the checker before executing', () => {
  for (const runner of ['subTurnToolRunner', 'autonomousToolRunner']) {
    const start = chatHandler.indexOf(`const ${runner}`);
    assert.ok(start > 0, `${runner} not found — renamed? this test needs updating with it`);
    const body = chatHandler.slice(start, chatHandler.indexOf('tools.execute(', start));
    assert.match(
      body,
      /getSubLoopChecker\(\)/,
      `${runner} reaches tools.execute() without a policy check in between`,
    );
  }
});

/**
 * The input is part of the authorization decision — http is read × network until you look at
 * `method`, and write × network after. A lambda that drops the second argument silently reverts
 * every dynamically-classified tool to its static declaration.
 */
test('every classifyTool passes the params through', () => {
  const sites = callSites(chatHandler, /classifyTool:/);
  assert.ok(sites.length > 0, 'the scan itself must not silently match nothing');
  for (const s of sites) {
    assert.match(
      s.text,
      /classifyTool:\s*\(\s*name\s*,\s*params\s*\)\s*=>.*classify\(\s*name\s*,\s*params\s*\)/,
      `chat-handler.ts:${s.line} drops the params: ${s.text}\n` +
        'A name-only classifier judges http POST as the read its static declaration claims to be.',
    );
  }
});

/**
 * The grant-action patterns require a COMMAND-scope grant, which a tool-scope one deliberately does
 * not satisfy. They were filtered out of the production chain for two months.
 */
test('the dangerous-command chain is not filtered down to deny-only', () => {
  assert.doesNotMatch(
    chatHandler,
    /dangerousCommands:\s*createDangerousCommandValidator\(\{\s*\n?\s*patterns:\s*DEFAULT_DANGEROUS_PATTERNS\.filter\(\(p\)\s*=>\s*p\.defaultAction\s*===\s*'deny'\)/,
    'the grant-action patterns are filtered out again — git push, credential reads and curl|sh stop ' +
      'being gated, which is the state that let a plain `git push` publish 902 files',
  );
  assert.match(
    chatHandler,
    /createDangerousCommandValidator\(\{\s*patterns:\s*commandGatePatterns\(\)\s*\}\)/,
    'the chain should read its patterns from commandGatePatterns(), which honours PHILONT_COMMAND_GATE',
  );
});
