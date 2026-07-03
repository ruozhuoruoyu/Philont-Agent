/**
 * Mechanism-layer credential auto-capture.
 *
 * On autonomous/scheduled turns `saveCredential` is blacklisted, so a register response's api_key
 * could never be persisted → every subsequent authenticated http call 401'd (prod avalanche: the
 * mycox heartbeat re-registered each fire and then failed every business call). When a SUCCESSFUL
 * auth/register response carries a credential, the mechanism (not the model, so no blacklist
 * relaxation) stores it into the SecretStore under a service-derived id that matches the placeholder
 * the model naturally writes — `{<service>-api-key}` — so later calls authenticate.
 *
 * Deliberately conservative: only POST/PUT to an auth-shaped path, only a recognised credential
 * field with a plausibly-secret value. It never harvests arbitrary API responses.
 */

export function credentialCaptureEnabled(): boolean {
  const v = (process.env.PHILONT_HTTP_CREDENTIAL_CAPTURE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

const AUTH_PATH_RE = /\/(?:auth|register|signup|sign-up|login|signin|sign-in|token|session)s?\b/i;
// Ordered by specificity; the bare "key" name is intentionally excluded (too generic).
const CRED_FIELDS = [
  'api_key', 'apiKey', 'access_token', 'accessToken', 'session_token', 'sessionToken', 'token', 'secret',
] as const;

export interface CapturedCredential {
  /** SecretStore ids to store the value under (the placeholder the model is likely to reference). */
  ids: string[];
  value: string;
  field: string;
}

/** First significant label of the host: mycox.ai → mycox, api.foo.com → foo. */
function serviceLabel(host: string): string | null {
  const labels = host.split('.').filter(Boolean);
  if (labels.length === 0) return null;
  let i = 0;
  while (i < labels.length - 1 && /^(api|www|app)$/i.test(labels[i])) i++;
  const l = labels[i].toLowerCase().replace(/[^a-z0-9]/g, '');
  return l.length >= 2 ? l : null;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * If this successful http response is an auth/register response carrying a credential, return the
 * value plus the SecretStore ids to store it under; otherwise null. `url` is in host/path form
 * (secured http leaves it unresolved), `rawBody` is the PRE-redaction response text.
 */
export function extractCapturableCredential(
  url: string,
  method: string,
  rawBody: string,
): CapturedCredential | null {
  if (!/^(POST|PUT)$/i.test(method)) return null;
  let host = '';
  let path = '';
  try {
    const u = new URL(url);
    host = u.host;
    path = u.pathname;
  } catch {
    return null;
  }
  if (!AUTH_PATH_RE.test(path)) return null;
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const top = asObject(json);
  if (!top) return null;
  // Look at the top level and common wrappers (data / result / auth).
  const roots = [top, asObject(top.data), asObject(top.result), asObject(top.auth)].filter(
    (r): r is Record<string, unknown> => r !== null,
  );
  const svc = serviceLabel(host);
  if (!svc) return null;
  for (const root of roots) {
    for (const f of CRED_FIELDS) {
      const val = root[f];
      if (typeof val === 'string' && val.length >= 12) {
        const ids = Array.from(new Set([`${svc}-api-key`, `${svc}-${kebab(f)}`, `${svc}-token`]));
        return { ids, value: val, field: f };
      }
    }
  }
  return null;
}
