import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUB_CHANNELS, createChannelStub, createAllChannelStubs } from '../src/index.js';

test('every declared channel builds a connector with the standard stub surface', () => {
  const all = createAllChannelStubs();
  assert.equal(all.size, STUB_CHANNELS.length);
  for (const def of STUB_CHANNELS) {
    const c = all.get(def.id);
    assert.equal(c.id, def.id);
    const caps = c.listCapabilities();
    const ids = caps.map((a) => a.id);
    assert.ok(ids.includes('health.ping'), `${def.id} missing health.ping`);
    assert.ok(ids.includes('orders.search'), `${def.id} missing orders.search`);
    assert.ok(caps.every((a) => a.awaitingHar), `${def.id} stub actions must all be awaitingHar`);
  }
});

test('the channels the buildout promised are all present', () => {
  const ids = STUB_CHANNELS.map((c) => c.id);
  for (const want of ['nykaa', 'zepto', 'blinkit', 'instamart', 'meesho', 'ajio', 'noon', 'namshi']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
});

test('invoking any stub action returns AWAITING_HAR — never a fake success', async () => {
  const c = createChannelStub('noon');
  const r = await c.invoke('orders.search', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AWAITING_HAR');
  assert.equal(r.awaitingHar, true);
});

test('health reflects vault state without leaking the secret', async () => {
  const noSession = createChannelStub('ajio');
  const h1 = await noSession.health();
  assert.equal(h1.ok, false);
  assert.match(h1.detail.error, /Connect Ajio Seller/);

  const withSession = createChannelStub('ajio', { getSecret: async () => ({ secret: 'cookie-value' }) });
  const h2 = await withSession.health();
  assert.equal(h2.detail.hasSession, true);
  assert.ok(!JSON.stringify(h2).includes('cookie-value'), 'health must never echo the stored secret');
});

test('unknown channel id fails loudly', () => {
  assert.throws(() => createChannelStub('walmart'), /unknown stub channel/);
});
