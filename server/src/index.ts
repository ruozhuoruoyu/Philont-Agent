/**
 * HTTP + WebSocket server
 *
 * HTTP API:
 *   GET    /api/memory/facts                 List all active facts (grouped by namespace)
 *   GET    /api/memory/facts?namespace=user  List facts in a specific namespace
 *   POST   /api/memory/facts/:id/pin         Pin (never decays)
 *   POST   /api/memory/facts/:id/unpin       Unpin
 *   POST   /api/memory/facts/:id/forget      Soft-delete (recoverable)
 *   POST   /api/memory/facts/:id/unforget    Undo soft-delete
 *   GET    /api/memory/skills                List all skills (by composite score descending)
 *   GET    /api/memory/notes                 List recent notes
 *   GET    /api/memory/notes/search?q=...    Full-text search notes
 *   GET    /api/memory/sessions              List recent sessions
 *   GET    /api/memory/sessions/:id          Session details + messages
 *   GET    /api/memory/stats                 Count statistics (includes calendar/schedules)
 *   GET    /api/memory/calendar?days=7       Events in the next N days (with RRULE expansion)
 *   GET    /api/memory/schedules             List scheduled tasks
 *   DELETE /api/memory/schedules/:id         Delete a scheduled task
 *   POST   /api/memory/schedules/:id/toggle  Enable/disable (body: {enabled: bool})
 *   GET    /api/memory/forget-candidates     Low-score candidates (default threshold=0.05)
 *   DELETE /api/memory/skills/:name          Delete a skill (user revocation)
 *
 * WebSocket: used for chat
 */

import './load-env.js'; // must be first: loads dotenv override, overriding any shell/system residual env
import './proxy-bootstrap.js'; // second: install global outbound proxy before any HTTP client is constructed (contains top-level await)
// Third, and it MUST stay an import rather than a call: imports are hoisted above every statement, so a
// `initFileLogging()` statement lower down runs only after every other module below has already been
// evaluated — and anything they logged while loading (the compass diagnostics among them) never reached
// the file. See boot_logging.ts.
import './boot_logging.js';
// Local-API boundary: per-request CORS + a cross-site guard for state-changing calls.
import { corsHeaders, rejectCrossSite, describeCaller } from './http_origin.js';
import { rejectUnauthenticatedSkillOverride } from './skill_install_boundary.js';
import { offeredAuthWords } from './auth_intent.js';

// Wall-clock watchdog — must load after the tee like everything else. See suspend_detector.
import { startSuspendDetector } from './suspend_detector.js';

// Force stdout/stderr into blocking mode — on Windows + PowerShell, Node defaults to
// non-blocking writes for piped/pty stdout; in some cases log output is OS-level buffered
// until process exit before flushing, making the server look hung (the server is actually
// running — the logs are just invisible). _handle.setBlocking(true) makes console.log
// immediately visible. This is a Node internal API that may not exist in all versions
// → wrapped in try/catch; failure does not affect startup.
{
  const stdoutHandle = (process.stdout as any)._handle;
  const stderrHandle = (process.stderr as any)._handle;
  if (stdoutHandle && typeof stdoutHandle.setBlocking === 'function') {
    try { stdoutHandle.setBlocking(true); } catch { /* old Node / non-TTY: ignore */ }
  }
  if (stderrHandle && typeof stderrHandle.setBlocking === 'function') {
    try { stderrHandle.setBlocking(true); } catch { /* same */ }
  }
}

// Tee console output to a daily-rotating file so tool-call evidence (web/compute success+failure,
// deep_explore rounds, gate decisions) survives terminal scrollback — and gives honesty checks a
// durable after-the-fact source. Best-effort, default ON (PHILONT_FILE_LOG=0 to disable).
// (installed above via `import './boot_logging.js'` — kept idempotent so a re-entry is harmless)
import { initFileLogging } from './file_logger.js';
initFileLogging();

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { WebSocketServer } from 'ws';
import {
  handleChatSend,
  abortActiveTurn,
  abortAllTurns,
  finalizeSession,
  registerWebuiClient,
  memory,
  reloadSkillsFromDisk,
  bundledSkillsDir,
  reminderEmitter,
  closeSkillWatchers,
  closeScheduler,
  closeIdleConsolidator,
  closeAutonomousLoop,
  closeMcpBridgesOnShutdown,
  getMcpStatus,
  closeFetchedStore,
  autonomousLoop,
  autonomousDriverNames,
  autonomySelfhoodStatus,
  internalAudit,
  type ReminderPayload,
  markWebuiUserActivity,
  runStartupIntegrityCheck,
  runDailyHealthCheck,
  markPendingAuthDelivered,
  markPendingAuthDeliveryFailed,
} from './chat-handler.js';
import { currentPhraseLang } from './response_language.js';
import { maintainDeferredPushes } from './deferred_push_maintenance.js';
import { readdirSync } from 'node:fs';
import { utcDateString, groupFailures } from '@agent/memory';
import {
  searchAll,
  inspectBundle,
  installFromSource,
  checkForUpdates,
  updateSkill,
  readLock,
  removeLock,
  uninstallSkillTool,
  probeAuxLLM,
  isAuxLLMConfigured,
} from '@agent/tools';
import { listRegisteredPushChannels, findPushChannel, describePushChannelMiss } from './push/channel.js';
import { safeSessionId } from './safe_session_id.js';

