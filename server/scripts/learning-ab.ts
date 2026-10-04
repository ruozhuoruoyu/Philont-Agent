#!/usr/bin/env tsx
/**
 * learning-ab — run the headless agent over a fixed task bank under two configurations and report the
 * difference, with the discipline the philosophers noise study forces: at least two runs per configuration.
 *
 * Why this exists: philont's self-learning layer has never had a before/after measurement. Every signal so
 * far is a production counter (rules stored, reflections fired, use_skill calls) — activity, not effect. The
 * replay bench measures repair lines against tool oracles; nothing measures the learning layer as a whole.
 * And a single run is not a result: on ScienceWorld the same 27B configuration run twice differed by 18
 * points (philosophers exp 105), because one divergent greedy step changes the memory and everything after
 * it. So this harness runs each configuration `--runs` times (default 2) in its own fresh sandbox HOME, with
 * memory accumulating across the bank's tasks within a run (that is what the learning layer is for), and
 * reports per-task outcome agreement across runs next to the configuration difference.
 *
 * What a configuration is: a set of env overrides, e.g. `PHILONT_SKILL_RECALL_NO_FILL=1` vs `=0`, or
 * `PHILONT_FAILURE_PREDICTOR=shadow` vs `off`. The baseline is the empty override set.
 *
 * Usage:
 *   tsx scripts/learning-ab.ts --bank scripts/learning-ab.tasks.json --runs 2 \
 *       --env-file /path/to/.env --config "PHILONT_SKILL_RECALL_NO_FILL=1" --timeout 600
 *
 * Outputs (under --out, default ./learning-ab-<ts>/): per run/task result.json + agent.log copies,
 * a `metrics.json` dump of learning_metrics from each sandbox DB, and `report.md`.
 *
 * It never touches ~/.philont: every run gets HOME/PHILONT_HOME/PHILONT_ROOT set to a temp sandbox.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '@agent/memory';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const { values: opt } = parseArgs({
  options: {
    bank: { type: 'string' },
    runs: { type: 'string', default: '2' },
    'env-file': { type: 'string' },
    config: { type: 'string', default: '' },
    baseline: { type: 'string', default: '' },
    timeout: { type: 'string', default: '600' },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (opt.help || !opt.bank) {
  console.log(`learning-ab --bank tasks.json [--runs 2] [--env-file .env] [--config "K=V,K=V"] [--baseline "K=V"] [--timeout 600] [--out dir]`);
  process.exit(opt.help ? 0 : 3);
}

interface Task { id: string; task: string; family?: string }
const bank: Task[] = JSON.parse(readFileSync(resolve(opt.bank!), 'utf8'));
const runs = Math.max(1, Number(opt.runs));
const timeoutSec = Math.max(30, Number(opt.timeout));
const outDir = resolve(opt.out ?? `learning-ab-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

function parseKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
const configs: { name: string; env: Record<string, string> }[] = [
  { name: 'baseline', env: parseKv(opt.baseline ?? '') },
  { name: 'treatment', env: parseKv(opt.config ?? '') },
];

interface RunResult { outcomeType: string; elapsedMs: number; error: string | null }

function runTask(sandbox: string, env: Record<string, string>, t: Task, runOut: string): RunResult {
  const ws = join(sandbox, 'ws', t.id);
  mkdirSync(ws, { recursive: true });
  const taskOut = join(runOut, t.id);
  mkdirSync(taskOut, { recursive: true });
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: sandbox,
    USERPROFILE: sandbox,
    PHILONT_HOME: sandbox,
    PHILONT_ROOT: sandbox,
    PHILONT_AUTONOMOUS: '0',
    TELEGRAM_ENABLED: '0',
    WECHAT_ENABLED: '0',
    ...(opt['env-file'] ? { PHILONT_ENV_FILE: resolve(opt['env-file']) } : {}),
    ...env,
  };
  const r = spawnSync(
    process.execPath,
    [join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(__dirname, '..', 'src', 'headless.ts'), '--task', t.task, '--workspace', ws, '--output', taskOut, '--timeout', String(timeoutSec)],
    { env: childEnv, encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(join(taskOut, 'stdout.log'), (r.stdout ?? '') + '\n' + (r.stderr ?? ''), 'utf8');
  const resPath = join(taskOut, 'result.json');
  if (existsSync(resPath)) {
    const j = JSON.parse(readFileSync(resPath, 'utf8'));
    return { outcomeType: j.outcomeType ?? 'unknown', elapsedMs: j.elapsedMs ?? 0, error: j.error ?? null };
  }
  return { outcomeType: r.status === 0 ? 'unknown' : 'error', elapsedMs: 0, error: `headless exited ${r.status}` };
}

function dumpMetrics(sandbox: string): Record<string, number> {
  const dbPath = join(sandbox, '.philont', 'memory', 'memory.sqlite');
  if (!existsSync(dbPath)) return {};
  const h = openMemoryDb(dbPath);
  try {
    return Object.fromEntries(h.metrics.snapshot().map((r) => [r.key, r.count]));
  } finally {
    h.close();
  }
}

const results: Record<string, Record<number, Record<string, RunResult>>> = {};
const metrics: Record<string, Record<number, Record<string, number>>> = {};
for (const cfg of configs) {
  results[cfg.name] = {};
  metrics[cfg.name] = {};
  for (let run = 1; run <= runs; run++) {
    const sandbox = mkdtempSync(join(tmpdir(), `philont-ab-${cfg.name}-${run}-`));
    const runOut = join(outDir, cfg.name, `run${run}`);
    mkdirSync(runOut, { recursive: true });
    results[cfg.name][run] = {};
    for (const t of bank) {
      const started = Date.now();
      const r = runTask(sandbox, cfg.env, t, runOut);
      results[cfg.name][run][t.id] = r;
      console.log(`[${cfg.name} run${run}] ${t.id}: ${r.outcomeType} (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    metrics[cfg.name][run] = dumpMetrics(sandbox);
    writeFileSync(join(runOut, 'metrics.json'), JSON.stringify(metrics[cfg.name][run], null, 2), 'utf8');
    const memDir = join(sandbox, '.philont', 'memory');
    if (existsSync(memDir)) cpSync(memDir, join(runOut, 'memory'), { recursive: true });
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
// headless reports the chat handler's outcomeType: 'response' is a completed turn; 'auth_pending', 'timeout',
// 'error' and 'unknown' are not. (Whether the response was CORRECT is the judge's job, not this harness's.)
const ok = (r: RunResult) => r.outcomeType === 'response';
const lines: string[] = [];
lines.push(`# learning-ab report (${new Date().toISOString()})`);
lines.push('');
lines.push(`bank: ${bank.length} tasks · runs per config: ${runs} · treatment env: ${JSON.stringify(configs[1].env)} · baseline env: ${JSON.stringify(configs[0].env)}`);
lines.push('');
lines.push('| config | run | outcomes (completed / total) | mean s/task | timeouts | errors |');
lines.push('|---|---|---|---|---|---|');
for (const cfg of configs) {
  for (let run = 1; run <= runs; run++) {
    const rs = Object.values(results[cfg.name][run]);
    lines.push(`| ${cfg.name} | ${run} | ${rs.filter(ok).length} / ${rs.length} | ${(rs.reduce((s, r) => s + r.elapsedMs, 0) / Math.max(1, rs.length) / 1000).toFixed(0)} | ${rs.filter((r) => r.outcomeType === 'timeout').length} | ${rs.filter((r) => r.outcomeType === 'error').length} |`);
  }
}
lines.push('');
lines.push('## per-task outcome by run (agreement across runs is the noise floor; read the config difference against it)');
lines.push('');
lines.push(`| task | ${configs.map((c) => Array.from({ length: runs }, (_, i) => `${c.name} r${i + 1}`).join(' | ')).join(' | ')} |`);
lines.push(`|---|${configs.map(() => Array.from({ length: runs }, () => '---').join('|')).join('|')}|`);
for (const t of bank) {
  const cells = configs.flatMap((c) => Array.from({ length: runs }, (_, i) => results[c.name][i + 1][t.id]?.outcomeType ?? '-'));
  lines.push(`| ${t.id} | ${cells.join(' | ')} |`);
}
lines.push('');
lines.push('## learning metrics per sandbox (selected keys)');
lines.push('');
const keys = ['turn.total', 'reflect.fire', 'reflect.routing_rule', 'routing.inject.turns', 'inturn.fire', 'predictor.shadow.hi.fail', 'predictor.shadow.hi.ok', 'predictor.shadow.lo.fail', 'predictor.shadow.lo.ok', 'antipattern.inject.turns', 'playbook.inject.turns'];
lines.push(`| config | run | ${keys.join(' | ')} |`);
lines.push(`|---|---|${keys.map(() => '---').join('|')}|`);
for (const cfg of configs) {
  for (let run = 1; run <= runs; run++) {
    const m = metrics[cfg.name][run] ?? {};
    lines.push(`| ${cfg.name} | ${run} | ${keys.map((k) => m[k] ?? 0).join(' | ')} |`);
  }
}
lines.push('');
lines.push('Reading rule: a configuration effect smaller than the run-to-run disagreement within one configuration is not a result.');
writeFileSync(join(outDir, 'report.md'), lines.join('\n') + '\n', 'utf8');
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, metrics, bank, configs, runs }, null, 2), 'utf8');
console.log(`\nreport: ${join(outDir, 'report.md')}`);
