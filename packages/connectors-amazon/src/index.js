import { createRegistry, createConnectorShell } from '@opptra/connectors-sdk';

export const CONNECTOR_ID = 'amazon';
export const CONNECTOR_NAME = 'Amazon Seller Central';

const MARKETPLACE_IN = 'A21TJRUUN4KGV';

/**
 * Amazon connector — dual auth:
 *  - official: SP-API LWA (AMAZON_SP_* env) when configured
 *  - RE/session: cookie paste into connector_credentials vault (needs HAR for XHR)
 */
export function createAmazonConnector({ cfg = {}, getSecret, httpFetch = fetch } = {}) {
  const registry = createRegistry();

  const hasSpApi = !!(cfg.AMAZON_SP_CLIENT_ID && cfg.AMAZON_SP_CLIENT_SECRET && cfg.AMAZON_SP_REFRESH_TOKEN);

  async function lwaAccessToken() {
    const res = await httpFetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.AMAZON_SP_REFRESH_TOKEN,
        client_id: cfg.AMAZON_SP_CLIENT_ID,
        client_secret: cfg.AMAZON_SP_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`Amazon LWA token failed (${res.status})`);
    const data = await res.json();
    return data.access_token;
  }

  async function spGet(path, query = {}) {
    const token = await lwaAccessToken();
    const base = (cfg.AMAZON_SP_ENDPOINT || 'https://sellingpartnerapi-eu.amazon.com').replace(/\/+$/, '');
    const qs = new URLSearchParams(query).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ''}`;
    const res = await httpFetch(url, {
      headers: {
        'x-amz-access-token': token,
        'user-agent': 'OpptraSCM/0.1 (Language=JavaScript)',
        accept: 'application/json',
      },
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    if (!res.ok) return { ok: false, status: res.status, error: body?.errors || body || text.slice(0, 200) };
    return { ok: true, data: body };
  }

  registry.register({
    id: 'health.ping',
    title: 'Amazon health',
    mutates: false,
    backend: hasSpApi ? 'official' : 're',
    description: hasSpApi ? 'SP-API Sellers API getMarketplaceParticipations' : 'Session vault probe (needs cookie + HAR)',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    awaitingHar: !hasSpApi,
    handler: async () => {
      if (hasSpApi) {
        const r = await spGet('/sellers/v1/marketplaceParticipations');
        return { ...r, backend: 'official', marketplaceId: cfg.AMAZON_SP_MARKETPLACE_ID || MARKETPLACE_IN };
      }
      const sec = getSecret ? await getSecret() : null;
      if (!sec?.secret) return { ok: false, awaitingHar: true, error: 'Connect Amazon: paste Seller Central session cookie, or set AMAZON_SP_* env for SP-API.' };
      return { ok: false, awaitingHar: true, hasSession: true, error: 'Session stored but Seller Central XHR paths need a sanitized HAR (orders/inventory). See docs/connectors/amazon.md' };
    },
  });

  registry.register({
    id: 'orders.search',
    title: 'Search orders',
    mutates: false,
    backend: hasSpApi ? 'official' : 're',
    awaitingHar: !hasSpApi,
    description: hasSpApi ? 'SP-API GET /orders/v0/orders (India marketplace)' : 'RE: Seller Central orders XHR (HAR required)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        createdAfter: { type: 'string', description: 'ISO8601' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    handler: async (params) => {
      if (!hasSpApi) {
        return { ok: false, awaitingHar: true, error: 'Amazon orders.search needs SP-API creds or Seller Central HAR.' };
      }
      const createdAfter = params.createdAfter || new Date(Date.now() - 7 * 864e5).toISOString();
      return spGet('/orders/v0/orders', {
        MarketplaceIds: cfg.AMAZON_SP_MARKETPLACE_ID || MARKETPLACE_IN,
        CreatedAfter: createdAfter,
        MaxResultsPerPage: String(Math.min(params.maxResults || 20, 100)),
      });
    },
  });

  registry.register({
    id: 'inventory.get',
    title: 'FBA inventory summary',
    mutates: false,
    backend: hasSpApi ? 'official' : 're',
    awaitingHar: !hasSpApi,
    description: 'SP-API fbaInventory when official; else HAR',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      if (!hasSpApi) return { ok: false, awaitingHar: true, error: 'Needs SP-API or inventory HAR.' };
      return spGet('/fba/inventory/v1/summaries', {
        details: 'true',
        granularityType: 'Marketplace',
        granularityId: cfg.AMAZON_SP_MARKETPLACE_ID || MARKETPLACE_IN,
        marketplaceIds: cfg.AMAZON_SP_MARKETPLACE_ID || MARKETPLACE_IN,
      });
    },
  });

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: { kind: 'dual', primary: hasSpApi ? 'oauth2' : 'session', officialFutureSwap: !hasSpApi },
    registry,
    health: async () => {
      const r = await registry.getAction('health.ping').handler({}, {});
      return { ok: !!r.ok, connector: CONNECTOR_ID, detail: r };
    },
  });
}

export default { createAmazonConnector, CONNECTOR_ID, CONNECTOR_NAME };