// Port: default 20266 (large enough to avoid common dev server ports 3000/8080; below the
// Linux ephemeral range 32768+, so it won't be stolen by ephemeral client ports).
// The launcher can override via PHILONT_PORT. Validation must be consistent with the
// launcher's resolvePort(): invalid / out-of-range values fall back to the default rather
// than crashing at server.listen (Number('70000')||20266 = 70000 would cause listen to
// throw RangeError, and then the launcher would still report 20266 not found — very hard
// to debug).
function resolvePort(): number {
  const p = Number(process.env.PHILONT_PORT);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : 20266;
}
const PORT = resolvePort();

// ── HTTP route handler ──────────────────────────────────────────────────────

/**
 * JSON response.
 *
 * CORS headers are NOT set here: they are per-request (only trusted origins are echoed) and are
 * applied once at the top of the request handler with res.setHeader, which writeHead preserves. The
 * previous blanket `Access-Control-Allow-Origin: *` let any page on the internet talk to this port —
 * see http_origin.ts for why that became untenable.
 */
function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

/** Read request body as JSON (small bodies only; hard limit 64KB); returns {} on parse failure */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = '';
    const MAX = 64 * 1024;
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX) {
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        const parsed = JSON.parse(buf);
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Extract id and action from /api/memory/facts/<id>/<action> */
function matchFactAction(
  method: string | undefined,
  path: string
): { id: string; action: 'pin' | 'unpin' | 'forget' | 'unforget' } | null {
  if (method !== 'POST') return null;
  const m = path.match(/^\/api\/memory\/facts\/([^/]+)\/(pin|unpin|forget|unforget)$/);
  if (!m) return null;
  return { id: decodeURIComponent(m[1]), action: m[2] as 'pin' | 'unpin' | 'forget' | 'unforget' };
}

/** Simple path match: method + path prefix → returns the remainder after the prefix (usually an id) */
function matchPath(
  method: string | undefined,
  path: string,
  expectedMethod: string,
  prefix: string
): string | null {
  if (method !== expectedMethod) return null;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  // Must have content and must not contain a sub-path (avoids false matching /pin etc.)
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;

  // Per-request CORS: echo only trusted origins (loopback / PHILONT_ALLOWED_ORIGINS), never '*'.
  // Set here rather than in sendJson so every response on this path carries it; writeHead keeps
  // headers set this way.
  for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, {});
    return true;
  }

  // Cross-site guard for state-changing requests. A browser cannot forge Origin or Sec-Fetch-Site, so
  // this is what stops a random page the owner has open from driving this API. Requests with no Origin
  // (curl, a local script) pass — they are a legitimate way to use it and cannot be produced by a page.
  const crossSite = rejectCrossSite(req);
  if (crossSite) {
    console.warn(`[api] refused ${req.method} ${path}: ${crossSite}`);
    sendJson(res, 403, { error: crossSite });
    return true;
  }

  // ── Global emergency stop (e-stop) ────────────────────────────────────────
  // One-shot: abort all in-progress turns + pause the autonomous loop. Toggleable.
  // Note 1: in-memory; resets on agent restart (autonomous resumes).
  // Note 2 (known limitation): pause() only blocks the **next** tick; if an autonomous tick
  //   is already in-flight (executor.run running LLM/tools) when estop fires, it has no
  //   abort signal and will finish the current round before stopping. Chat turns are aborted
  //   immediately. Making in-flight ticks also abort immediately requires threading an
  //   AbortSignal through executor (a larger agent-memory change) — left for later.
  if (req.method === 'POST' && path === '/api/control/estop') {
    const aborted = abortAllTurns();
    autonomousLoop.pause();
    console.log(`[estop] emergency stop engaged: aborted ${aborted} turn(s) + paused autonomous`);
    sendJson(res, 200, { engaged: true, abortedTurns: aborted });
    return true;
  }
  if (req.method === 'POST' && path === '/api/control/resume') {
    autonomousLoop.resume();
    console.log('[estop] resumed: autonomous running again');
    sendJson(res, 200, { engaged: false });
    return true;
  }
  if (req.method === 'GET' && path === '/api/control/estop') {
    sendJson(res, 200, { engaged: autonomousLoop.isPaused() });
    return true;
  }

  // ── GET /api/memory/stats ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/stats') {
    sendJson(res, 200, {
      facts: memory.facts.count(),
      skills: memory.skills.count(),
      notes: memory.notes.count(),
      actions: memory.actions.count(),
      calendar: memory.calendar.count(),
      schedules: memory.schedules.count(),
      namespaces: memory.facts.listNamespaces(),
    });
    return true;
  }

  // ── GET /api/memory/calendar?days=7 ──────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/calendar') {
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
    const now = Date.now();
    const events = memory.calendar.upcoming(days * 86_400_000, now);
    sendJson(res, 200, { windowDays: days, events });
    return true;
  }

  // ── GET /api/memory/schedules ─────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/schedules') {
    const enabledOnly = url.searchParams.get('enabledOnly') === 'true';
    sendJson(res, 200, {
      schedules: memory.schedules.list({ enabledOnly }),
    });
    return true;
  }

  // ── DELETE /api/memory/schedules/:id ─────────────────────────────────────
  const scheduleIdDelete = matchPath(req.method, path, 'DELETE', '/api/memory/schedules/');
  if (scheduleIdDelete) {
    const ok = memory.schedules.delete(scheduleIdDelete);
    sendJson(res, ok ? 200 : 404, { deleted: ok, id: scheduleIdDelete });
    return true;
  }

  // ── POST /api/memory/schedules/:id/toggle ────────────────────────────────
  if (
    req.method === 'POST' &&
    path.startsWith('/api/memory/schedules/') &&
    path.endsWith('/toggle')
  ) {
    const id = decodeURIComponent(
      path.slice('/api/memory/schedules/'.length, -('/toggle'.length))
    );
    const body = await readJsonBody(req);
    const enabled = body.enabled !== false;
    const ok = memory.schedules.setEnabled(id, enabled);
    sendJson(res, ok ? 200 : 404, { id, enabled, ok });
    return true;
  }

  // ── GET /api/memory/forget-candidates ────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/forget-candidates') {
    const threshold = Number(url.searchParams.get('threshold')) || undefined;
    const limit = Number(url.searchParams.get('limit')) || 50;
    const namespace = url.searchParams.get('namespace') ?? undefined;
    const candidates = memory.facts.getForgetCandidates({
      threshold,
      limit,
      namespace,
    });
    sendJson(res, 200, { candidates });
    return true;
  }

  // ── POST /api/memory/facts/:id/{pin,unpin,forget,unforget} ───────────────
  const factAction = matchFactAction(req.method, path);
  if (factAction) {
    const { id, action } = factAction;
    let ok = false;
    switch (action) {
      case 'pin':       ok = memory.facts.pin(id); break;
      case 'unpin':     ok = memory.facts.unpin(id); break;
      case 'forget':    ok = memory.facts.softForget(id); break;
      case 'unforget':  ok = memory.facts.unforget(id); break;
    }
    sendJson(res, ok ? 200 : 404, { id, action, ok });
    return true;
  }

  // ── GET /api/memory/facts ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/facts') {
    const ns = url.searchParams.get('namespace');
    if (ns) {
      sendJson(res, 200, { namespace: ns, facts: memory.facts.listFacts(ns) });
    } else {
      // List facts across all namespaces
      const namespaces = memory.facts.listNamespaces();
      const grouped: Record<string, unknown[]> = {};
      for (const n of namespaces) {
        grouped[n] = memory.facts.listFacts(n);
      }
      sendJson(res, 200, { grouped });
    }
    return true;
  }

  // ── GET /api/memory/skills ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/skills') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    sendJson(res, 200, { skills: memory.skills.listAll(limit) });
    return true;
  }

  // ── GET /api/memory/skills/:name ──────────────────────────────────────────
  if (req.method === 'GET' && path.startsWith('/api/memory/skills/')) {
    const name = decodeURIComponent(path.slice('/api/memory/skills/'.length));
    const skill = memory.skills.getByName(name);
    if (!skill) {
      sendJson(res, 404, { error: `skill '${name}' not found` });
      return true;
    }
    sendJson(res, 200, { skill });
    return true;
  }

  // ── DELETE /api/memory/skills/:name ───────────────────────────────────────
  if (req.method === 'DELETE' && path.startsWith('/api/memory/skills/')) {
    const name = decodeURIComponent(path.slice('/api/memory/skills/'.length));
    const ok = memory.skills.deleteSkill(name);
    sendJson(res, ok ? 200 : 404, { deleted: ok, name });
    return true;
  }

  // ── GET /api/mcp/status ───────────────────────────────────────────────────
  // Which external MCP servers are actually connected right now, and what they mounted. Without this
  // a failed or dead server is invisible: the tools simply are not there and nothing says why.
  if (req.method === 'GET' && path === '/api/mcp/status') {
    sendJson(res, 200, getMcpStatus());
    return true;
  }

  // ══ Skill marketplace (aggregator client over git/URL + clawhub) ══════════
  // GET /api/skills/registry/search?q=&limit=
  if (req.method === 'GET' && path === '/api/skills/registry/search') {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Number(url.searchParams.get('limit')) || 10;
    if (!q) { sendJson(res, 400, { error: 'q is required' }); return true; }
    const { results, warnings } = await searchAll(q, limit);
    sendJson(res, 200, { query: q, results, warnings });
    return true;
  }

  // GET /api/skills/registry/inspect?sourceId=&id=  (fetch + scan, no install)
  if (req.method === 'GET' && path === '/api/skills/registry/inspect') {
    const sourceId = url.searchParams.get('sourceId') || '';
    const id = url.searchParams.get('id') || '';
    if (!sourceId || !id) { sendJson(res, 400, { error: 'sourceId and id are required' }); return true; }
    try {
      const { bundle, scan, decision } = await inspectBundle(sourceId, id);
      // notInstalled: companion files the source ships that a SKILL.md-only install drops. Surfaced
      // in the preview so the user sees it before installing, not after.
      sendJson(res, 200, {
        meta: bundle.meta,
        content: bundle.content,
        scan,
        decision,
        notInstalled: bundle.notInstalled ?? null,
      });
    } catch (e) {
      sendJson(res, 502, { error: (e as Error).message });
    }
    return true;
  }

  // POST /api/skills/registry/install  {sourceId, identifier, name?, confirm?}
  if (req.method === 'POST' && path === '/api/skills/registry/install') {
    const body = await readJsonBody(req);
    const sourceId = String(body.sourceId || '');
    const identifier = String(body.identifier || '');
    if (!sourceId || !identifier) { sendJson(res, 400, { error: 'sourceId and identifier are required' }); return true; }
    try {
      // This API is intentionally unauthenticated and the agent itself can reach it through shell.
      // Consequently no value obtained from another anonymous HTTP endpoint can prove a human is
      // present. Keep block overrides unavailable here until they are backed by an authenticated,
      // out-of-band approval channel; otherwise the agent can mint its own "user" approval.
      const overrideRejection = rejectUnauthenticatedSkillOverride(body);
      if (overrideRejection) {
        sendJson(res, 403, { status: 'blocked', error: overrideRejection });
        return true;
      }

      const outcome = await installFromSource({
        sourceId,
        identifier,
        name: body.name ? String(body.name) : undefined,
        confirm: body.confirm === true,
        actor: 'api',
        auditNote: describeCaller(req),
        now: new Date().toISOString(),
      });
      if (outcome.status === 'installed') await reloadSkillsFromDisk();
      // Always 200: install outcome (installed/ask/blocked/error) is data the UI interprets,
      // not an HTTP-level error. Only a thrown exception is a real 500.
      sendJson(res, 200, outcome);
    } catch (e) {
      sendJson(res, 500, { status: 'error', error: (e as Error).message });
    }
    return true;
  }

  // GET /api/skills/registry/updates  (which installed skills have a newer source)
  if (req.method === 'GET' && path === '/api/skills/registry/updates') {
    const updates = await checkForUpdates();
    sendJson(res, 200, { updates });
    return true;
  }

  // POST /api/skills/registry/update  {name} | {all:true}
  if (req.method === 'POST' && path === '/api/skills/registry/update') {
    const body = await readJsonBody(req);
    const now = new Date().toISOString();
    try {
      let updated: Awaited<ReturnType<typeof updateSkill>>[] = [];
      // actor 'api', not 'user': this endpoint has no authentication, so the audit line records where
      // the request came from rather than asserting a person made the decision. (Updates cannot
      // override the gate in any case — a newly dangerous version is blocked and must be decided again.)
      const caller = { actor: 'api' as const, auditNote: describeCaller(req) };
      if (body.all === true) {
        const statuses = await checkForUpdates();
        for (const s of statuses) {
          if (s.changed) updated.push(await updateSkill(s.name, { confirm: true, ...caller, now }));
        }
      } else {
        const name = String(body.name || '');
        if (!name) { sendJson(res, 400, { error: 'name or all:true is required' }); return true; }
        updated = [await updateSkill(name, { confirm: true, ...caller, now })];
      }
      if (updated.some((u) => u.status === 'installed')) await reloadSkillsFromDisk();
      // Always 200: per-skill outcomes (installed/blocked/error) are data, not HTTP errors.
      sendJson(res, 200, { updated });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
    return true;
  }

  // GET /api/skills/installed  (loaded skills + marketplace provenance + bundled flag)
  if (req.method === 'GET' && path === '/api/skills/installed') {
    const lock = readLock();
    // True bundled set = subdirectory names under bundled-skills/. This is the only reliable
    // signal: source==null also covers some self-learned (reflection) skills.
    let bundledNames = new Set<string>();
    try {
      bundledNames = new Set(
        readdirSync(bundledSkillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name),
      );
    } catch { /* dir missing → empty set */ }
    const skills = memory.skills.listAll(500).map((s) => ({
      ...s,
      provenance: lock[s.name] ?? null,
      bundled: bundledNames.has(s.name),
    }));
    sendJson(res, 200, { skills });
    return true;
  }

  // DELETE /api/skills/installed/:name  (delete the file + lock entry, then reload)
  if (req.method === 'DELETE' && path.startsWith('/api/skills/installed/')) {
    const name = decodeURIComponent(path.slice('/api/skills/installed/'.length));
    const result = await uninstallSkillTool.execute({ name });
    try { removeLock(name); } catch { /* advisory */ }
    await reloadSkillsFromDisk();
    sendJson(res, result.success ? 200 : 500, { deleted: result.success, name, output: result.output, error: result.error });
    return true;
  }

  // ── GET /api/memory/notes ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/notes') {
    const limit = Number(url.searchParams.get('limit')) || 20;
    sendJson(res, 200, { notes: memory.notes.listTopImportant(limit) });
    return true;
  }

  // ── GET /api/memory/notes/search?q=... ────────────────────────────────────
  if (req.method === 'GET' && path === '/api/memory/notes/search') {
    const q = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit')) || 10;
    if (!q) {
      sendJson(res, 400, { error: 'missing query parameter q' });
      return true;
    }
    sendJson(res, 200, { query: q, results: memory.notes.search(q, limit) });
    return true;
  }

  // ── GET /api/memory/sessions ──────────────────────────────────────────────
  // Query params:
  //   limit/offset — pagination
  //   since/until  — time filter (ISO8601 or epoch ms)
  //   q            — when set, does full-text message search and aggregates to session level
  if (req.method === 'GET' && path === '/api/memory/sessions') {
    const limit = Number(url.searchParams.get('limit')) || 20;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const sinceStr = url.searchParams.get('since');
    const untilStr = url.searchParams.get('until');
    const q = url.searchParams.get('q') ?? '';
    const parseTime = (s: string | null): number | undefined => {
      if (!s) return undefined;
      const asNum = Number(s);
      if (Number.isFinite(asNum) && asNum > 0) return asNum;
      const parsed = Date.parse(s);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const since = parseTime(sinceStr);
    const until = parseTime(untilStr);

    if (q) {
      // Search path: find messages first → aggregate to sessions → assemble summaries
      const hits = memory.raw.searchMessages(q, {
        since,
        until,
        limit: Math.max(limit, 5) * 6,
      });
      const bySession = new Map<string, typeof hits>();
      for (const m of hits) {
        const arr = bySession.get(m.sessionId) ?? [];
        arr.push(m);
        bySession.set(m.sessionId, arr);
      }
      const results = Array.from(bySession.entries())
        .map(([sid, msgs]) => {
          const session = memory.raw.getSession(sid);
          const summary = memory.notes.getNoteById(`session-summary-${sid}`);
          return {
            sessionId: sid,
            startedAt: session?.startedAt ?? msgs[0].timestamp,
            endedAt: session?.endedAt ?? null,
            summary: summary?.content ?? null,
            hits: msgs.slice(0, 5).map((m) => ({
              role: m.role,
              timestamp: m.timestamp,
              snippet: m.content.slice(0, 300),
            })),
          };
        })
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(offset, offset + limit);
      sendJson(res, 200, { query: q, sessions: results });
      return true;
    }

    const sessions = memory.raw.listSessions({ since, until, limit, offset });
    sendJson(res, 200, { sessions });
    return true;
  }

  // ── GET /api/memory/sessions/:id ──────────────────────────────────────────
  if (req.method === 'GET' && path.startsWith('/api/memory/sessions/')) {
    const id = path.slice('/api/memory/sessions/'.length);
    const session = memory.raw.getSession(id);
    if (!session) {
      sendJson(res, 404, { error: `session '${id}' not found` });
      return true;
    }
    sendJson(res, 200, {
      session,
      messages: memory.raw.getMessages(id),
    });
    return true;
  }

  // ── GET /api/autonomous/overview ──────────────────────────────────────────
  // Single fetch for the dashboard: today's budget / counts by status / active driver names /
  // total active push subscriptions / global push kill switch
  if (req.method === 'GET' && path === '/api/autonomous/overview') {
    const userId = url.searchParams.get('userId') || 'default';
    const now = Date.now();
    const today = utcDateString(now);
    const dailyUsage = autonomousLoop.budget.getDailyUsage(userId, now);
    const statusCounts = autonomousLoop.initiatives.countByStatusGroup();
    sendJson(res, 200, {
      today,
      userId,
      budget: {
        caps: autonomousLoop.budget.caps,
        dailyUsage,
      },
      initiatives: {
        total: autonomousLoop.initiatives.count(),
        byStatus: statusCounts,
      },
      drivers: autonomousDriverNames,
      pushChannels: listRegisteredPushChannels(),
      pushSubscriptionsActive: memory.pushSubscriptions.countActive(),
      pushSubscriptionsTotal: memory.pushSubscriptions.count(),
      pushGloballyEnabled: process.env.PHILONT_PUSH_ENABLED !== '0',
    });
    return true;
  }

  // ── GET /api/autonomous/initiatives?limit=&status=&driver= ───────────────
  if (req.method === 'GET' && path === '/api/autonomous/initiatives') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 30));
    const statusParam = url.searchParams.get('status') ?? undefined;
    const driverParam = url.searchParams.get('driver') ?? undefined;
    // Simple status whitelist to prevent injection (SQLite uses prepare anyway, but be safe)
    const validStatuses = new Set(['pending', 'running', 'done', 'failed', 'skipped']);
    const status =
      statusParam && validStatuses.has(statusParam)
        ? (statusParam as 'pending' | 'running' | 'done' | 'failed' | 'skipped')
        : undefined;
    const initiatives = autonomousLoop.initiatives.listRecent({
      limit,
      status,
      driver: driverParam,
    });
    sendJson(res, 200, { initiatives });
    return true;
  }

  // ── GET /api/autonomous/failure-signatures?since-h=24&limit=30 ───────────
  // Cluster failed tool calls from the last N hours by (toolName + errorClass) → top groups.
  // Shown in the dashboard as "agent hitting the same wall repeatedly".
  if (req.method === 'GET' && path === '/api/autonomous/failure-signatures') {
    const sinceH = Math.max(1, Math.min(168, Number(url.searchParams.get('since-h')) || 24));
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 30));
    const sinceTs = Date.now() - sinceH * 3_600_000;
    const failures = memory.actions.listRecentFailures({ sinceTs, limit });
    const groups = groupFailures(failures);
    sendJson(res, 200, {
      sinceH,
      totalFailures: failures.length,
      groups,
    });
    return true;
  }

  // ── GET /api/autonomous/selfhood ──────────────────────────────────────────
  // Selfhood section for the dashboard (WS6 §8): live traits, evidence-backed
  // self-observations, the pursuit agenda, pending constitution proposals, today's work.
  if (req.method === 'GET' && path === '/api/autonomous/selfhood') {
    sendJson(res, 200, autonomySelfhoodStatus());
    return true;
  }

  // ── GET /api/autonomous/push-subscriptions ────────────────────────────────
  if (req.method === 'GET' && path === '/api/autonomous/push-subscriptions') {
    const channel = url.searchParams.get('channel');
    const subs = channel
      ? memory.pushSubscriptions.listByChannel(channel)
      : memory.pushSubscriptions.listActive();
    sendJson(res, 200, { subscriptions: subs });
    return true;
  }

  // 2026-05-12 Phase 8 M5: Config Rules + Bug Reports dashboard endpoints
  // ── GET /api/autonomous/config-rules?scope=&confidence= ──────────────────
  if (req.method === 'GET' && path === '/api/autonomous/config-rules') {
    const scope = url.searchParams.get('scope');
    const confidence = url.searchParams.get('confidence');
    let rules = scope
      ? memory.configRules.listByScope(scope as any)
      : memory.configRules.listAll();
    if (confidence) {
      rules = rules.filter((r) => r.confidence === confidence);
    }
    sendJson(res, 200, {
      rules,
      scopes: ['autonomous_blacklist', 'task_mode_classifier.skip_patterns',
        'task_mode_classifier.heuristic_rules', 'in_turn_reflection.threshold',
        'plan_protocol_gate.exempt_tools'],
      total: rules.length,
    });
    return true;
  }

  // ── GET /api/autonomous/bug-reports?since-h=24&severity= ─────────────────
  if (req.method === 'GET' && path === '/api/autonomous/bug-reports') {
    const sinceH = Number(url.searchParams.get('since-h') ?? '24');
    const severity = url.searchParams.get('severity');
    const cutoff = Date.now() - sinceH * 3600_000;

    // Fetch bug_report_generated events from internalAudit
    const events = internalAudit.getEvents().filter(
      (ev) => ev.type === 'bug_report_generated' && ev.timestamp >= cutoff,
    );
    let reports = events.map((ev) => {
      const d = ev.data as Record<string, unknown>;
      return {
        pattern: d.pattern,
        key: d.key,
        title: d.title,
        severity: d.severity,
        expected: d.expected,
        actual: d.actual,
        fileHint: d.fileHint,
        fixProposal: d.fixProposal,
        count: d.count,
        firstSeen: d.firstSeen,
        lastSeen: d.lastSeen,
        evidence: d.evidence,
        auditTs: ev.timestamp,
      };
    });
    if (severity) reports = reports.filter((r) => r.severity === severity);
    sendJson(res, 200, { reports, total: reports.length });
    return true;
  }

  return false;
}

