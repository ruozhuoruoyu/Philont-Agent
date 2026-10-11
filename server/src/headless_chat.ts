#!/usr/bin/env node
/**
 * philont headless-chat — a multi-turn, stdin-driven variant of headless.ts for conversational benchmarks
 * (tau²-bench and similar), where an external user simulator sends one message at a time and reads one reply.
 *
 * Protocol (JSON lines):
 *   stdin   {"type":"user","text":"..."}     one user turn → philont runs its full turn (tools, plan, auth replay)
 *           {"type":"end"}                   close the session, write result.json, exit 0
 *   stdout  {"type":"ready"}                 after env + MCP servers are mounted; the driver waits for this line
 *           {"type":"assistant","text":"...","elapsedMs":n,"outcomeType":"..."}
 *           {"type":"error","text":"..."}
 * Everything philont itself prints goes to stderr (boot logs), so stdout stays a clean channel.
 *
 * Same env contract as headless.ts: PHILONT_ENV_FILE, --memory-db, --preamble (sent once, prepended to the first
 * user turn — the benchmark's policy / domain instructions), --workspace, --output, --max-auth-rounds,
 * PHILONT_MCP_CONFIG (external tools; waits for them like headless.ts).
 */

import './load-env.js';
import './boot_logging.js';
import { initFileLogging } from './file_logger.js';
initFileLogging();
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import type { AuthRequest } from './chat-handler.js';
import { auxStats } from '@agent/tools';

const parsed = parseArgs({
  options: {
    workspace: { type: 'string' },
    output: { type: 'string' },
    session: { type: 'string' },
    'memory-db': { type: 'string' },
    preamble: { type: 'string' },
    'max-auth-rounds': { type: 'string' },
    'turn-timeout': { type: 'string' },
  },
});
const opt = parsed.values;
const workspace = resolve(opt.workspace ?? process.cwd());
const outputDir = resolve(opt.output ?? join(workspace, '.philont-run'));
mkdirSync(workspace, { recursive: true });
mkdirSync(outputDir, { recursive: true });
const sessionId = opt.session ?? `headless-chat-${Date.now()}`;
const maxAuthRounds = Number(opt['max-auth-rounds'] ?? '20') || 20;
const turnTimeoutMs = (Number(opt['turn-timeout'] ?? '600') || 600) * 1000;
const preamble = opt.preamble && opt.preamble !== 'none' ? readFileSync(resolve(opt.preamble), 'utf8') : '';

if (process.env.PHILONT_AUTONOMOUS === undefined) process.env.PHILONT_AUTONOMOUS = '0';
if (process.env.PHILONT_AUTO_GRANT === undefined) process.env.PHILONT_AUTO_GRANT = '1';
process.env.MEMORY_DB_PATH = opt['memory-db'] ?? process.env.MEMORY_DB_PATH ?? join(outputDir, 'memory', 'memory.sqlite');
mkdirSync(dirname(process.env.MEMORY_DB_PATH), { recursive: true });
process.chdir(workspace);

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n');
const log: string[] = [];

async function main(): Promise<void> {
  const ch = await import('./chat-handler.js');
  if (ch.getMcpStatus().configured > 0) {
    const waitMs = Number(process.env.PHILONT_MCP_WAIT_MS ?? '15000') || 15000;
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      const st = ch.getMcpStatus();
      if (st.servers.every((s) => (s.state as string) === 'connected' || (s.state as string) === 'failed')) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    process.stderr.write(`[headless-chat] mcp wait ${Date.now() - t0}ms: ${ch.getMcpStatus().summary}\n`);
  }
  out({ type: 'ready' });

  let turns = 0;
  let first = true;
  const runTurn = async (text: string): Promise<void> => {
    const started = Date.now();
    let finalText = '';
    let authRequested = false;
    let lastOutcome: { outcomeType?: string; text?: string } = {};
    const onDelta = (t: string) => { finalText += t; };
    const onAuth = (req: AuthRequest) => { authRequested = true; log.push(`auth ${req.toolName} (${req.capability}/${req.domain}) auto-approved`); };
    const onStatus = (t: string) => log.push(`status ${t}`);
    const onTrace = (ev: unknown) => { try { log.push(`trace ${JSON.stringify(ev)}`); } catch { /* ignore */ } };
    let round = 0;
    const firstMessage = first ? preamble + text : text;
    first = false;
    const work = (async () => {
      while (round < maxAuthRounds) {
        authRequested = false;
        finalText = '';
        const message = round === 0 ? firstMessage : '允许';
        const result = await ch.handleChatSend(sessionId, message, onDelta, onAuth, onStatus, onTrace);
        lastOutcome = (result?.outcome ?? {}) as { outcomeType?: string; text?: string };
        round++;
        if (!authRequested) break;
      }
    })();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), turnTimeoutMs));
    const won = await Promise.race([work.then(() => 'done' as const), timeout]);
    turns++;
    const reply = (lastOutcome.text ?? finalText ?? '').toString();
    log.push(`turn ${turns} ${won} ${Date.now() - started}ms outcome=${lastOutcome.outcomeType ?? '-'} authRounds=${round}`);
    out({ type: 'assistant', text: won === 'timeout' && !reply ? '' : reply, elapsedMs: Date.now() - started, outcomeType: won === 'timeout' ? 'timeout' : lastOutcome.outcomeType ?? 'response', authRounds: round });
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queue: string[] = [];
  let busy = false;
  let ended = false;
  const finish = async () => {
    const { adapterStats } = await import('./llm-adapter.js');
    writeFileSync(join(outputDir, 'agent.log'), log.join('\n') + '\n', 'utf8');
    writeFileSync(
      join(outputDir, 'result.json'),
      JSON.stringify({ sessionId, workspace, turns, model: process.env[`${(process.env.LLM_PROVIDER ?? '').toUpperCase()}_MODEL`] ?? null, provider: process.env.LLM_PROVIDER ?? null,
        usage: { main: { calls: adapterStats.calls, inputTokens: adapterStats.inputTokens, outputTokens: adapterStats.outputTokens, cacheReadTokens: adapterStats.cacheReadTokens },
                 aux: { calls: auxStats.calls, inputTokens: auxStats.inputTokens, outputTokens: auxStats.outputTokens } }, finishedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
    process.exit(0);
  };
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const line = queue.shift()!;
      let msg: { type?: string; text?: string };
      try { msg = JSON.parse(line); } catch { out({ type: 'error', text: `bad json: ${line.slice(0, 200)}` }); continue; }
      if (msg.type === 'end') { ended = true; break; }
      if (msg.type === 'user' && typeof msg.text === 'string') {
        try { await runTurn(msg.text); } catch (e) { out({ type: 'error', text: String((e as Error)?.stack ?? e) }); }
      } else out({ type: 'error', text: `unknown message type ${msg.type}` });
    }
    busy = false;
    if (ended) await finish();
  };
  rl.on('line', (line) => { if (line.trim()) { queue.push(line); void pump(); } });
  rl.on('close', () => { ended = true; void pump(); });
}

void main();
