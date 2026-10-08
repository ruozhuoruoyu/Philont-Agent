/**
 * Artifact read-back (2026-10-08) — the acceptance loop's first layer inside the conversation.
 *
 * Measured 2026-10 (philosophers exps 111–116, docs/design/memory_interface_evidence.md): the one
 * intervention that moved a frontier-class model on long tasks was feeding a REAL acceptance signal back
 * for a bounded repair turn. Headless gets that signal from a benchmark's checker (`--acceptance-cmd`); a
 * conversation has no checker. What it does have is the world itself: after a turn that produced files,
 * the mechanism can read them back — independently of what the reply says about them.
 *
 * Three checks, all mechanical, none authored by the model (self-written verifiers did not transfer):
 *   1. Every file an effect tool wrote this turn (writeFile / patch / appendJournal / downloadFile /
 *      moveFile) still exists and is not empty.
 *   2. Every file the reply NAMES as a produced artifact exists — only when the turn ran an effect tool,
 *      and never a path the owner's own message mentioned (they may be asking about a file that is
 *      missing; the reply saying so is not a claim).
 *   3. Document formats the owner opens with another program must open: docx/xlsx/pptx are zip
 *      containers with a [Content_Types].xml entry; a PDF starts with %PDF and ends with %%EOF; JSON
 *      parses. Production's recurring "generated the report → can't open file" lands here.
 *
 * A failed check is handed back verbatim as a directive and the reply is regenerated once; the model is
 * told it may also state plainly that the file does not exist. Pure except for the filesystem reads.
 */
import { promises as fs } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type { InTurnToolRecord } from './in_turn_reflection.js';

export type ArtifactIssueKind = 'missing' | 'empty' | 'corrupt' | 'unreadable';

export interface ArtifactIssue {
  path: string;
  kind: ArtifactIssueKind;
  detail: string;
  /** Where the path came from: a tool this turn wrote it, or the reply named it. */
  source: 'tool' | 'reply';
}

export function artifactReadbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(?:0|off|false|no)$/i.test((env.PHILONT_ARTIFACT_READBACK ?? '').trim());
}

/** Tools whose successful call leaves a file at `path`/`dest` that the owner is meant to find. */
const EFFECT_TOOL_PATH_KEYS: Record<string, string[]> = {
  writeFile: ['path'],
  patch: ['path', 'file'],
  appendJournal: ['path'],
  downloadFile: ['dest', 'destination', 'path', 'output'],
  moveFile: ['to', 'dest', 'destination'],
};

/** Extensions the reply-path check cares about: things a person opens, not things the agent merely read. */
const PRODUCED_EXT_RE = /\.(?:docx|xlsx|pptx|pdf|csv|json|md|txt|html|png|jpg|jpeg|svg|zip|lean|py|ts|js|gp|tex|xml|yaml|yml)$/i;

const MAX_PATHS = 12;
const JSON_PARSE_MAX_BYTES = 5 * 1024 * 1024;

/** Paths of files this turn's effect tools wrote (successful calls only), deduplicated, in call order. */
export function effectToolTargets(records: ReadonlyArray<InTurnToolRecord>): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (!r.success) continue;
    const keys = EFFECT_TOOL_PATH_KEYS[r.toolName];
    if (!keys || !r.toolInput || typeof r.toolInput !== 'object') continue;
    for (const k of keys) {
      const v = (r.toolInput as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) {
        out.push(v.trim());
        break;
      }
    }
  }
  return out.slice(0, MAX_PATHS);
}

