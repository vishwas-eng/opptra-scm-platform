import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMAZON_MARKETPLACES, normalizeMarketplace, buildConsentUrl, exchangeAuthCode, makeAccessTokenSource,
} from '../src/lwa.js';
import { createAmazonConnector } from '../src/index.js';

function jsonResponse(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

/* ------------------------------- LWA plumbing ------------------------------- */

test('marketplace ids and hosts are the three Opptra sells on', () => {
  assert.equal(AMAZON_MARKETPLACES.in.marketplaceId, 'A21TJRUUN4KGV');
  assert.equal(AMAZON_MARKETPLACES.ae.marketplaceId, 'A2VIGQ35RCS4UG');
  assert.equal(AMAZON_MARKETPLACES.sa.marketplaceId, 'A17E79C6D8DWNP');
  assert.equal(normalizeMarketplace('IN'), 'in');
  assert.equal(normalizeMarketplace(undefined), 'in', 'India is the default');
  assert.throws(() => normalizeMarketplace('us'), /unknown Amazon marketplace/);
});

test('consent URL targets the right Seller Central per marketplace', () => {
  const url = buildConsentUrl({ marketplace: 'ae', applicationId: 'amzn1.sp.solution.x', state: 's1' });
  assert.ok(url.startsWith('https://sellercentral.amazon.ae/apps/authorize/consent?'));
  const qs = new URL(url).searchParams;
  assert.equal(qs.get('application_id'), 'amzn1.sp.solution.x');
  assert.equal(qs.get('state'), 's1');
  assert.equal(qs.get('version'), 'beta');
  const published = buildConsentUrl({ marketplace: 'in', applicationId: 'a', state: 's', beta: false });
  assert.ok(!published.includes('version=beta'));
  assert.throws(() => buildConsentUrl({ marketplace: 'in', state: 's' }), /applicationId/);
});

test('exchangeAuthCode posts the authorization_code grant and returns the refresh token', async () => {
  let seen;
  const httpFetch = async (url, init) => {
    seen = { url, params: Object.fromEntries(new URLSearchParams(init.body)) };
    return jsonResponse(200, { refresh_token: 'Atzr|long-lived', access_token: 'Atza|short' });
  };
  const grant = await exchangeAuthCode({ code: 'ANxyz', clientId: 'cid', clientSecret: 'cs', httpFetch });
  assert.equal(grant.refreshToken, 'Atzr|long-lived');
  assert.equal(seen.url, 'https://api.amazon.com/auth/o2/token');
  assert.equal(seen.params.grant_type, 'authorization_code');
  assert.equal(seen.params.code, 'ANxyz');
});

test('access tokens are cached per refresh token and renewed before expiry', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const httpFetch = async () => {
    calls += 1;
    return jsonResponse(200, { access_token: `tok-${calls}`, expires_in: 3600 });
  };
  const source = makeAccessTokenSource({ clientId: 'c', clientSecret: 's', httpFetch, now: () => clock });

  assert.equal(await source('rt-A'), 'tok-1');
  assert.equal(await source('rt-A'), 'tok-1', 'second call inside TTL must hit the cache');
  assert.equal(calls, 1);

  assert.equal(await source('rt-B'), 'tok-2', 'a different grant never shares a token');

  clock += 3400 * 1000; // past the renew-5-min-early threshold
  assert.equal(await source('rt-A'), 'tok-3', 'expired entry re-mints');
  await assert.rejects(() => source(''), /no Amazon refresh token/);
});

/* ------------------------------- connector ------------------------------- */

const CFG = { AMAZON_SP_CLIENT_ID: 'cid', AMAZON_SP_CLIENT_SECRET: 'cs' };

function connectorWith({ vault = {}, cfg = CFG, responses }) {
  const httpFetch = async (url, init = {}) => {
    if (url.startsWith('https://api.amazon.com/auth/o2/token')) {
      return jsonResponse(200, { access_token: 'Atza|test', expires_in: 3600 });
    }
    return responses(url, init);
  };
  return createAmazonConnector({
    cfg,
    getRefreshToken: async (marketplace) => vault[marketplace] || '',
    httpFetch,
  });
}

test('an unconnected marketplace gets AUTH_REQUIRED with the connect URL, not a vague error', async () => {
  const c = connectorWith({ vault: {}, responses: () => { throw new Error('must not reach SP-API'); } });
  const r = await c.invoke('orders.search', { marketplace: 'ae' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUTH_REQUIRED');
  assert.equal(r.connectUrl, '/auth/amazon/connect?marketplace=ae');
  assert.equal(r.retryable, false);
});

test('a connected marketplace calls SP-API with its own marketplace id', async () => {
  let captured;
  const c = connectorWith({
    vault: { ae: 'Atzr|ae-token' },
    responses: (url, init) => {
      captured = { url, headers: init.headers };
      return jsonResponse(200, { payload: { Orders: [{ AmazonOrderId: '404-1' }] } });
    },
  });
  const r = await c.invoke('orders.search', { marketplace: 'ae', maxResults: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.marketplaceId, 'A2VIGQ35RCS4UG');
  assert.ok(captured.url.includes('MarketplaceIds=A2VIGQ35RCS4UG'));
  assert.equal(captured.headers['x-amz-access-token'], 'Atza|test');
});

test('env refresh token still works for India only (legacy escape hatch)', async () => {
  const cfg = { ...CFG, AMAZON_SP_REFRESH_TOKEN: 'Atzr|env-in' };
  const c = connectorWith({ vault: {}, cfg, responses: () => jsonResponse(200, { payload: {} }) });
  assert.equal((await c.invoke('health.ping', { marketplace: 'in' })).ok, true);
  assert.equal((await c.invoke('health.ping', { marketplace: 'sa' })).code, 'AUTH_REQUIRED');
});

test('SP-API throttling and failures map to the standard error taxonomy', async () => {
  let status = 429;
  const c = connectorWith({ vault: { in: 'rt' }, responses: () => jsonResponse(status, { errors: [{ code: 'x' }] }) });
  const throttled = await c.invoke('health.ping', {});
  assert.equal(throttled.code, 'RATE_LIMITED');
  assert.equal(throttled.retryable, true);
  status = 500;
  const upstream = await c.invoke('health.ping', {});
  assert.equal(upstream.code, 'UPSTREAM_ERROR');
});

test('schema enforcement blocks junk before any HTTP happens', async () => {
  const c = connectorWith({ vault: { in: 'rt' }, responses: () => { throw new Error('must not be reached'); } });
  const bad = await c.invoke('orders.search', { marketplace: 'in', maxResults: 5000 });
  assert.equal(bad.code, 'INVALID_INPUT');
  const badField = await c.invoke('orders.search', { shipTo: 'x' });
  assert.equal(badField.code, 'INVALID_INPUT');
});

test('health reports the connect state of every marketplace without touching SP-API', async () => {
  const c = connectorWith({ vault: { in: 'rt-in' }, responses: () => { throw new Error('health must not call SP-API'); } });
  const h = await c.health();
  assert.equal(h.ok, true);
  assert.equal(h.marketplaces.in.connected, true);
  assert.equal(h.marketplaces.ae.connected, false);
  assert.equal(h.marketplaces.sa.connected, false);
});