// ── HTTP server ────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // API routes
  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url);
      if (!handled) {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return;
  }

  // Default page
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`AgentCore Server\n\nHTTP API: /api/memory/*\nWebSocket: ws://localhost:${PORT}`);
});

// ── WebSocket (preserves existing chat behaviour) ──────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const sessionId = Math.random().toString(36).slice(2);
  console.log('Client connected, session:', sessionId);

  // Wrap ws.send: silently drops the send if the connection is already closed / send throws.
  const safeSend = (payload: object): void => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error(`[ws ${safeSessionId(sessionId)}] send failed:`, e);
    }
  };

  // Subscribe to scheduled reminders: push to this WS when the scheduler fires
  const onReminder = (ev: ReminderPayload) => {
    safeSend({
      type: 'reminder',
      text: ev.text,
      scheduleName: ev.scheduleName,
      at: ev.at,
    });
  };
  reminderEmitter.on('reminder', onReminder);

  // Subscribe to proactive, turn-external pushes (background research grant requests, autonomous
  // findings) so the web-ui reaches parity with WeChat/Telegram. Grant requests carry a structured
  // payload the front-end renders bilingually; findings carry pre-rendered text.
  const unregisterWebui = registerWebuiClient(sessionId, (m) => safeSend(m));

  ws.on('message', async (data) => {
    let msg: any = null;
    try {
      msg = JSON.parse(data.toString());
    } catch (parseErr) {
      console.error(`[ws ${safeSessionId(sessionId)}] invalid JSON:`, parseErr);
      safeSend({ type: 'error', message: `invalid JSON: ${String(parseErr)}` });
      return;
    }
    console.log('Received:', msg);

    if (msg?.type === 'chat.send') {
      // A real user action from the web-ui — this, not the socket connection, is what "the owner is
      // looking at the web-ui" means. Gates the proactive-push double-disturbance guard.
      markWebuiUserActivity();
      // Invariant: each chat.send corresponds to exactly one 'final'. The frontend only
      // unlocks input on 'final'. Whether handleChatSend succeeds, throws, or times out,
      // finally must emit one.
      let result: Awaited<ReturnType<typeof handleChatSend>> | null = null;
      let errMessage: string | null = null;
      try {
        console.log('Processing chat.send:', msg.content);
        result = await handleChatSend(
          sessionId,
          msg.content,
          (delta) => safeSend({ type: 'delta', text: delta }),
          (req) => {
            // 2026-05-19: onAuthRequest upgraded to a struct. The web-ui frontend currently
            // renders using the `text` string; shim here for backward compatibility.
            // On the next frontend upgrade, read payload directly for a richer auth UI.
            const paramSummary = (() => {
              try {
                const s = JSON.stringify(req.input);
                return s.length > 200 ? s.slice(0, 199) + '…' : s;
              } catch {
                return String(req.input);
              }
            })();
            const text =
              `Agent requests to run tool "${req.toolName}" (${req.capability}/${req.domain})` +
              (req.clarification ? `\n${req.clarification}` : '') +
              `\nParams: ${paramSummary}\nReply ${offeredAuthWords('en', 'grant').join(' / ')} to allow, ` +
              `or ${offeredAuthWords('en', 'deny').join(' / ')} to refuse ` +
              `(grant valid for 30 minutes by default)`;
            safeSend({ type: 'auth_request', text, payload: req });
          },
          // 2026-05-19 three-stream split: onStatus = Tier 2 semantic progress.
          // web-ui previously did not pass onStatus at all — this is net-new progress feedback.
          (status) => safeSend({ type: 'status', text: status }),
          // onTrace = Tier 3/4 detail + internal events → web-ui debug panel.
          (ev) => safeSend({ type: 'trace', event: ev }),
        );
      } catch (error) {
        const e: any = error;
        console.error(`[ws ${safeSessionId(sessionId)}] chat.send error:`, e);
        errMessage = String(e?.message ?? e);
      } finally {
        if (result) {
          safeSend({
            type: 'final',
            outcome: result.outcome,
            auditEvents: result.auditEvents,
          });
        } else {
          // Failure / timeout must also emit a final; outcomeType=error allows the frontend
          // to reset the input field.
          const isTimeout = errMessage?.includes('exceeded') && errMessage?.includes('deadline');
          safeSend({
            type: 'final',
            outcome: {
              outcomeType: isTimeout ? 'timeout' : 'error',
              text: currentPhraseLang() === 'en'
            ? `Failed: ${errMessage ?? 'unknown error'}`
            : `处理失败: ${errMessage ?? 'unknown error'}`,
            },
            auditEvents: 0,
          });
        }
      }
      return;
    }

    if (msg?.type === 'chat.stop') {
      // Interrupt teeth: user stops the current turn mid-way (UserHardStop). abort cancels
      // the in-flight LLM call + lets runToolLoop finish at a clean boundary →
      // the in-progress chat.send will emit its own 'final' with outcomeType='interrupted'
      // (which unlocks the frontend input).
      const stopped = abortActiveTurn(sessionId);
      safeSend({ type: 'stop_ack', stopped });
      return;
    }

    if (msg?.type === 'chat.end') {
      // Client explicitly ends the session: trigger extraction + reflection immediately,
      // without waiting for WS close
      try {
        console.log('chat.end, finalizing session:', sessionId);
        await finalizeSession(sessionId);
        safeSend({ type: 'session_finalized' });
      } catch (error) {
        console.error(`[ws ${safeSessionId(sessionId)}] chat.end error:`, error);
        safeSend({ type: 'error', message: String(error) });
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected, session:', sessionId);
    reminderEmitter.off('reminder', onReminder);
    unregisterWebui();
    // Trigger extraction on WS close: write facts/skills to Layer 2 / Layer 3;
    // visible to subsequent sessions after refresh
    finalizeSession(sessionId).catch((e) => {
      console.error('finalizeSession failed on disconnect:', e);
    });
  });
});

