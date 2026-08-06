// 6th Street seller-portal client, the half that needs NO VPN.
//
// Two separate 6th Street systems, and conflating them is the trap:
//   · seller portal  (this file), inventory + pricing. Public internet, bearer JWT.
//   · IBM Sterling OMS (VPN-gated), picklist, invoice, shipping label.
//
// Endpoints were read from the portal's own Flutter bundle
// (docs/connectors/6thstreet-API-REVERSE.md), not guessed.
//
// Every call goes through a PortalGuard: this is a reverse-engineered seller session,
// so the account is the thing we are protecting, not the request.
import { createPortalGuard, CONNECTOR_ERROR_CODES, connectorError } from '@opptra/connectors-sdk';

const DEFAULT_BASE = 'https://prod-seller-portal-backend.6thstreet.com/sellerportal/';

/** Access tokens are short-lived; refresh a minute early rather than racing expiry. */
const TOKEN_SKEW_MS = 60_000;

// 6th Street answers a WRONG PASSWORD with HTTP 500 and the reason in the body
// (observed 2026-08-04). Left alone, the guard sees a 5xx, calls it transient, and
// retries, repeatedly submitting bad credentials to a login endpoint, which is the
// fastest way to get a seller account locked. Detect it and relabel it 401 before the
// retry logic ever sees it, so it fails once, loudly, with the real reason.
const CREDENTIAL_FAILURE_RE = /incorrect\s+(username|password)|invalid\s+(credential|username|password|login)|bad\s+credential|authentication\s+failed|unauthori[sz]ed/i;

function looksLikeCredentialFailure(status, body) {
  if (status !== 500 && status !== 400 && status !== 403) return false;
  return CREDENTIAL_FAILURE_RE.test(String(body || ''));
}

/** Parse the portal's `Sku,...` CSV exports. Blank and malformed lines are skipped. */
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const cols = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const skuAt = cols.findIndex((c) => c === 'sku');
  if (skuAt < 0) return [];
  return lines.slice(1).map((line) => {
    const parts = line.split(',');
    const sku = String(parts[skuAt] ?? '').trim();
    return sku ? { sku, price: Number(parts[1]) || 0 } : null;
  }).filter(Boolean);
}

