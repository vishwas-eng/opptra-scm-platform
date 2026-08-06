import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEwaybillPipeline, downloadEwayPdf } from '../src/pipeline.js';

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

function pdfFetch(ok = true) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!ok) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from('%PDF-1.4 mock e-way bill content ' + 'x'.repeat(600));
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return () => { globalThis.fetch = prev; };
}

test('resolves invoice by hopping facilities, then generates and downloads the PDF', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: { F2: { shippingPackages: [{ invoiceCode: 'INV2', statusCode: 'READY_TO_SHIP', code: 'PK2' }] } },
      generateResult: { successful: true, ewayBillNo: 'EWB123', ewayBillPdfUrl: 'https://s3/ewb.pdf' },
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' });
    assert.equal(r.ok, true);
    assert.equal(r.ewb, 'EWB123');
    assert.equal(r.invoiceCode, 'INV2');
    assert.ok(r.file?.base64, 'PDF must be attached for download');
    assert.equal(r.file.contentType, 'application/pdf');
    assert.match(r.file.filename, /EWB_SO1_EWB123\.pdf/);
    assert.equal(Buffer.from(r.file.base64, 'base64').slice(0, 4).toString(), '%PDF');
    const gen = uc.calls.find((c) => c.path?.includes('generateEWayBill'));
    assert.equal(gen.facility, 'F2');
  } finally { restore(); }
});

test('rejects a GSTIN that is not exactly 15 chars, before any generate', async () => {
  const uc = mockUc({ invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } }, generateResult: {} });
  const { generateOne } = makeEwaybillPipeline(uc);
  const r = await generateOne({ so: 'SO1', gstin: 'TOOSHORT' });
  assert.equal(r.ok, false);
  assert.match(r.error, /15-character Indian GSTIN|15 characters/i);
  assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'must not call generate with a bad GSTIN');
});

test('dry run resolves + validates but never calls generate or downloads PDF', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({ invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } }, generateResult: {} });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' }, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.invoiceCode, 'INV1');
    assert.equal(r.file, undefined);
    assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'dry run must not generate');
  } finally { restore(); }
});

test('skips an SO that already has an EWB but still downloads its PDF', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: {
        F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1', ewayBillNo: 'EXISTING', ewayBillPdfUrl: 'https://s3/old.pdf' }] },
      },
      generateResult: {},
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.ewb, 'EXISTING');
    assert.ok(r.file?.base64, 'existing EWB should still be downloadable');
    assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'must not regenerate');
  } finally { restore(); }
});

test('generate still succeeds when PDF download fails - flags pdfError', async () => {
  const restore = pdfFetch(false);
  try {
    const uc = mockUc({
      invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } },
      generateResult: { successful: true, ewayBillNo: 'EWB9', ewayBillPdfUrl: 'https://s3/gone.pdf' },
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' });
    assert.equal(r.ok, true);
    assert.equal(r.ewb, 'EWB9');
    assert.equal(r.file, null);
    assert.match(r.pdfError, /could not be downloaded/i);
  } finally { restore(); }
});

test('skips when only a PDF URL is present (no EWB number) and still downloads', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: {
        F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1', ewayBillPdfUrl: 'https://s3/only-url.pdf' }] },
      },
      generateResult: { successful: true, ewayBillNo: 'SHOULD_NOT' },
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1' });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.ok(r.file?.base64);
    assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')), 'must not regenerate when PDF URL already exists');
  } finally { restore(); }
});

test('already-had EWB still returns the PDF even on dry run', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: {
        F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1', ewayBillNo: 'EXISTING', ewayBillPdfUrl: 'https://s3/old.pdf' }] },
      },
      generateResult: {},
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1' }, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.dryRun, true);
    assert.ok(r.file?.base64, 'existing EWB PDF must download even when dry-run is on');
    assert.ok(!uc.calls.some((c) => c.path?.includes('generateEWayBill')));
  } finally { restore(); }
});

test('downloadEwayPdf rejects non-PDF bodies', async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('<html>not a pdf</html>').buffer,
  });
  try {
    assert.equal(await downloadEwayPdf('https://x'), null);
  } finally { globalThis.fetch = prev; }
});

test('defaults transDistance to 1 when distance is blank (GST error 107)', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } },
      generateResult: { successful: true, ewayBillNo: 'EWB1', ewayBillPdfUrl: 'https://s3/ewb.pdf' },
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    const r = await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5' });
    assert.equal(r.ok, true);
    const gen = uc.calls.find((c) => c.path?.includes('generateEWayBill'));
    assert.equal(gen.body.transporterDetail.transDistance, '1');
  } finally { restore(); }
});

test('keeps an explicit positive distance', async () => {
  const restore = pdfFetch(true);
  try {
    const uc = mockUc({
      invoiceByFacility: { F1: { shippingPackages: [{ invoiceCode: 'INV1', code: 'PK1' }] } },
      generateResult: { successful: true, ewayBillNo: 'EWB1', ewayBillPdfUrl: 'https://s3/ewb.pdf' },
    });
    const { generateOne } = makeEwaybillPipeline(uc);
    await generateOne({ so: 'SO1', gstin: '29ABCDE1234F1Z5', distance: '42' });
    const gen = uc.calls.find((c) => c.path?.includes('generateEWayBill'));
    assert.equal(gen.body.transporterDetail.transDistance, '42');
  } finally { restore(); }
});

test('a batch fetches the facility list once, not once per row', async () => {
  // Every /data call is facility-scoped, serialized behind the session mutex and paced
  // at UC_MAX_RPS, so a per-row list fetch was pure latency on every upload.
  let facilityFetches = 0;
  const uc = {
    dataGet: async () => {
      facilityFetches += 1;
      return { currentFacilityCode: 'A', facilityDTOList: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] };
    },
    data: async (path, body, opts) => {
      if (path.includes('fetchShippingPackageDetails')) {
        return opts.facility === 'B'
          ? { shippingPackages: [{ code: 'SP1', invoiceCode: 'INV1', statusCode: 'DISPATCHED' }] }
          : { shippingPackages: [] };
      }
      return { successful: true, ewayBillNo: '123456789012' };
    },
  };
  const p = makeEwaybillPipeline(uc);
  for (const so of ['SO1', 'SO2', 'SO3']) await p.resolveInvoice(so);
  assert.equal(facilityFetches, 1, `expected one facility fetch for the batch, got ${facilityFetches}`);
});

test('after one order is located, the rest try that warehouse first', async () => {
  // Orders in a single upload almost always share a warehouse, so remembering the last
  // hit turns an N-facility walk into one probe for every row after the first.
  const probes = [];
  const uc = {
    dataGet: async () => ({ currentFacilityCode: 'A', facilityDTOList: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] }),
    data: async (path, body, opts) => {
      if (path.includes('fetchShippingPackageDetails')) {
        probes.push(opts.facility);
        return opts.facility === 'C'
          ? { shippingPackages: [{ code: 'SP', invoiceCode: 'INV', statusCode: 'DISPATCHED' }] }
          : { shippingPackages: [] };
      }
      return { successful: true, ewayBillNo: '123456789012' };
    },
  };
  const p = makeEwaybillPipeline(uc);
  await p.resolveInvoice('SO1');
  await p.resolveInvoice('SO2');

  // SO1 walks A, B, C. SO2 should go straight to C.
  assert.deepEqual(probes, ['A', 'B', 'C', 'C'],
    `expected the second order to hit C first, probes were ${probes.join(',')}`);
});
