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

test('listCapabilities covers the full read surface with mutates:false', () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const reads = c.listCapabilities().filter((x) => !x.mutates).map((x) => x.id).sort();
  assert.deepEqual(reads, [
    'channels.list',
    'facilities.list',
    'health.ping',
    'inventory.batchwise',
    'inventory.snapshot',
    'reports.exportConfigGet',
    'reports.exportJobsList',
    'reports.exportTypes',
    'returns.bulkReturnSummary',
    'saleOrder.get',
    'saleOrder.getInvoiceDetails',
    'saleOrder.getLineItems',
    'saleOrder.getShippingPackages',
    'saleOrder.getSummary',
    'shipments.search',
  ]);
});

test('the write surface covers the whole order lifecycle, every action flagged mutates', () => {
  const c = createUnicommerceConnector({ uc: mockUc() });
  const mutating = c.listCapabilities().filter((x) => x.mutates).map((x) => x.id).sort();
  assert.deepEqual(mutating, [
    'inventory.adjust',
    'manifest.addPackages',
    'manifest.close',
    'manifest.create',
    'putaway.complete',
    'reports.exportJobCreate',
    'returns.bulkReturnCreate',
    'saleOrder.allocateB2B',
    'saleOrder.allocateB2C',
    'saleOrder.cancel',
    'shipment.allocateProvider',
    'shipment.dispatch',
    'shipment.markDelivered',
    'shippingPackage.createInvoice',
  ]);
});

test('every action declares an RE backend and a real input schema', () => {
  const caps = createUnicommerceConnector({ uc: mockUc() }).listCapabilities();
  assert.ok(caps.every((x) => x.backend === 're'));
  // A schema of bare {} would mean the ajv gate accepts anything — the exact hole that
  // let a 50k-SKU array through before validation was wired in.
  for (const cap of caps) {
    assert.equal(cap.inputSchema.type, 'object', `${cap.id} has no object schema`);
    assert.equal(cap.inputSchema.additionalProperties, false, `${cap.id} allows unknown params`);
  }
});

test('new read actions: invoice details + batchwise + export jobs list against mocks', async () => {
  const uc = mockUc({
    dataGet: async (path) => {
      if (path.includes('batchwise')) {
        return { batchwiseInventories: [{ shelfCode: 'DEFAULT', batchCode: 'B1', availableQuantity: 4 }] };
      }
      if (path.includes('exportJobs')) {
        return { exportJobs: [{ id: 11, statusCode: 'COMPLETED', successful: true, exportFilePath: '/x.csv', exportCount: 9 }] };
      }
      return {};
    },
  });
  uc.data = async (path, body) => {
    if (path.includes('fetchInvoiceDetails')) {
      return { invoices: [{ code: 'SBHR1234', saleOrderCode: body.saleOrderCode }] };
    }
    if (path.includes('/fetch') && !path.includes('fetchSummary') && !path.includes('fetchShipping')) {
      return { successful: true, saleOrderDTO: { code: body.code, saleOrderItems: [{ facilityCode: 'Opp_RSG_MH' }] } };
    }
    if (path.includes('fetchSummary')) {
      return { saleOrderSummary: { code: body.code, status: 'CREATED', customFieldValues: [] } };
    }
    return {};
  };
  const c = createUnicommerceConnector({ uc });

  const inv = await c.invoke('saleOrder.getInvoiceDetails', { saleOrder: 'SO1', facility: 'Opp_RSG_MH' });
  assert.equal(inv.ok, true);
  assert.equal(inv.invoices[0].code, 'SBHR1234');

  const batches = await c.invoke('inventory.batchwise', { sku: 'SKU-1' });
  assert.equal(batches.ok, true);
  assert.equal(batches.batches[0].shelfCode, 'DEFAULT');

  const jobs = await c.invoke('reports.exportJobsList', { exportJobId: 11 });
  assert.equal(jobs.ok, true);
  assert.equal(jobs.jobs[0].done, true);
  assert.equal(jobs.jobs[0].failed, false);
});

test('reports.exportJobCreate is dry-runnable and sends the exportColums typo for real', async () => {
  let sentBody = null;
  const uc = mockUc({
    dataGet: async () => ({
      exportColumns: [{ id: 'colA' }, { id: 'colB', exportable: false }],
      exportFilters: [{ id: 'createdIn', type: 'DATE' }],
    }),
  });
  uc.data = async (path, body) => {
    if (path.includes('job/create')) { sentBody = body; return { successful: true, exportJobId: 42 }; }
    return {};
  };
  const c = createUnicommerceConnector({ uc });

  const preview = await c.invoke('reports.exportJobCreate', { name: 'DATATABLE SEARCH INVENTORY' }, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(sentBody, null, 'dryRun must not hit UC');

  const real = await c.invoke('reports.exportJobCreate', { name: 'DATATABLE SEARCH INVENTORY' });
  assert.equal(real.ok, true);
  assert.equal(real.exportJobId, 42);
  assert.deepEqual(sentBody.exportColums, ['colA'], 'exportColums (sic) with only exportable columns');
  assert.equal(sentBody.frequency, 'ONETIME');
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
