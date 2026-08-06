import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnicommerceConnector } from '../src/index.js';

function spyUc(responses = {}) {
  const calls = [];
  const reply = (path, fallback) => {
    for (const [frag, val] of Object.entries(responses)) {
      if (path.includes(frag)) return typeof val === 'function' ? val() : val;
    }
    return fallback;
  };
  return {
    calls,
    ping: async () => ({ alive: true }),
    listFacilities: async () => ({ all: [], current: null }),
    data: async (path, body, opts) => { calls.push({ layer: 'data', path, body, opts }); return reply(path, { successful: true }); },
    dataGet: async (path, opts) => { calls.push({ layer: 'dataGet', path, opts }); return reply(path, {}); },
    public: async (path, body, opts) => { calls.push({ layer: 'public', path, body, opts }); return reply(path, {}); },
  };
}

/* ---------------- dry-run: the safety net for every mutate ---------------- */

// Minimal VALID params per mutating action. Params are validated before the dry-run
// branch — deliberately: previewing garbage should tell you it is garbage, not render a
// confident preview of a call that could never succeed. So the dry-run sweep has to use
// real params, which also keeps this fixture honest as the write surface grows.
const VALID_MUTATE_PARAMS = {
  'reports.exportJobCreate': { name: 'DATATABLE SEARCH INVENTORY' },
  'saleOrder.allocateB2C': { saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'A', quantity: 1 }] },
  'saleOrder.allocateB2B': { saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'A', quantity: 1 }] },
  'shippingPackage.createInvoice': { shippingPackageCode: 'PK1', facility: 'F1' },
  'shipment.allocateProvider': { shippingPackageCode: 'PK1', facility: 'F1' },
  'shipment.dispatch': { shippingPackageCode: 'PK1', facility: 'F1' },
  'shipment.markDelivered': { shippingPackageCode: 'PK1', facility: 'F1' },
  'manifest.create': { channel: 'CUSTOM', facility: 'F1' },
  'manifest.addPackages': { shippingManifestCode: 'SM1', shippingPackageCodes: ['PK1'], facility: 'F1' },
  'manifest.close': { shippingManifestCode: 'SM1', facility: 'F1' },
  'returns.bulkReturnCreate': {
    saleOrder: 'SO1', facility: 'F1', customerCode: 'C1', channelCode: 'CUSTOM_B2B',
    items: [{ sku: 'A', quantity: 1 }],
  },
  'putaway.complete': { putawayCode: 'PT1', facility: 'F1' },
  'inventory.adjust': { sku: 'A', quantity: 1, adjustmentType: 'ADD', facility: 'F1' },
  'saleOrder.cancel': { saleOrder: 'SO1', facility: 'F1' },
};

test('EVERY mutating action is dry-runnable and touches nothing when previewing', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const mutating = c.listCapabilities().filter((x) => x.mutates);
  assert.ok(mutating.length >= 14, `expected the full write surface, got ${mutating.length}`);

  for (const cap of mutating) {
    const params = VALID_MUTATE_PARAMS[cap.id];
    assert.ok(params, `new mutating action ${cap.id} has no dry-run fixture — add one`);
    const r = await c.invoke(cap.id, params, { dryRun: true });
    assert.equal(r.dryRun, true, `${cap.id} must support dryRun`);
    assert.equal(r.ok, true);
  }
  assert.equal(uc.calls.length, 0, 'dry-run must never reach Unicommerce');
});

test('dry-run still reports invalid params instead of previewing an impossible call', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('shipment.dispatch', { shippingPackageCode: 'PK1' }, { dryRun: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});

test('dry-run previews the params so an operator can see what WOULD be sent', async () => {
  const c = createUnicommerceConnector({ uc: spyUc() });
  const r = await c.invoke('manifest.close', { shippingManifestCode: 'SM0080', facility: 'F1' }, { dryRun: true });
  assert.deepEqual(r.preview.params, { shippingManifestCode: 'SM0080', facility: 'F1' });
});

/* ---------------- allocation ---------------- */

test('allocateB2C posts the proven payload and returns package codes', async () => {
  const uc = spyUc({ 'allocate/inventory': { successful: true, shippingPackageCodes: ['PK1'] } });
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.allocateB2C', {
    saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.shippingPackageCodes, ['PK1']);
  const call = uc.calls.find((x) => x.path.includes('allocate/inventory'));
  assert.deepEqual(call.body, {
    saleOrderCode: 'SO1',
    saleOrderItemCodeToInventoryAllocation: { A: { inventory: 2 }, B: { inventory: 1 } },
  });
  assert.equal(call.opts.facility, 'F1', 'facility must be explicit, never inherited from session');
});

test('allocateB2B resolves a shelf and ALWAYS sends inventoryLocationData', async () => {
  // The documented silent failure: empty inventoryLocationData → HTTP 200, nothing allocated.
  const uc = spyUc({
    batchwise: { batchwiseInventories: [{ shelfCode: 'S1', batchCode: 'B7', availableQuantity: 10 }] },
  });
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.allocateB2B', {
    saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'A', quantity: 3 }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.async, true, 'B2B allocation is async — caller must poll');
  const call = uc.calls.find((x) => x.path.includes('smart-fill/orders/allocate'));
  const locData = call.body.allocationItems[0].saleOrderItemCodeToInventoryAllocation.A.inventoryLocationData;
  assert.deepEqual(locData, [{ shelfCode: 'S1', batchCode: 'B7', inventory: '3' }]);
});

