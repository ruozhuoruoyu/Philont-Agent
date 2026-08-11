/**
 * Process-wide safety boundary for tests that import the server entry graph.
 *
 * Setting PHILONT_ROOT alone was not that boundary. It is read by exactly one module
 * (continuation_store); everything else finds the operator's real state a different way —
 * PHILONT_HOME (fetched resources, plan files), PHILONT_WECHAT_ROOT (channel credentials), and a
 * spread of paths built straight from `homedir()` with no environment variable at all:
 * ~/.philont/secrets.json, ~/.philont/skills, ~/.philont/logs, ~/.philont/downloads. Running the
 * suite still opened the operator's secrets file.
 *
 * `homedir()` is the common ancestor of all of them, and on both POSIX and Windows it is defined by
 * the environment — so redirecting HOME/USERPROFILE moves every one of those paths, including the
 * ones nobody has parameterised yet and the ones added tomorrow. The named variables are set too,
 * for the modules that consult them before falling back.
 *
 * Individual tests may still override any of these; none of them may default to the real ~/.philont.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), `philont-test-${process.pid}-`));

// The root of every fallback path: os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
if (!process.env.PHILONT_TEST_KEEP_HOME) {
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
}

for (const key of ['PHILONT_ROOT', 'PHILONT_HOME', 'PHILONT_WECHAT_ROOT', 'PHILONT_DOWNLOAD_DIR', 'PHILONT_LOG_DIR']) {
  if (!process.env[key]) process.env[key] = join(sandbox, key === 'PHILONT_ROOT' ? '' : key.toLowerCase());
}
