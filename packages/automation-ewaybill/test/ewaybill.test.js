import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEwaybillPipeline } from '../src/pipeline.js';

// Mock UC: facilities list + facility-scoped invoice resolution + generate.
function mockUc({ invoiceByFacility = {}, generateResult, calls = [] } = {}) {
  return {
    calls,
    async dataGet(path) {
      calls.push({ path });
      if (path.includes('/data/user/facilities')) {
        return { currentFacilityCode: 'F1', facilityDTOList: [{ code: 'F1' }, { code: 'F2' }] };
      }
      return {};
    },
    async data(path, body, opts = {}) {
      calls.push({ path, facility: opts.facility, body });
      if (path.includes('fetchShippingPackageDetails')) {
        return invoiceByFacility[opts.facility] || { shippingPackages: [] };
      }
      if (path.includes('generateEWayBill')) return generateResult;
      return { successful: true };
    },
  };
}

test('resolves invoice by hopping facilities, then generates', async () => {
  const uc = mockUc({
    invoiceByFacility: { F2: { shippingPackages: [{ invoiceCode: 'INV2', statusCode: 'READY_TO_SHIP', code: 'PK2' }] } },
    generateResult: { successful: true, ewayBillNo: 'EWB123', ewayBillPdfUrl: 'https://x/y.pdf' },
  });
  const { generateOne } = makeEwaybillPipeline(uc);
  const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' });
  assert.equal(r.ok, true);
  assert.equal(r.ewb, 'EWB123');
  assert.equal(r.invoiceCode, 'INV2');
  // the generate call used facility F2 (where the invoice was found)
  const gen = uc.calls.find((c) => c.path?.includes('generateEWayBill'));
  assert.equal(gen.facility, 'F2');
});

test('rejects a GSTIN that is not exactly 15 chars, before any generate', async () => {
  const uc = mockUc({ invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } }, generateResult: {} });
  const { generateOne } = makeEwaybillPipeline(uc);
  const r = await generateOne({ so: 'SO1', gstin: 'TOOSHORT' });
  assert.equal(r.ok, false);
  assert.match(r.error, /15 characters/);
  assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'must not call generate with a bad GSTIN');
});

test('dry run resolves + validates but never calls generate', async () => {
  const uc = mockUc({ invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } }, generateResult: {} });
  const { generateOne } = makeEwaybillPipeline(uc);
  const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' }, { dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.invoiceCode, 'INV1');
  assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'dry run must not generate');
});

test('skips an SO that already has an EWB', async () => {
  const uc = mockUc({ invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1', ewayBillNo: 'EXISTING' }] } }, generateResult: {} });
  const { generateOne } = makeEwaybillPipeline(uc);
  const r = await generateOne({ so: 'SO1' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.ewb, 'EXISTING');
});
