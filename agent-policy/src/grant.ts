/**
 * GrantStore: dynamic grant storage with TTL decay
 *
 * Supports three grant granularities (scope):
 *   - tool:    authorises the entire tool (original semantics, default)
 *   - command: glob-matches against the command field
 *   - path:    glob-matches against the path/from/to fields
 *
 * Grants are additive: the same tool name can have multiple grants with different scopes.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Capability, Domain } from './matrix.js';

export type GrantScope = 'tool' | 'command' | 'path';

export interface Grant {
  toolName:   string;
  scope:      GrantScope;
  /** pattern: ignored when scope='tool'; for 'command'/'path' it is a glob pattern */
  pattern?:   string;
  capability: Capability;
  domain:     Domain;
  expiresAt:  number;
  reason:     string;
  /**
   * WHO this grant was issued for. Absent means "whoever calls" — the ordinary case, an approval the
   * owner gave in a conversation about the work in front of them.
   *
   * Set, it means the approval was about a narrower context and does not travel outside it. Grants
   * are looked up by tool NAME, so without this a yes given to background research for `shell` was
   * equally a yes for the main loop, for a plan sub-task, and for any other pursuit — the reason
   * string recorded which research had asked, and nothing read it.
   */
  audience?:  string;
  /**
   * When the owner approved. Renewal-on-use never pushes expiry past
   * `issuedAt + ttlMs * RENEWAL_CEILING_FACTOR`, so an unattended loop cannot hold a grant forever.
   */
  issuedAt:   number;
  /** The window the caller asked for. A use re-arms exactly this much from the moment of use. */
  ttlMs:      number;
}

/** Default is long enough for a multi-step workflow; callers may still narrow it. */
export const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;

/**
 * How far USE may stretch a grant, as a multiple of the window its caller asked for.
 *
 * The TTL was measuring the wrong thing. Prod 2026-08-28: a writeFile approval at 10:34:41 granted the
 * local research set for 30 minutes; the turn it authorised was still running at 11:05 and every
 * z3Verify/pariGp call from then on was denied by the matrix — the verifiers went dark mid-turn while
 * the turn kept working and reported a compile result. A 30-minute window and a 16-minute turn are the
 * same order of magnitude, so expiry inside the authorised loop is the normal case, not the edge one.
 *
 * The owner's yes was about a loop, so the clock should measure whether that loop is still running.
 * Expressed as a multiple of the caller's own window rather than a new global constant: a 30-minute
 * workflow grant survives up to two hours of CONTINUOUS use, a 60-minute one up to four, and any of
 * them lapses on schedule the moment the work actually stops.
 */
export const RENEWAL_CEILING_FACTOR = 4;

