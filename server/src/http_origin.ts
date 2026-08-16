/**
 * Origin boundary for the local HTTP API.
 *
 * The API answered every request with `Access-Control-Allow-Origin: *` and no authentication of any
 * kind. That was survivable while every endpoint was either a read or an action the owner had already
 * authorised elsewhere. It stopped being survivable when the skill-install endpoint gained an
 * `override` flag that walks a skill past the safety gate: with a wildcard CORS policy, ANY page the
 * owner happens to have open can POST to this port, and a skill is a document the agent then follows —
 * a drive-by page turns into persistent instructions.
 *
 * Two rules, both cheap:
 *   1. CORS is echoed only for origins we trust (loopback, plus anything the operator names in
 *      PHILONT_ALLOWED_ORIGINS) — never `*`.
 *   2. State-changing requests (POST/PUT/PATCH/DELETE) are refused when they carry a foreign Origin
 *      or `Sec-Fetch-Site: cross-site`. A browser cannot forge either header.
 *
 * What this does NOT solve, stated plainly: a process already running on this machine — including
 * philont's own shell tool — can call the API with no Origin at all and is indistinguishable from a
 * local script. Safety-gate overrides therefore remain unavailable on the unauthenticated HTTP API;
 * everything here is about keeping the wider internet out.
 */

import type { IncomingMessage } from 'node:http';

/** Loopback hosts, any port. */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

function configuredOrigins(): string[] {
  return (process.env.PHILONT_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  const o = origin.trim().replace(/\/+$/, '');
  if (LOOPBACK.test(o)) return true;
  return configuredOrigins().includes(o);
}

/** CORS headers for one request: echo a trusted origin, or send none at all. */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin as string | undefined;
  if (!isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Is this state-changing request allowed to proceed?
 *
 * `null` = fine. A string = the reason it was refused (also used as the audit note).
 * A request with NO Origin is allowed: that is a local CLI/script/curl, which is a legitimate way to
 * drive this API and cannot be produced by a cross-site page.
 */
export function rejectCrossSite(req: IncomingMessage): string | null {
  if (!MUTATING.has(req.method ?? 'GET')) return null;

  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return 'cross-site request refused';

  const origin = req.headers.origin as string | undefined;
  if (origin && !isAllowedOrigin(origin)) return `origin not allowed: ${origin}`;

  return null;
}

/** Where a request appears to come from, for audit records. */
export function describeCaller(req: IncomingMessage): string {
  const origin = req.headers.origin as string | undefined;
  if (origin) return `origin=${origin}`;
  const ua = String(req.headers['user-agent'] ?? '').slice(0, 60);
  return `local(no-origin)${ua ? ` ua=${ua}` : ''}`;
}
