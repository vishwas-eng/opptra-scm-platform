import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAmazonConnector } from '../src/index.js';

test('amazon connector without any auth reports AUTH_REQUIRED, never awaitingHar', async () => {
  // The connector is official-API only now: there is no cookie/HAR path to fall back
  // to, so an unconfigured server must say exactly that.
  const c = createAmazonConnector({ cfg: {} });
  assert.equal(c.id, 'amazon');
  const caps = c.listCapabilities();
  assert.ok(caps.some((x) => x.id === 'health.ping'));
  assert.ok(caps.every((x) => !x.awaitingHar));
  const health = await c.health();
  assert.equal(health.ok, false);
  const r = await c.invoke('orders.search', {});
  assert.equal(r.code, 'AUTH_REQUIRED');
  assert.match(r.error, /AMAZON_SP_CLIENT_ID/);
});

test('amazon SP-API health calls sellers endpoint with legacy env refresh token', async () => {
  const calls = [];
  const httpFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('/auth/o2/token')) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: 't', expires_in: 3600 }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ payload: [] }); } };
  };
  const c = createAmazonConnector({
    cfg: {
      AMAZON_SP_CLIENT_ID: 'id',
      AMAZON_SP_CLIENT_SECRET: 'sec',
      AMAZON_SP_REFRESH_TOKEN: 'ref',
    },
    httpFetch,
  });
  const r = await c.invoke('health.ping', {});
  assert.equal(r.ok, true);
  assert.equal(r.marketplaceId, 'A21TJRUUN4KGV');
  assert.ok(calls.some((c) => String(c.url).includes('marketplaceParticipations')));
});