// Wall-clock watchdog. Not a timer that does work — one that notices when NO timer got to run, which
// is the only way to tell a suspended host from a hung agent. See suspend_detector.
startSuspendDetector();

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`  HTTP API:  http://localhost:${PORT}/api/memory/stats`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);

  // MCP connection assertion. External servers connect asynchronously, so this is deferred a few
  // seconds — but it must be PRINTED either way: a configured server that never connected is otherwise
  // invisible (its tools simply are not in the list, and nothing says why).
  if (getMcpStatus().configured > 0) {
    setTimeout(() => {
      const s = getMcpStatus();
      const down = s.servers.filter((x) => x.state !== 'connected');
      console[down.length ? 'warn' : 'log'](`[boot] ${s.summary}`);
      for (const d of down) console.warn(`[boot] MCP server "${d.name}" not connected: ${d.lastError ?? d.state}`);
    }, 10_000).unref?.();
  }

  // Referential integrity. Deferred to here rather than run at module load: the push channels and the
  // skill registry are populated by the gateway/hot-reload startup paths above, and a check that runs
  // before the registries exist would report every reference as broken. Advisory — never blocks boot.
  setTimeout(() => {
    void runStartupIntegrityCheck()
      .then(() => runDailyHealthCheck())
      .catch((e) => console.warn('[integrity] check failed to run:', e));
  }, 8000);

  // ...and once a day thereafter. Daily rather than hourly because the report competes for the owner's
  // attention with everything else the agent sends, and it only fires when something is degenerate.
  const healthTimer = setInterval(() => {
    void runDailyHealthCheck().catch(() => {});
  }, 24 * 60 * 60 * 1000);
  healthTimer.unref?.();

  // Mailbox lifetime is infrastructure, not a WeChat side effect. Run even when WECHAT_ENABLED=0,
  // and periodically thereafter so an idle/disabled channel cannot make expiry silent.
  maintainDeferredPushes(memory.deferredPushes, memory.metrics);
  const deferredPushMaintenanceTimer = setInterval(() => {
    maintainDeferredPushes(memory.deferredPushes, memory.metrics);
  }, 60 * 60_000);
  deferredPushMaintenanceTimer.unref?.();

  // Aux-LLM health probe. The aux model is shared by reflection, the learning judge, auth-intent and the
  // intent router; when its endpoint is misconfigured it fails SILENTLY (each caller degrades gracefully,
  // the main agent keeps working) so a 404 goes unnoticed while learning + the judge quietly do nothing.
  // Probe once at startup and warn LOUDLY if it is configured but not answering.
  if (isAuxLLMConfigured()) {
    void probeAuxLLM().then((r) => {
      if (r.ok) {
        console.log('[aux-llm] ✅ health probe ok');
      } else {
        console.error(
          [
            `[aux-llm] ⚠️  AUX LLM IS CONFIGURED BUT NOT ANSWERING: ${r.error}`,
            '           → reflection (self-learning), the learning judge, auth-intent classification and the',
            '             intent router are ALL DEGRADED (they fail safe, so the main agent still works and you',
            "             won't otherwise see this). Check AUX_LLM_BASE_URL / AUX_LLM_MODEL / AUX_LLM_API_KEY.",
          ].join('\n'),
        );
      }
    });
  } else {
    console.log('[aux-llm] not configured — reflection/judge/auth-intent fall back to the main LLM or degrade');
  }
});

