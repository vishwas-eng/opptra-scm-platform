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
  const { processSO } = makeReturnPipeline(uc, { facility: 'F1' });

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
  const { processSO } = makeReturnPipeline(uc, { facility: 'F1' });

  // allocPoll loops a few times; with no package ever appearing it returns pending,
  // but the allocate write must have been attempted.
  await processSO('SO123', { dryRun: false, cancelSO: 'SO999' });
  const writeCalls = calls.filter((c) => WRITE_MARKERS.some((m) => c.path.includes(m)));
  assert.ok(writeCalls.length > 0, 'a real run must issue at least one write (cancel/allocate)');
});