test('allocateB2B REFUSES rather than silently allocating nothing when no shelf exists', async () => {
  const uc = spyUc({ batchwise: { batchwiseInventories: [] } });
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.allocateB2B', {
    saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'GHOST', quantity: 1 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.some((x) => x.path.includes('smart-fill')), false, 'must not fire a no-op allocate');
});

/* ---------------- never report false success ---------------- */

test("UC's successful:false is a business failure, never reported as ok", async () => {
  const uc = spyUc({
    'allocate/inventory': { successful: false, errors: [{ description: 'insufficient inventory' }] },
  });
  const c = createUnicommerceConnector({ uc });
  await assert.rejects(
    () => c.invoke('saleOrder.allocateB2C', { saleOrder: 'SO1', facility: 'F1', items: [{ sku: 'A', quantity: 1 }] }),
    /insufficient inventory/,
  );
});

/* ---------------- the dispatch tail ---------------- */

test('invoice → provider allocate → manifest close uses the right auth layer per call', async () => {
  const uc = spyUc({
    createInvoice: { invoiceCode: 'INS0110' },
    'provider/allocate': { successful: true, trackingNumber: 'AWB123' },
    'shippingManifest/create': { shippingManifestCode: 'SM0080' },
  });
  const c = createUnicommerceConnector({ uc });

  const inv = await c.invoke('shippingPackage.createInvoice', { shippingPackageCode: 'PK1', facility: 'F1' });
  assert.equal(inv.invoiceCode, 'INS0110');

  const prov = await c.invoke('shipment.allocateProvider', { shippingPackageCode: 'PK1', facility: 'F1' });
  assert.equal(prov.trackingNumber, 'AWB123');

  const man = await c.invoke('manifest.create', { channel: 'CUSTOM', facility: 'F1' });
  assert.equal(man.shippingManifestCode, 'SM0080');

  const closed = await c.invoke('manifest.close', { shippingManifestCode: 'SM0080', facility: 'F1' });
  assert.equal(closed.dispatched, true, 'closing the manifest is what dispatches');

  // Public REST (bearer) vs internal /data (session) must not be mixed up.
  assert.equal(uc.calls.find((x) => x.path.includes('createInvoice')).layer, 'public');
  assert.equal(uc.calls.find((x) => x.path.includes('shippingManifest/close')).layer, 'public');
  assert.equal(uc.calls.find((x) => x.path.includes('provider/allocate')).layer, 'data');
});

/* ---------------- returns ---------------- */

test('bulkReturnCreate sends the flow-proven body and reports the putaway caveat', async () => {
  const uc = spyUc({
    'bulkReturn/create': {
      successful: true, bulkReturnId: 55, putawayCode: 'PT0090',
      reversePickups: [{ reversePickupCode: 'RP1' }],
    },
  });
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('returns.bulkReturnCreate', {
    saleOrder: 'SO1', facility: 'F1', customerCode: 'OPPB2B01', channelCode: 'CUSTOM_B2B',
    items: [{ sku: 'A', quantity: 1 }],
  });
  assert.equal(r.bulkReturnId, 55);
  assert.deepEqual(r.reversePickups, ['RP1']);
  assert.match(r.note, /putaway/i, 'must state that stock is not sellable until putaway');

  const body = uc.calls.find((x) => x.path.includes('bulkReturn/create')).body;
  assert.equal(body.putawayEnabled, true);
  assert.equal(body.bulkReturnId, null);
  assert.deepEqual(body.lineItems, [{ skuCode: 'A', quantity: 1, inventoryType: 'GOOD_INVENTORY', returnReason: null }]);
});

test('putaway.complete runs createPutawayList BEFORE complete (order matters)', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('putaway.complete', { putawayCode: 'PT0090', facility: 'F1' });
  assert.equal(r.inventoryRestored, true);
  const paths = uc.calls.map((x) => x.path);
  assert.ok(paths.indexOf('/data/putaway/manager/createPutawayList') < paths.indexOf('/data/putaway/complete'));
});

/* ---------------- inventory ---------------- */

test('inventory.adjust wraps the payload UC expects and enforces the ADD/REMOVE enum', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('inventory.adjust', {
    sku: 'A', quantity: 5, adjustmentType: 'ADD', facility: 'F1',
  });
  assert.equal(r.ok, true);
  const body = uc.calls[0].body.inventoryAdjustment;
  assert.equal(body.itemSKU, 'A');
  assert.equal(body.shelfCode, 'DEFAULT');
  assert.equal(body.inventoryType, 'GOOD_INVENTORY');

  const bad = await c.invoke('inventory.adjust', {
    sku: 'A', quantity: 5, adjustmentType: 'SET', facility: 'F1',
  });
  assert.equal(bad.code, 'INVALID_INPUT', 'only ADD/REMOVE are valid');
});

/* ---------------- schema enforcement on the write surface ---------------- */

test('mutates refuse to run without an explicit facility', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('shipment.dispatch', { shippingPackageCode: 'PK1' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});

test('oversized batch inputs are rejected before reaching UC', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('manifest.addPackages', {
    shippingManifestCode: 'SM1', facility: 'F1',
    shippingPackageCodes: Array.from({ length: 5000 }, (_, i) => `PK${i}`),
  });
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});