/** Simple glob compiler (supports *, **, ?) */
function globToRegex(pattern: string): RegExp {
  const expanded = pattern.startsWith('~') ? homedir() + pattern.slice(1) : pattern;
  let regex = '';
  let i = 0;
  while (i < expanded.length) {
    const c = expanded[i];
    if (c === '*') {
      if (expanded[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (expanded[i] === '/') i++;
        continue;
      }
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if ('.+^$()|[]{}\\'.includes(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp('^' + regex + '$');
}

function normalizePath(p: string): string {
  const expanded = p.startsWith('~') ? homedir() + p.slice(1) : p;
  return resolve(expanded);
}

export class GrantStore {
  // Indexed by toolName; value is a list of grants
  private grants = new Map<string, Grant[]>();
  /** Most recent expiry seen while pruning, per tool — lets a denial say "it ran out" (see expiredRecently). */
  private lastExpiredAt = new Map<string, number>();

  /**
   * Add a grant
   *
   * Two calling forms (backward compatible):
   *   grant(toolName, capability, domain, reason, ttlMs?)  — equivalent to scope='tool'
   *   grant({ toolName, scope, pattern, capability, domain, reason, ttlMs? })
   */
  grant(toolName: string, capability: Capability, domain: Domain, reason: string, ttlMs?: number): void;
  grant(spec: {
    toolName: string;
    scope?: GrantScope;
    pattern?: string;
    capability: Capability;
    domain: Domain;
    reason: string;
    ttlMs?: number;
    audience?: string;
  }): void;
  grant(
    arg: string | {
      toolName: string;
      scope?: GrantScope;
      pattern?: string;
      capability: Capability;
      domain: Domain;
      reason: string;
      ttlMs?: number;
      audience?: string;
    },
    capability?: Capability,
    domain?: Domain,
    reason?: string,
    ttlMs: number = DEFAULT_GRANT_TTL_MS,
  ): void {
    let g: Grant;
    if (typeof arg === 'string') {
      g = {
        toolName: arg,
        scope: 'tool',
        capability: capability!,
        domain: domain!,
        expiresAt: Date.now() + ttlMs,
        reason: reason!,
        issuedAt: Date.now(),
        ttlMs,
      };
    } else {
      g = {
        toolName: arg.toolName,
        scope: arg.scope ?? 'tool',
        pattern: arg.pattern,
        capability: arg.capability,
        domain: arg.domain,
        expiresAt: Date.now() + (arg.ttlMs ?? DEFAULT_GRANT_TTL_MS),
        reason: arg.reason,
        audience: arg.audience,
        issuedAt: Date.now(),
        ttlMs: arg.ttlMs ?? DEFAULT_GRANT_TTL_MS,
      };
    }

    const list = this.grants.get(g.toolName) ?? [];
    list.push(g);
    this.grants.set(g.toolName, list);
  }

  /**
   * Check whether there is an unexpired grant
   *
   * @param toolName   Tool name
   * @param params     Tool parameters (optional; used for command/path scope matching)
   * @param scopeMin   Minimum scope requirement:
   *                     'tool'    = accept any scope (default, used by the matrix layer)
   *                     'command' = accept only command/path scope (used by the validator layer)
   *                     'path'    = same as above
   */
  isGranted(
    toolName: string,
    params?: Record<string, unknown>,
    scopeMin: GrantScope = 'tool',
    audience?: string,
  ): boolean {
    return this.findActive(toolName, params, scopeMin, audience) !== null;
  }

  /**
   * Same question as `isGranted`, but records that a granted call is actually HAPPENING, which re-arms
   * the grant's own window (bounded by RENEWAL_CEILING_FACTOR).
   *
   * Separate from `isGranted` on purpose: several callers ask "is this tool granted?" to widen a
   * whitelist or render a status, and merely asking must not keep an approval alive. Only the
   * authorization check that immediately precedes execution should call this one.
   */
  useGrant(
    toolName: string,
    params?: Record<string, unknown>,
    scopeMin: GrantScope = 'tool',
    audience?: string,
  ): boolean {
    const g = this.findActive(toolName, params, scopeMin, audience);
    if (!g) return false;
    const now = Date.now();
    const ceiling = g.issuedAt + g.ttlMs * RENEWAL_CEILING_FACTOR;
    // Never shrink, never exceed the ceiling.
    g.expiresAt = Math.max(g.expiresAt, Math.min(ceiling, now + g.ttlMs));
    return true;
  }

  /**
   * When a grant for this tool last lapsed, if it lapsed within `windowMs`.
   *
   * A grant that runs out mid-workflow is indistinguishable at the denial site from one that never
   * existed, and the two call for opposite responses — ask the owner, versus say the approval ran out.
   * Prod 2026-08-28 read as the former and printed twelve identical matrix denials.
   */
  expiredRecently(toolName: string, windowMs: number, now: number = Date.now()): number | null {
    const at = this.lastExpiredAt.get(toolName);
    return at !== undefined && now - at <= windowMs ? at : null;
  }

  private findActive(
    toolName: string,
    params?: Record<string, unknown>,
    scopeMin: GrantScope = 'tool',
    audience?: string,
  ): Grant | null {
    const list = this.grants.get(toolName);
    if (!list || list.length === 0) return null;

    const now = Date.now();
    const active = list.filter(g => g.expiresAt > now);
    if (active.length !== list.length) {
      const lapsed = Math.max(...list.filter(g => g.expiresAt <= now).map(g => g.expiresAt));
      this.lastExpiredAt.set(toolName, lapsed);
    }
    if (active.length === 0) {
      this.grants.delete(toolName);
      return null;
    }
    if (active.length !== list.length) {
      this.grants.set(toolName, active);
    }

    for (const g of active) {
      // Validator level does not accept tool-scope (tool-scope can only bypass the matrix)
      if (scopeMin !== 'tool' && g.scope === 'tool') continue;
      // An audience-scoped grant answers only to that audience. An unscoped one answers to everyone,
      // which keeps every existing grant behaving exactly as before.
      if (g.audience !== undefined && g.audience !== audience) continue;
      if (this.matches(g, params)) return g;
    }
    return null;
  }

  private matches(g: Grant, params?: Record<string, unknown>): boolean {
    if (g.scope === 'tool') return true;
    if (!params || !g.pattern) return false;

    if (g.scope === 'command') {
      const cmd = params.command;
      if (typeof cmd !== 'string') return false;
      return globToRegex(g.pattern).test(cmd);
    }

    if (g.scope === 'path') {
      const rx = globToRegex(g.pattern);
      for (const key of ['path', 'from', 'to', 'cwd']) {
        const v = params[key];
        if (typeof v === 'string' && rx.test(normalizePath(v))) return true;
      }
      return false;
    }

    return false;
  }

  /** Revoke all grants for a tool */
  revoke(toolName: string): void {
    this.grants.delete(toolName);
  }

  /** Return all unexpired grants (for debugging) */
  list(): Grant[] {
    const now = Date.now();
    const out: Grant[] = [];
    for (const [name, list] of this.grants) {
      const active = list.filter(g => g.expiresAt > now);
      if (active.length > 0) {
        out.push(...active);
        if (active.length !== list.length) this.grants.set(name, active);
      } else {
        this.grants.delete(name);
      }
    }
    return out;
  }
}