// ── WeChat channel (optional; enabled with WECHAT_ENABLED=1) ──────────────
if (process.env.WECHAT_ENABLED === '1') {
  // Dynamic import to prevent a misconfigured WeChat setup from breaking the main server startup
  import('./channels/wechat/index.js')
    .then(({ startWeChatGateway }) =>
      startWeChatGateway({
        chatSend: handleChatSend,
        deferredPushes: memory.deferredPushes,
        onAuthDelivered: markPendingAuthDelivered,
        onAuthDeliveryFailed: markPendingAuthDeliveryFailed,
      }),
    )
    .then((gw) => {
      console.log('  WeChat:    ✅ gateway scheduled (long-poll)');
      // Being reachable is not the same as being subscribed. Proactive push is per-peer opt-in by
      // design (consent), but that default was silent: a channel nobody had opted into looked exactly
      // like a channel with nothing to say, and the owner's report was "it never tells me anything".
      // Say which it is, at the one moment someone is reading.
      try {
        const subs = memory.pushSubscriptions.listActive();
        // Subscribed is not deliverable either. This banner claimed "proactive findings can reach you" for
        // months while every push was being skipped as channel_not_found, because the subscription's channel
        // name and the registered channel name were written by two different conventions. A claim about
        // reachability now resolves the channel it is claiming, so the banner cannot outrun the mechanism.
        const undeliverable = subs.filter((s) => !findPushChannel(s.channel));
        console.log(
          subs.length === 0
            ? '  Push:      ⚠️  no active subscriptions — proactive findings will NOT reach WeChat/Telegram ' +
              '(DM the bot once to auto-subscribe, or say "开启推送")'
            : undeliverable.length === 0
              ? `  Push:      ✅ ${subs.length} active subscription(s) — proactive findings can reach you`
              : `  Push:      ⛔ ${undeliverable.length}/${subs.length} subscription(s) cannot be delivered: ` +
                undeliverable.map((s) => `${s.channel}:${s.peer} — ${describePushChannelMiss(s.channel)}`).join(' ; '),
        );
      } catch { /* advisory only */ }
      // Reuse server graceful-shutdown path
      const stopGw = () => {
        void gw.stop();
      };
      process.once('SIGTERM', stopGw);
      process.once('SIGINT', stopGw);
    })
    .catch((e: unknown) => {
      console.error('  WeChat:    ❌ Startup failed:', (e as any)?.message ?? e);
      console.error('             (The rest of the service keeps running. Check ~/.philont/wechat/ credentials or run npm run wechat:login)');
    });
}

