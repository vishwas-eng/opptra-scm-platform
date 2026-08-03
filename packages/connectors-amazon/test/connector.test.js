import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAmazonConnector } from '../src/index.js';

test('amazon connector lists capabilities and awaits HAR without SP-API env', async () => {
  const c = createAmazonConnector({ cfg: {} });
  assert.equal(c.id, 'amazon');
  const caps = c.listCapabilities();
  assert.ok(caps.some((x) => x.id === 'health.ping'));
  const health = await c.health();
  assert.equal(health.ok, false);
  const r = await c.invoke('orders.search', {});
  assert.equal(r.awaitingHar, true);
});

test('amazon SP-API health calls sellers endpoint when env present', async () => {
  const calls = [];
  const httpFetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('/auth/o2/token')) {
      return { ok: true, async json() { return { access_token: 't' }; }, async text() { return ''; } };
    }
    return {
      ok: true,
      async text() { return JSON.stringify({ payload: [] }); },
    };
  };
  const c = createAmazonConnector({
    cfg: {
      AMAZON_SP_CLIENT_ID: 'id',
      AMAZON_SP_CLIENT_SECRET: 'sec',
      AMAZON_SP_REFRESH_TOKEN: 'ref',
      AMAZON_SP_MARKETPLACE_ID: 'A21TJRUUN4KGV',
    },
    httpFetch,
  });
  const r = await c.invoke('health.ping', {});
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'official');
  assert.ok(calls.some((c) => String(c.url).includes('marketplaceParticipations')));
});
