import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'flipkart';
export const CONNECTOR_NAME = 'Flipkart Seller Hub';

/**
 * Flipkart, dual:
 *  - official Seller API (FLIPKART_APP_ID/SECRET + access token or vault)
 *  - RE session cookie paste until HAR maps Seller Hub XHR
 */
export function createFlipkartConnector({ cfg = {}, getSecret, httpFetch = fetch } = {}) {
  const registry = createRegistry();
  const hasOfficial = !!(cfg.FLIPKART_ACCESS_TOKEN || (cfg.FLIPKART_APP_ID && cfg.FLIPKART_APP_SECRET));

  async function accessToken() {
    if (cfg.FLIPKART_ACCESS_TOKEN) return cfg.FLIPKART_ACCESS_TOKEN;
    const sec = getSecret ? await getSecret() : null;
    if (sec?.secret && sec.auth_kind === 'bearer') return sec.secret;
    if (cfg.FLIPKART_APP_ID && cfg.FLIPKART_APP_SECRET) {
      const basic = Buffer.from(`${cfg.FLIPKART_APP_ID}:${cfg.FLIPKART_APP_SECRET}`).toString('base64');
      const res = await httpFetch('https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api', {
        method: 'GET',
        headers: { Authorization: `Basic ${basic}` },
      });
      if (!res.ok) throw new Error(`Flipkart token failed (${res.status})`);
      const data = await res.json();
      return data.access_token;
    }
    return null;
  }

  async function apiGet(path) {
    const token = await accessToken();
    if (!token) return { ok: false, error: 'No Flipkart access token' };
    const base = (cfg.FLIPKART_API_BASE || 'https://api.flipkart.net/sellers').replace(/\/+$/, '');
    const res = await httpFetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok) return { ok: false, status: res.status, error: body || text.slice(0, 200) };
    return { ok: true, data: body };
  }

  registry.register({
    id: 'health.ping',
    title: 'Flipkart health',
    mutates: false,
    backend: hasOfficial ? 'official' : 're',
    awaitingHar: !hasOfficial,
    description: hasOfficial ? 'Seller API token probe' : 'Session vault / HAR required',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      if (hasOfficial) {
        try {
          const token = await accessToken();
          return { ok: !!token, backend: 'official', hasToken: !!token };
        } catch (err) {
          return { ok: false, error: String(err.message || err) };
        }
      }
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) {
        return { ok: false, awaitingHar: true, error: 'Connect Flipkart: paste Seller Hub session or set FLIPKART_* API creds.' };
      }
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored; map Seller Hub XHR via HAR (docs/connectors/flipkart.md).' };
    },
  });

  registry.register({
    id: 'orders.search',
    title: 'Search shipments/orders',
    mutates: false,
    backend: hasOfficial ? 'official' : 're',
    awaitingHar: !hasOfficial,
    description: 'GET /v3/shipments/filter when official API connected',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        state: { type: 'string', default: 'APPROVED' },
      },
    },
    handler: async (params) => {
      if (!hasOfficial) return { ok: false, awaitingHar: true, error: 'Needs Flipkart API token or HAR.' };
      // Filter endpoint shape per Flipkart Seller API v3 docs
      const token = await accessToken();
      const base = (cfg.FLIPKART_API_BASE || 'https://api.flipkart.net/sellers').replace(/\/+$/, '');
      const res = await httpFetch(`${base}/v3/shipments/filter`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ filter: { states: [params.state || 'APPROVED'] }, pagination: { pageSize: 20 } }),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
      if (!res.ok) return { ok: false, status: res.status, error: body || text.slice(0, 200) };
      return { ok: true, data: body };
    },
  });

  registry.register({
    id: 'inventory.get',
    title: 'Listing inventory (stub until scoped)',
    mutates: false,
    backend: hasOfficial ? 'official' : 're',
    awaitingHar: true,
    description: 'POST /listings/v3/…, needs location ids from onboarding; paste HAR or provide location map',
    inputSchema: { type: 'object', additionalProperties: false, properties: { skus: { type: 'array', items: { type: 'string' } } } },
    handler: async () => ({ ok: false, awaitingHar: true, error: 'Flipkart inventory needs location IDs + HAR or Seller API onboarding.' }),
  });

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: { kind: 'dual', primary: hasOfficial ? 'oauth2' : 'session', officialFutureSwap: !hasOfficial },
    registry,
    health: async () => {
      const r = await registry.getAction('health.ping').handler({}, {});
      return { ok: !!r.ok, connector: CONNECTOR_ID, detail: r };
    },
  });
}

export default { createFlipkartConnector, CONNECTOR_ID, CONNECTOR_NAME };
