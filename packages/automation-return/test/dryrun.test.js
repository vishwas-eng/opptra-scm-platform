import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeReturnPipeline } from '../src/pipeline.js';

// A dry run must perform ZERO writes. We record every UC call and assert that no
// mutating endpoint is ever hit when dryRun is true.
const WRITE_MARKERS = [
  'saleOrder/cancel', 'allocate', 'createInvoice', 'dispatch', 'markDelivered',
  'manifest', 'bulkReturn', 'add/awb', 'putaway',
];

function recordingUc(calls) {
  const rec = (kind) => async (path, body) => {
    calls.push({ kind, path });
    // Return benign shapes so the read path (state/detectItems) can proceed.
    if (path.includes('fetchSummary')) return { saleOrderSummary: { status: 'CREATED' } };
    if (path.includes('fetchShippingPackageDetails')) return { shippingPackages: [] };
    if (path.includes('smart-fill/details')) return { skuList: [{ skuCode: 'SKU1', skuSummary: { orderedQuantity: 2 } }] };
    return { successful: true };
  };
  return { data: rec('data'), dataGet: rec('dataGet'), public: rec('public') };
}

test('dryRun performs NO writes, returns a plan', async () => {
  const calls = [];
  const uc = recordingUc(calls);
  const { processSO } = makeReturnPipeline(uc, { UC_DEFAULT_FACILITY: 'F1' });

  const out = await processSO('SO123', { dryRun: true, cancelSO: 'SO999', returnIn: true });

  assert.equal(out.dryRun, true);
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.plan) && out.plan.length > 0, 'plan is populated');
  assert.ok(out.plan.some((p) => p.includes('cancel SO999')), 'plan mentions the cancel');

  const writeCalls = calls.filter((c) => WRITE_MARKERS.some((m) => c.path.includes(m)));
  assert.deepEqual(writeCalls, [], `dry run must not write, but did: ${JSON.stringify(writeCalls)}`);
});

test('non-dry run DOES issue writes (guards against the preview accidentally becoming permanent)', async () => {
  const calls = [];
  const uc = recordingUc(calls);
  const { processSO } = makeReturnPipeline(uc, { UC_DEFAULT_FACILITY: 'F1', UC_RETURN_ALLOC_POLL: 1 });

  // allocPoll loops a few times; with no package ever appearing it returns pending,
  // but the allocate write must have been attempted.
  await processSO('SO123', { dryRun: false, cancelSO: 'SO999' });
  const writeCalls = calls.filter((c) => WRITE_MARKERS.some((m) => c.path.includes(m)));
  assert.ok(writeCalls.length > 0, 'a real run must issue at least one write (cancel/allocate)');
});

test('C2: allocate fires at most once across re-enqueues (no double-commit)', async () => {
  // First attempt: order is CREATED, no package yet → fires allocate, returns pending+allocated.
  const calls1 = [];
  const uc1 = recordingUc(calls1);
  const { processSO: p1 } = makeReturnPipeline(uc1, { UC_DEFAULT_FACILITY: 'F1', UC_RETURN_ALLOC_POLL: 1 });
  const out1 = await p1('SO123', { dryRun: false });
  assert.equal(out1.pending, true);
  assert.equal(out1.allocated, true, 'first attempt records that allocate fired');
  const allocs1 = calls1.filter((c) => c.path.includes('allocate')).length;
  assert.ok(allocs1 >= 1, 'first attempt fires allocate');

  // Retry with allocated:true (as the worker threads it) → must NOT allocate again.
  const calls2 = [];
  const uc2 = recordingUc(calls2);
  const { processSO: p2 } = makeReturnPipeline(uc2, { UC_DEFAULT_FACILITY: 'F1', UC_RETURN_ALLOC_POLL: 1 });
  const out2 = await p2('SO123', { dryRun: false, allocated: true });
  const allocs2 = calls2.filter((c) => c.path.includes('allocate')).length;
  assert.equal(allocs2, 0, 'retry must NOT re-fire allocate');
  assert.equal(out2.allocated, true);
});