export function makeStreet6PortalClient({
  baseUrl = DEFAULT_BASE,
  username,
  password,
  httpFetch = fetch,
  guard,
  now = Date.now,
} = {}) {
  const base = String(baseUrl || DEFAULT_BASE).replace(/\/?$/, '/');
  const portalGuard = guard || createPortalGuard({ portal: '6thstreet-seller-portal' });

  let accessToken = '';
  let refreshToken = '';
  let expiresAt = 0;

  /** One guarded request. Returns the SDK error shape on refusal, never throws for it. */
  async function call(path, { method = 'GET', body, auth = true, accept = 'json' } = {}) {
    const url = path.startsWith('http') ? path : `${base}${path.replace(/^\//, '')}`;
    const run = await portalGuard.run(async () => {
      const headers = {
        accept: accept === 'json' ? 'application/json' : '*/*',
        // Honest identification, a forged browser UA buys nothing against real bot
        // detection and is the clearest evidence of intent to evade if ever disputed.
        'user-agent': 'OpptraSCM-Connector/1.0 (+ops@opptra.com)',
      };
      if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
      if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';

      const res = await httpFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      // Relabel a credential rejection so the guard treats it as auth (terminal),
      // not as a server fault worth retrying. See CREDENTIAL_FAILURE_RE above.
      const status = looksLikeCredentialFailure(res.status, text) ? 401 : res.status;
      return {
        status,
        headers: Object.fromEntries(res.headers.entries()),
        body: text,
        url,
        finalUrl: res.url || url,
        credentialFailure: status !== res.status,
        res,
      };
    }, { label: path });

    if (run.ok !== true) return run; // guard refused (blocked, throttled, budget)
    const { response } = run;

    if (accept !== 'json') {
      return response.status < 400
        ? { ok: true, status: response.status, text: response.body }
        : connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR, `6th Street portal ${response.status}`, { status: response.status });
    }

    let data = null;
    try { data = response.body ? JSON.parse(response.body) : null; } catch { data = { raw: response.body?.slice(0, 400) }; }

    if (response.credentialFailure) {
      // Wrong password, not an expired session, retrying cannot help, and re-submitting
      // bad credentials is what locks the account.
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        `6th Street portal rejected the credentials: ${data?.message || 'incorrect username or password'}. Confirm STREET6_PORTAL_USER / STREET6_PORTAL_PASS before retrying, repeated attempts can lock the seller account.`,
        { credentialFailure: true, retryable: false });
    }
    if (response.status === 401 || response.status === 403) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED,
        '6th Street portal rejected the session', { status: response.status });
    }
    if (response.status >= 400) {
      return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
        `6th Street portal ${response.status}${data?.message ? `: ${data.message}` : ''}`,
        { status: response.status, detail: data });
    }
    return { ok: true, status: response.status, data };
  }

  async function login() {
    if (!username || !password) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        'Set STREET6_PORTAL_USER / STREET6_PORTAL_PASS (seller portal, this is NOT the OMS login).');
    }
    const r = await call('api/public/login', {
      method: 'POST', auth: false, body: { username, password },
    });
    if (r.ok !== true) return r;

    const d = r.data || {};
    accessToken = d.accessToken || d.access_token || '';
    refreshToken = d.refreshToken || d.refresh_token || '';
    if (!accessToken) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        'Portal login returned no accessToken, the response shape changed.', { keys: Object.keys(d) });
    }
    // The portal does not publish a TTL; assume a conservative 15 min and refresh early.
    expiresAt = now() + (Number(d.expiresIn || d.expires_in || 900) * 1000);
    return { ok: true };
  }

  async function ensureAuth() {
    if (accessToken && now() < expiresAt - TOKEN_SKEW_MS) return { ok: true };
    if (refreshToken) {
      const r = await call('api/public/refreshToken', {
        method: 'POST', auth: false, body: { refreshToken },
      });
      if (r.ok === true && (r.data?.accessToken || r.data?.access_token)) {
        accessToken = r.data.accessToken || r.data.access_token;
        expiresAt = now() + (Number(r.data.expiresIn || 900) * 1000);
        return { ok: true };
      }
      // Refresh failed, fall through to a full login rather than looping on it.
    }
    return login();
  }

  /** Wrap an authenticated call so a mid-flight expiry is retried exactly once. */
  async function authed(fn) {
    const pre = await ensureAuth();
    if (pre.ok !== true) return pre;
    const first = await fn();
    if (first?.code !== CONNECTOR_ERROR_CODES.AUTH_EXPIRED) return first;
    accessToken = '';
    const again = await ensureAuth();
    if (again.ok !== true) return again;
    return fn();
  }

  return {
    guard: portalGuard,

    async health() {
      const r = await authed(() => call('api/public/users/profile'));
      if (r.ok !== true) return r;
      return { ok: true, profile: r.data, portal: base };
    },

    /**
     * The catalogue 6th Street sells in a country, as CSV (`Sku,Price,SpecialPrice`).
     *
     * This is the SKU source for an inventory sync. `api/inventory/live` would be the
     * obvious choice but it never responds: it timed out at 25s, 60s and 90s on every
     * shape tried, with and without paging or a country. price/live answers in about a
     * second and lists the same catalogue, which is all the sync needs.
     */
    async catalogueSkus({ country = 'SA' } = {}) {
      const r = await authed(() => call(
        `api/price/live?country=${encodeURIComponent(country)}`,
        { accept: 'text' },
      ));
      if (r.ok !== true) return r;
      const rows = parseCsv(r.text || '');
      return { ok: true, country, count: rows.length, skus: rows.map((x) => x.sku), rows };
    },

    /** Past inventory imports, newest first. Each carries its own per-row outcome. */
    async inventoryImports({ start = 0, limit = 20 } = {}) {
      return authed(() => call(`api/inventory/imports?start=${start}&limit=${limit}`));
    },

    /** Per-SKU rows of one import: `{ sku, count, pushToOMS, status }`. */
    async importItems(importId, { start = 0, limit = 500 } = {}) {
      return authed(() => call(`api/inventory/import-items/${encodeURIComponent(importId)}?start=${start}&limit=${limit}`));
    },

    /** Recent inventory import jobs, newest first. */
    async inventoryImports({ start = 0, limit = 20 } = {}) {
      return authed(() => call(`api/inventory/imports?start=${start}&limit=${limit}`));
    },

    /**
     * Push stock. The portal takes a CSV upload (`Sku,Count`), not a per-SKU call, * one file is also far gentler on the account than N requests.
     *
     * @param {Array<{sku: string, count: number}>} rows
     */
    async uploadInventory(rows, { filename = 'opptra-inventory.csv' } = {}) {
      const list = (rows || []).filter((r) => r?.sku);
      if (!list.length) {
        return connectorError(CONNECTOR_ERROR_CODES.INVALID_INPUT, 'No inventory rows to upload');
      }
      const csv = ['Sku,Count', ...list.map((r) => `${String(r.sku).replace(/[",\n]/g, '')},${Math.max(0, Math.trunc(Number(r.count) || 0))}`)].join('\n');
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), filename);
      return authed(() => call('api/inventory/upload', { method: 'POST', body: form }));
    },

    async livePrices({ country = '' } = {}) {
      return authed(() => call(`api/price/live${country ? `?country=${encodeURIComponent(country)}` : ''}`));
    },

    buildInventoryCsv(rows) {
      return ['Sku,Count', ...(rows || []).map((r) => `${r.sku},${Math.max(0, Math.trunc(Number(r.count) || 0))}`)].join('\n');
    },
  };
}
