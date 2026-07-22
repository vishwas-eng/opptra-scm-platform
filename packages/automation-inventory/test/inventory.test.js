import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoStep } from '@opptra/core';
import { makeInventoryPipeline } from '../src/pipeline.js';

const CFG = { UC_VENDOR_CODE: 'V1', UC_SHELF_CODE: 'DEFAULT', UC_CURRENCY: 'INR', UC_OUTWARD_CHANNEL: 'CUSTOM', UC_OUTWARD_SHIP_METHOD: 'STD', UC_DEFAULT_FACILITY: 'F1' };

function mockUc(calls, overrides = {}) {
  return {
    async public(path, body, opts) {
      calls.push({ layer: 'public', path });
      if (path.includes('purchaseOrder/createApproved')) return { purchaseOrderCode: 'PO1' };
      if (path.includes('inflowReceipt/create')) return { inflowReceiptCode: 'GRN1' };
      if (path.includes('inventorySnapshot/get')) return { inventorySnapshots: (body.itemTypeSKUs || []).map((s) => ({ itemTypeSKU: s, inventory: 10 })) };
      if (path.includes('saleOrder/create')) return { successful: true };
      if (path.includes('createInvoice')) return { invoiceCode: 'INV1' };
      return { successful: true, ...overrides };
    },
    async data(path, body, opts) {
      calls.push({ layer: 'data', path });
      if (path.includes('allocate/inventory')) return { shippingPackageCodes: ['PKG1'] };
      return { successful: true };
    },
  };
}

test('inward ADJUST: PO → adjust → verify, using only the public (bearer) layer', async () => {
  const calls = [];
  const uc = mockUc(calls);
  const memo = makeMemoStep(new Map());
  const { runInward } = makeInventoryPipeline(uc, { ...CFG, UC_INWARD_MODE: 'ADJUST', UC_GRN_TRAIL: false }, memo);
  const r = await runInward({ reqId: 'R1', items: [{ sku: 'S1', quantity: 5, unitPrice: 100 }] });
  assert.equal(r.status, 'INWARD_DONE');
  assert.equal(r.poCode, 'PO1');
  assert.equal(r.putawayCode, null);
  assert.ok(calls.some((c) => c.path.includes('inventory/adjust')));
  assert.ok(!calls.some((c) => c.layer === 'data'), 'ADJUST mode uses no internal /data calls');
});

test('inward idempotency: a retry with the same reqId does NOT re-create the PO', async () => {
  const store = new Map();
  const memo = makeMemoStep(store);
  const calls1 = []; const uc1 = mockUc(calls1);
  const p1 = makeInventoryPipeline(uc1, { ...CFG, UC_INWARD_MODE: 'ADJUST', UC_GRN_TRAIL: false }, memo);
  await p1.runInward({ reqId: 'R2', items: [{ sku: 'S1', quantity: 5, unitPrice: 100 }] });
  const poCalls1 = calls1.filter((c) => c.path.includes('createApproved')).length;

  // Second run, SAME reqId + SAME store → PO step must be memoized, not re-called.
  const calls2 = []; const uc2 = mockUc(calls2);
  const p2 = makeInventoryPipeline(uc2, { ...CFG, UC_INWARD_MODE: 'ADJUST', UC_GRN_TRAIL: false }, memo);
  await p2.runInward({ reqId: 'R2', items: [{ sku: 'S1', quantity: 5, unitPrice: 100 }] });
  const poCalls2 = calls2.filter((c) => c.path.includes('createApproved')).length;

  assert.equal(poCalls1, 1, 'PO created once on first run');
  assert.equal(poCalls2, 0, 'PO NOT re-created on retry (idempotent)');
});

test('outward: SO → allocate (internal) → invoice; expands one item per unit', async () => {
  const calls = [];
  const uc = mockUc(calls);
  const memo = makeMemoStep(new Map());
  const { runOutward } = makeInventoryPipeline(uc, CFG, memo);
  const r = await runOutward({ reqId: 'R3', items: [{ sku: 'S1', quantity: 2, sellingPrice: 150 }] });
  assert.equal(r.status, 'OUTWARD_DONE');
  assert.deepEqual(r.shippingPackages, ['PKG1']);
  assert.ok(calls.some((c) => c.path.includes('allocate/inventory') && c.layer === 'data'));
  assert.ok(calls.some((c) => c.path.includes('createInvoice')));
});

test('full-cycle: outward is gated on inward success', async () => {
  const calls = [];
  // Make inward's PO step throw to prove outward is never attempted.
  const uc = {
    async public(path) { if (path.includes('createApproved')) throw new Error('PO boom'); return { inventorySnapshots: [] }; },
    async data() { return {}; },
  };
  const memo = makeMemoStep(new Map());
  const { runFullCycle } = makeInventoryPipeline(uc, { ...CFG, UC_INWARD_MODE: 'ADJUST', UC_GRN_TRAIL: false }, memo);
  await assert.rejects(() => runFullCycle({ reqId: 'R4', items: [{ sku: 'S1', quantity: 1, unitPrice: 10 }] }), /Inward failed — outward NOT attempted/);
});
