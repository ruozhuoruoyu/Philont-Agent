/**
 * Startup log capture (2026-07-21).
 *
 * The file tee is the record that survives a paused or scrolled-away terminal — the whole reason it
 * writes the file BEFORE the console. But it used to be installed by a *statement*, and ES imports are
 * hoisted above every statement, so every module imported by the entry point had already been evaluated
 * — and had already logged — before the tee existed.
 *
 * What that cost: loading compass.md is synchronous module-level code in chat-handler and logs exactly
 * one of `[compass] loaded …` / `[compass] none at …` / `[compass] failed to load` — the only signal
 * that the owner's authored direction was picked up and parsed. A 65-minute prod log contained none of
 * the three, so there was no way to tell whether the compass was in effect, absent, or silently parsed
 * to null. `[skills] startup loaded total 62 skills` WAS present, because it comes from a `.then()`
 * callback that runs after the import phase — which is what pinned the cause to ordering.
 *
 * These are source-order assertions because that is exactly what the bug was: a correct call in the
 * wrong evaluation phase. A runtime test cannot see the phase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const entryPoints = ['../src/index.ts', '../src/headless.ts'] as const;

for (const entry of entryPoints) {
  test(`${entry}: the tee is installed by an import, before any module that logs while loading`, () => {
    const src = readFileSync(new URL(entry, import.meta.url), 'utf8');

    const bootImport = src.indexOf("import './boot_logging.js'");
    assert.ok(bootImport > 0, 'must install file logging via a side-effect import, not a statement');

    // Every OTHER import must come after it, or that module's load-time logs are lost again. load-env
    // and proxy-bootstrap are the deliberate exceptions: env and the outbound proxy have to be in place
    // before anything can read them.
    const EXEMPT = ['./load-env.js', './proxy-bootstrap.js', './boot_logging.js'];
    const importRe = /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      if (EXEMPT.includes(m[1])) continue;
      assert.ok(
        m.index > bootImport,
        `import of ${m[1]} is hoisted above the tee — anything it logs while loading is lost`,
      );
    }
  });
}

test('index.ts imports chat-handler — the module whose load-time compass log was being lost', () => {
  // If this ever stops being true the ordering guarantee above is still correct but no longer load-bearing;
  // the assertion exists so the reason for the ordering does not quietly evaporate.
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/chat-handler\.js'/);
});

test('the compass reports its state on every path — loaded, absent, or failed', () => {
  // A silent compass is indistinguishable from a working one: parseCompass returning null yields an
  // empty prompt block, so the owner's direction contributes nothing with no signal at all.
  const src = readFileSync(new URL('../src/chat-handler.ts', import.meta.url), 'utf8');
  for (const branch of [/\[compass\] loaded /, /\[compass\] none at /, /\[compass\] failed to load/]) {
    assert.match(src, branch, `missing a compass diagnostic branch: ${branch}`);
  }
});
