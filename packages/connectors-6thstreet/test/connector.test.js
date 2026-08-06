import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSixthStreetConnector } from '../src/index.js';

test('6thstreet lists primary + secondary capabilities', async () => {
  const c = createSixthStreetConnector({ cfg: {} });
  assert.equal(c.id, '6thstreet');
  const ids = c.listCapabilities().map((x) => x.id);
  for (const need of ['health.ping', 'picklist.download', 'invoice.download', 'label.download', 'pack.email', 'inventory.push']) {
    assert.ok(ids.includes(need), need);
  }
  const health = await c.health();
  assert.equal(health.ok, false);
});

test('health reports env presence without secrets', async () => {
  const c = createSixthStreetConnector({
    cfg: {
      STREET6_VPN_USER: 'OMS999',
      STREET6_VPN_PASS: 'secret-should-not-leak',
      STREET6_VPN_HOST: '10.61.1.11',
      STREET6_PORTAL_USER: 'u',
      STREET6_PORTAL_PASS: 'p',
      STREET6_EMAIL_TO: 'daniyal@opptra.com',
    },
  });
  const r = await c.invoke('health.ping', {}, { allowStub: true });
  assert.equal(r.vpnConfigured, true);
  assert.equal(r.portalConfigured, true);
  assert.equal(r.emailTo, 'daniyal@opptra.com');
  const blob = JSON.stringify(r);
  assert.equal(blob.includes('secret-should-not-leak'), false);
});

test('downloads await HAR', async () => {
  const c = createSixthStreetConnector({ cfg: {} });
  const r = await c.invoke('picklist.download', { orderId: 'X' });
  assert.equal(r.awaitingHar, true);
});
