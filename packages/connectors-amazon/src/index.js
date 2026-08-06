import { createRegistry, createConnectorShell, connectorError, CONNECTOR_ERROR_CODES } from '@opptra/connectors-sdk';
import {
  AMAZON_MARKETPLACES, SP_API_ENDPOINT, normalizeMarketplace, makeAccessTokenSource,
} from './lwa.js';

export const CONNECTOR_ID = 'amazon';
export const CONNECTOR_NAME = 'Amazon Seller Central';
export { AMAZON_MARKETPLACES, normalizeMarketplace, buildConsentUrl, exchangeAuthCode } from './lwa.js';

const MARKETPLACE_PARAM = {
  type: 'string',
  enum: Object.keys(AMAZON_MARKETPLACES),
  description: 'in (India, default) | ae (UAE) | sa (KSA)',
};

/**
 * Amazon connector, official SP-API, authorized once per marketplace.
 *
 * Refresh-token resolution per marketplace, in order:
 *   1. the connector vault (one-time OAuth connect flow, /auth/amazon/connect)
 *   2. AMAZON_SP_REFRESH_TOKEN env (legacy single-marketplace escape hatch, 'in' only)
 *
 * @param {{
 *   cfg?: object,                                       // config() slice (AMAZON_SP_*)
 *   getRefreshToken?: (marketplace: string) => Promise<string>, // vault lookup
 *   httpFetch?: typeof fetch,
 * }} opts
 */
export function createAmazonConnector({ cfg = {}, getRefreshToken, httpFetch = fetch } = {}) {
  const registry = createRegistry();
  const hasLwaApp = !!(cfg.AMAZON_SP_CLIENT_ID && cfg.AMAZON_SP_CLIENT_SECRET);

  const accessTokenFor = makeAccessTokenSource({
    clientId: cfg.AMAZON_SP_CLIENT_ID,
    clientSecret: cfg.AMAZON_SP_CLIENT_SECRET,
    httpFetch,
  });

  async function refreshTokenFor(marketplace) {
    if (getRefreshToken) {
      const fromVault = await getRefreshToken(marketplace);
      if (fromVault) return fromVault;
    }
    if (marketplace === 'in' && cfg.AMAZON_SP_REFRESH_TOKEN) return cfg.AMAZON_SP_REFRESH_TOKEN;
    return '';
  }

  /** Resolve auth or explain exactly what is missing, never a vague failure. */
  async function requireAuth(marketplace) {
    if (!hasLwaApp) {
      return { error: connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        'Amazon SP-API app not configured on the server (AMAZON_SP_CLIENT_ID / AMAZON_SP_CLIENT_SECRET).') };
    }
    const refreshToken = await refreshTokenFor(marketplace);
    if (!refreshToken) {
      return { error: connectorError(CONNECTOR_ERROR_CODES.AUTH_REQUIRED,
        `Amazon ${AMAZON_MARKETPLACES[marketplace].label} is not connected yet, use Connect on the Connectors page (one-time Seller Central authorization).`,
        { marketplace, connectUrl: `/auth/amazon/connect?marketplace=${marketplace}` }) };
    }
    return { refreshToken };
  }

  async function spGet(marketplace, path, query = {}) {
    const auth = await requireAuth(marketplace);
    if (auth.error) return auth.error;
    let token;
    try {
      token = await accessTokenFor(auth.refreshToken);
    } catch (err) {
      return connectorError(CONNECTOR_ERROR_CODES.AUTH_EXPIRED,
        `Amazon token refresh failed for ${marketplace}: ${err.message}. Re-connect the marketplace.`,
        { marketplace });
    }
    const qs = new URLSearchParams(query).toString();
    const url = `${(cfg.AMAZON_SP_ENDPOINT || SP_API_ENDPOINT).replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
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
    if (res.status === 429) {
      return connectorError(CONNECTOR_ERROR_CODES.RATE_LIMITED, 'Amazon SP-API throttled the call', { marketplace });
    }
    if (!res.ok) {
      return connectorError(CONNECTOR_ERROR_CODES.UPSTREAM_ERROR,
        `Amazon SP-API ${res.status} on ${path}`,
        { marketplace, status: res.status, detail: body?.errors || body });
    }
    return { ok: true, marketplace, marketplaceId: AMAZON_MARKETPLACES[marketplace].marketplaceId, data: body };
  }

  registry.register({
    id: 'health.ping',
    title: 'Amazon health',
    mutates: false,
    backend: 'official',
    description: 'SP-API Sellers getMarketplaceParticipations for one marketplace (in | ae | sa)',
    inputSchema: { type: 'object', additionalProperties: false, properties: { marketplace: MARKETPLACE_PARAM } },
    handler: async (params) => spGet(normalizeMarketplace(params.marketplace), '/sellers/v1/marketplaceParticipations'),
  });

  registry.register({
    id: 'orders.search',
    title: 'Search orders',
    mutates: false,
    backend: 'official',
    description: 'SP-API GET /orders/v0/orders for one marketplace (in | ae | sa)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        marketplace: MARKETPLACE_PARAM,
        createdAfter: { type: 'string', description: 'ISO8601 (default: last 7 days)' },
        orderStatuses: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    handler: async (params) => {
      const marketplace = normalizeMarketplace(params.marketplace);
      const createdAfter = params.createdAfter || new Date(Date.now() - 7 * 864e5).toISOString();
      return spGet(marketplace, '/orders/v0/orders', {
        MarketplaceIds: AMAZON_MARKETPLACES[marketplace].marketplaceId,
        CreatedAfter: createdAfter,
        MaxResultsPerPage: String(Math.min(params.maxResults || 20, 100)),
        ...(params.orderStatuses?.length ? { OrderStatuses: params.orderStatuses.join(',') } : {}),
      });
    },
  });

  registry.register({
    id: 'inventory.get',
    title: 'FBA inventory summary',
    mutates: false,
    backend: 'official',
    description: 'SP-API fbaInventory summaries for one marketplace (in | ae | sa)',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { marketplace: MARKETPLACE_PARAM },
    },
    handler: async (params) => {
      const marketplace = normalizeMarketplace(params.marketplace);
      const { marketplaceId } = AMAZON_MARKETPLACES[marketplace];
      return spGet(marketplace, '/fba/inventory/v1/summaries', {
        details: 'true',
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
      });
    },
  });

  return createConnectorShell({
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    auth: { kind: 'oauth2', primary: 'oauth2', officialFutureSwap: false },
    registry,
    health: async () => {
      const detail = {};
      for (const marketplace of Object.keys(AMAZON_MARKETPLACES)) {
        const auth = await requireAuth(marketplace);
        detail[marketplace] = auth.error ? { connected: false, code: auth.error.code } : { connected: true };
      }
      const anyConnected = Object.values(detail).some((d) => d.connected);
      return { ok: anyConnected, connector: CONNECTOR_ID, marketplaces: detail };
    },
  });
}

export default { createAmazonConnector, CONNECTOR_ID, CONNECTOR_NAME };
