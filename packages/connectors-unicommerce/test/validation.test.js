import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnicommerceConnector } from '../src/index.js';

// inputSchema used to be display-only metadata. The HTTP invoke route's body schema is
// just `params: { type: 'object' }`, so nothing enforced maxItems/maxLength/enum on the
// way to Unicommerce, an ops user could post a 50k-SKU array against the tenant bearer.
function spyUc() {
  const calls = [];
  return {
    calls,
    ping: async () => ({ alive: true }),
    listFacilities: async () => ({ all: [], current: null }),
    data: async (path, body) => { calls.push({ path, body }); return {}; },
    dataGet: async (path) => { calls.push({ path }); return {}; },
    public: async (path, body) => { calls.push({ path, body }); return { inventorySnapshots: [] }; },
  };
}

test('oversized array params are rejected BEFORE any upstream call', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('inventory.snapshot', {
    skus: Array.from({ length: 50_000 }, (_, i) => `SKU${i}`),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(r.retryable, false);
  assert.equal(uc.calls.length, 0, 'must not reach Unicommerce');
});

test('unknown params are rejected (additionalProperties: false is now enforced)', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.getSummary', { saleOrder: 'SO1', sneaky: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});

test('enum params are enforced, a bogus shipment status never reaches the datatable', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('shipments.search', { statuses: ['NOT_A_REAL_STATUS'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});

test('over-long facility strings are rejected (facility is sticky, session-global state)', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('saleOrder.getShippingPackages', {
    saleOrder: 'SO1', facility: 'F'.repeat(500),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.equal(uc.calls.length, 0);
});

test('missing required params are rejected with a readable reason', async () => {
  const c = createUnicommerceConnector({ uc: spyUc() });
  const r = await c.invoke('saleOrder.getSummary', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  assert.ok(r.validationErrors.some((e) => /saleOrder/.test(e)), r.validationErrors.join('|'));
});

test('valid params still pass straight through', async () => {
  const uc = spyUc();
  const c = createUnicommerceConnector({ uc });
  const r = await c.invoke('inventory.snapshot', { skus: ['SKU-1', 'SKU-2'] });
  assert.equal(r.ok, true);
  assert.equal(uc.calls.length, 1);
  assert.deepEqual(uc.calls[0].body.itemTypeSKUs, ['SKU-1', 'SKU-2']);
});

test('unknown actions return the coded error, not a bare string', async () => {
  const c = createUnicommerceConnector({ uc: spyUc() });
  const r = await c.invoke('does.notExist', {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_ACTION');
});

test('reports.exportJobCreate honours fromMs 0 instead of dropping the date filter', async () => {
  // 0 is a legitimate epoch bound; a truthiness check silently exported all history.
  let sent = null;
  const uc = spyUc();
  uc.dataGet = async () => ({ exportColumns: [{ id: 'a' }] });
  uc.data = async (path, body) => { if (path.includes('job/create')) sent = body; return { successful: true, exportJobId: 1 }; };
  const c = createUnicommerceConnector({ uc });
  await c.invoke('reports.exportJobCreate', {
    name: 'DATATABLE SEARCH INVENTORY', dateFilterId: 'createdIn', fromMs: 0, toMs: 1000,
  });
  assert.equal(sent.exportFilters.length, 1, 'fromMs:0 must still produce a filter');
  assert.deepEqual(sent.exportFilters[0].dateRange, { start: 0, end: 1000 });
});
