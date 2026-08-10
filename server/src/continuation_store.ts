/** Durable, process-restart-safe snapshots for suspended chat continuations. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StoredContinuation {
  version: 1;
  sessionId: string;
  savedAt: number;
  auth?: unknown;
  question?: unknown;
}

function rootDir(): string {
  const root = process.env.PHILONT_ROOT?.trim() || join(homedir(), '.philont');
  return join(root, 'state', 'continuations');
}

function pathFor(sessionId: string): string {
  const id = createHash('sha256').update(sessionId).digest('hex');
  return join(rootDir(), `${id}.json`);
}

export function saveContinuation(state: StoredContinuation): void {
  const dir = rootDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = pathFor(state.sessionId);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, target);
}

export function deleteContinuation(sessionId: string): void {
  const path = pathFor(sessionId);
  if (existsSync(path)) unlinkSync(path);
}

export function loadContinuations(): StoredContinuation[] {
  const dir = rootDir();
  if (!existsSync(dir)) return [];
  const out: StoredContinuation[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as StoredContinuation;
      if (value.version === 1 && typeof value.sessionId === 'string') out.push(value);
    } catch {
      // Corrupt snapshots are ignored; never prevent server startup.
    }
  }
  return out;
}
