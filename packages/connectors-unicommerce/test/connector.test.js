import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnicommerceConnector } from '../src/index.js';

function mockUc(overrides = {}) {
  return {
    ping: async () => ({ alive: true, currentFacility: 'Opp_RSG_MH' }),
    listFacilities: async () => ({ all: ['Opp_RSG_MH', 'Opp_WIQ_MH_1'], current: 'Opp_RSG_MH' }),
    data: async (path, body) => {
      if (path.includes('fetchSummary')) {
        return {
          saleOrderSummary: {
            code: body.code,
            status: 'CREATED',
            channel: 'CUSTOM',
            displayOrderCode: body.code,
            totalPrice: 100,
            saleOrderItemCount: 1,
            customFieldValues: [],
          },
        };
      }
      if (path.includes('/fetch') && !path.includes('fetchSummary') && !path.includes('fetchShipping')) {
        return {
          successful: true,
          saleOrderDTO: {
            code: body.code,
            saleOrderItems: [{ facilityCode: 'Opp_RSG_MH' }],
          },
        };
      }
      if (path.includes('fetchShippingPackageDetails')) {
        return {
          shippingPackages: [{ code: 'PK1', invoiceCode: 'INV/1', statusCode: 'READY_TO_SHIP' }],
        };
      }
      return {};
    },
    public: async (path, body) => {
      if (path.includes('inventorySnapshot/get')) {
        return {
          inventorySnapshots: (body.itemTypeSKUs || []).map((s) => ({ itemTypeSKU: s, inventory: 7 })),
        };
      }
      return {};
    },
    ...overrides,
  };
}

test('listCapabilities exposes Phase-1 read actions with mutates:false', () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const caps = c.listCapabilities();
  const ids = caps.map((x) => x.id).sort();
  assert.deepEqual(ids, [
    'facilities.list',
    'health.ping',
    'inventory.snapshot',
    'saleOrder.get',
    'saleOrder.getShippingPackages',
    'saleOrder.getSummary',
  ]);
  assert.ok(caps.every((x) => x.mutates === false));
  assert.ok(caps.every((x) => x.backend === 're'));
});

test('health.ping and health() never leak cookie fields', async () => {
  const uc = mockUc({
    ping: async () => ({
      alive: true,
      currentFacility: 'F1',
      jsessionid: 'SECRET',
      cookie: 'SECRET',
    }),
  });
  const c = createUnicommerceConnector({ uc });
  const ping = await c.invoke('health.ping', {});
  const health = await c.health();
  assert.equal(ping.alive, true);
  assert.equal(health.ok, true);
  assert.equal(ping.jsessionid, undefined);
  assert.equal(ping.cookie, undefined);
  assert.equal(health.session?.jsessionid, undefined);
  assert.equal(JSON.stringify(ping).includes('SECRET'), false);
  assert.equal(JSON.stringify(health).includes('SECRET'), false);
});

test('saleOrder.getSummary returns structured summary', async () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const r = await c.invoke('saleOrder.getSummary', { saleOrder: 'SO02780' });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.summary.so, 'SO02780');
  assert.equal(r.summary.status, 'CREATED');
});

test('saleOrder.get resolves facility via hop', async () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const r = await c.invoke('saleOrder.get', { saleOrder: 'SO1' });
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.order.facility, 'Opp_RSG_MH');
});

test('saleOrder.getShippingPackages uses facility-scoped data call', async () => {
  const calls = [];
  const uc = mockUc({
    data: async (path, body, opts) => {
      calls.push({ path, body, opts });
      if (path.includes('fetchSummary')) {
        return { saleOrderSummary: { code: body.code, status: 'CREATED', channel: 'X', customFieldValues: [] } };
      }
      if (path.includes('/fetch') && !path.includes('Shipping')) {
        return { saleOrderDTO: { code: body.code, saleOrderItems: [{ facilityCode: 'Opp_RSG_MH' }] } };
      }
      if (path.includes('fetchShippingPackageDetails')) {
        return { shippingPackages: [{ code: 'PK9' }] };
      }
      return {};
    },
  });
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.getShippingPackages', { saleOrder: 'SO9' });
  assert.equal(r.ok, true);
  assert.equal(r.facility, 'Opp_RSG_MH');
  assert.equal(r.shippingPackages[0].code, 'PK9');
  assert.ok(calls.some((x) => x.path.includes('fetchShippingPackageDetails') && x.opts?.facility === 'Opp_RSG_MH'));
});

test('inventory.snapshot wraps public inventorySnapshot/get', async () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const r = await c.invoke('inventory.snapshot', { skus: ['SKU-A', 'SKU-B'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.inventory, { 'SKU-A': 7, 'SKU-B': 7 });
});

test('facilities.list returns live list shape', async () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const r = await c.invoke('facilities.list', {});
  assert.deepEqual(r.facilities, ['Opp_RSG_MH', 'Opp_WIQ_MH_1']);
  assert.equal(r.current, 'Opp_RSG_MH');
});

test('invoke unknown action returns ok:false (no throw)', async () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const r = await c.invoke('does.not.exist', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown action/);
});