// ── Telegram channel (optional; enabled with TELEGRAM_ENABLED=1 + TELEGRAM_BOT_TOKEN) ────
import('./channels/telegram/config.js')
  .then(({ readTelegramConfig }) => {
    const cfg = readTelegramConfig();
    if (!cfg) return; // not enabled / missing token → silently skip
    return import('./channels/telegram/index.js').then(({ startTelegramGateway }) =>
      startTelegramGateway({
        chatSend: handleChatSend,
        token: cfg.token,
        policy: cfg.policy,
        onAuthDelivered: markPendingAuthDelivered,
        onAuthDeliveryFailed: markPendingAuthDeliveryFailed,
      }).then((gw) => {
        console.log('  Telegram:  ✅ gateway scheduled (long-poll)');
        const stopGw = () => gw.stop();
        process.once('SIGTERM', stopGw);
        process.once('SIGINT', stopGw);
      }),
    );
  })
  .catch((e: unknown) => {
    console.error('  Telegram:  ❌ Startup failed:', (e as { message?: string })?.message ?? e);
    console.error('             (The rest of the service keeps running. Check TELEGRAM_BOT_TOKEN)');
  });

// Graceful shutdown: close memory (including backup timer), scheduler, and skill watchers
// to avoid leaving a dangling WAL or a half-written backup file on systemd stop / Ctrl+C.
//
// **Order is critical**: closeIdleConsolidator() must be awaited and completed before
// memory.close(); otherwise an in-flight tick will hit an already-closed DB and produce
// "database connection is not open" error chains.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down`);
  try { closeSkillWatchers(); } catch (e) { console.warn('closeSkillWatchers:', e); }
  try { closeScheduler(); } catch (e) { console.warn('closeScheduler:', e); }
  try { await closeIdleConsolidator(); } catch (e) { console.warn('closeIdleConsolidator:', e); }
  try { await closeAutonomousLoop(); } catch (e) { console.warn('closeAutonomousLoop:', e); }
  try { await closeMcpBridgesOnShutdown(); } catch (e) { console.warn('closeMcpBridges:', e); }
  try { closeFetchedStore(); } catch (e) { console.warn('closeFetchedStore:', e); }
  try { memory.close(); } catch (e) { console.warn('memory.close:', e); }
  server.close((err) => {
    if (err) console.warn('[server] http close:', err);
    process.exit(0);
  });
  // Fallback: HTTP close can hang on keep-alive connections; force exit after 10s
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