const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|*?`，。；：）)\]]+/g;
const POSIX_PATH_RE = /(?:^|[\s"'`(（\[])(\/[^\s"'<>|`，。；：）)\]]+)/g;
const REL_PATH_RE = /(?:^|[\s"'`(（\[])((?:\.{1,2}\/|[\w\-]+\/)[\w\-./]+)/g;

function cleanPath(p: string): string {
  return p.replace(/[.,;:!?。，；：！？）)\]】」』"'`]+$/g, '').trim();
}

/** File paths a reply names that look like produced artifacts. URLs are never paths. */
export function extractReplyPaths(text: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const p = cleanPath(raw);
    if (!p || /^https?:\/\//i.test(p) || p.includes('://')) return;
    if (!PRODUCED_EXT_RE.test(p)) return;
    if (!found.includes(p)) found.push(p);
  };
  for (const m of text.matchAll(WIN_PATH_RE)) push(m[0]);
  for (const m of text.matchAll(POSIX_PATH_RE)) push(m[1]);
  for (const m of text.matchAll(REL_PATH_RE)) push(m[1]);
  return found.slice(0, MAX_PATHS);
}

async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function readTail(path: string, size: number, n: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r');
  try {
    const start = Math.max(0, size - n);
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** The structural "does it open" check for a format, or null when the format has none. */
export async function structuralCheck(path: string, size: number): Promise<string | null> {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    const head = await readHead(path, 4);
    if (head.length < 4 || head.toString('latin1') !== 'PK\u0003\u0004') return `${ext.slice(1)} is not a zip container (bad header) — the file will not open`;
    const tail = await readTail(path, size, 256 * 1024);
    if (!tail.includes('[Content_Types].xml')) return `${ext.slice(1)} container has no [Content_Types].xml entry — Office will refuse it`;
    return null;
  }
  if (ext === '.pdf') {
    const head = await readHead(path, 5);
    if (head.toString('latin1') !== '%PDF-') return 'pdf does not start with %PDF- — not a PDF';
    const tail = await readTail(path, size, 8 * 1024);
    if (!tail.includes('%%EOF')) return 'pdf has no %%EOF trailer — truncated';
    return null;
  }
  if (ext === '.json') {
    if (size > JSON_PARSE_MAX_BYTES) return null;
    try {
      JSON.parse(await fs.readFile(path, 'utf8'));
      return null;
    } catch (e) {
      return `json does not parse: ${(e as Error).message.slice(0, 80)}`;
    }
  }
  return null;
}

export interface CheckArtifactsOptions {
  cwd?: string;
  /** Paths the turn deleted on purpose (deleteFile): a missing one of these is not an issue. */
  deleted?: ReadonlyArray<string>;
}

/** Check each path on disk. Never throws; an unreadable path is reported, not raised. */
export async function checkArtifacts(
  paths: ReadonlyArray<{ path: string; source: 'tool' | 'reply' }>,
  opts: CheckArtifactsOptions = {},
): Promise<ArtifactIssue[]> {
  const cwd = opts.cwd ?? process.cwd();
  const deleted = new Set((opts.deleted ?? []).map((p) => resolve(cwd, p)));
  const issues: ArtifactIssue[] = [];
  const seen = new Set<string>();
  for (const { path, source } of paths) {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    if (seen.has(abs) || deleted.has(abs)) continue;
    seen.add(abs);
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      issues.push({ path, source, kind: code === 'ENOENT' ? 'missing' : 'unreadable', detail: code === 'ENOENT' ? 'does not exist on disk' : `cannot stat: ${code ?? (e as Error).message}` });
      continue;
    }
    if (st.isDirectory()) continue;
    if (st.size === 0) {
      issues.push({ path, source, kind: 'empty', detail: 'exists but is 0 bytes' });
      continue;
    }
    try {
      const corrupt = await structuralCheck(abs, st.size);
      if (corrupt) issues.push({ path, source, kind: 'corrupt', detail: corrupt });
    } catch (e) {
      issues.push({ path, source, kind: 'unreadable', detail: `cannot read: ${(e as Error).message.slice(0, 80)}` });
    }
  }
  return issues;
}

export interface TurnArtifactInput {
  replyText: string;
  records: ReadonlyArray<InTurnToolRecord>;
  /** The owner's message this turn; paths it mentions are never treated as the reply's claims. */
  userMessage?: string;
  cwd?: string;
}

export interface TurnArtifactResult {
  /** Distinct paths that were read back. 0 = nothing to check this turn. */
  checked: number;
  issues: ArtifactIssue[];
}

/** The turn-level check: tool targets always; reply-named paths only when an effect tool ran. */
export async function checkTurnArtifacts(input: TurnArtifactInput): Promise<TurnArtifactResult> {
  const targets = effectToolTargets(input.records);
  const deleted = input.records
    .filter((r) => r.success && r.toolName === 'deleteFile' && r.toolInput && typeof r.toolInput === 'object')
    .map((r) => String((r.toolInput as Record<string, unknown>).path ?? ''))
    .filter(Boolean);
  const paths: Array<{ path: string; source: 'tool' | 'reply' }> = targets.map((p) => ({ path: p, source: 'tool' as const }));
  const ranEffectTool = targets.length > 0 || input.records.some((r) => r.success && r.toolName in EFFECT_TOOL_PATH_KEYS);
  if (ranEffectTool) {
    const owner = input.userMessage ?? '';
    for (const p of extractReplyPaths(input.replyText)) {
      if (owner.includes(p)) continue;
      if (!paths.some((x) => x.path === p)) paths.push({ path: p, source: 'reply' });
    }
  }
  if (paths.length === 0) return { checked: 0, issues: [] };
  return { checked: paths.length, issues: await checkArtifacts(paths, { cwd: input.cwd, deleted }) };
}

/** The regeneration directive: the differences verbatim, and the honest way out. */
export function renderReadbackDirective(issues: ReadonlyArray<ArtifactIssue>): string {
  const lines = issues.map((i) => `- ${i.path} — ${i.detail} (${i.source === 'tool' ? 'written by a tool this turn' : 'named in your reply'})`);
  return [
    `[artifact-readback] The files below were read back from disk after your turn and do NOT match what the reply implies:`,
    ...lines,
    '',
    'Rewrite the reply so it is true about these files. If a file is genuinely missing or broken, say so plainly and say what you will do about it; ' +
      'if you can fix it within this turn (re-run the write, regenerate the document), do that first and then report the verified state. ' +
      'Do not describe a file as produced, saved, or ready unless it exists and opens.',
  ].join('\n');
}
