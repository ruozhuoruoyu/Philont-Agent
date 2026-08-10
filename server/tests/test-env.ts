/**
 * Process-wide safety boundary for tests that import the server entry graph.
 * Individual tests may replace this path, but no test may default to the operator's ~/.philont.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.PHILONT_ROOT) {
  process.env.PHILONT_ROOT = mkdtempSync(join(tmpdir(), `philont-test-${process.pid}-`));
}
