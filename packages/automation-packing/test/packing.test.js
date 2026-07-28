import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePackingPipeline } from '../src/pipeline.js';
import { parseWarehouseEmailRows, resolveWarehouseEntry } from '../src/warehouseEmails.js';

// A sheet mock: Master + optional date tabs, keyed by tab name. Order details come from
// here now (not UC), matching the two-step flow.
const HEADERS = ['Marketplace', 'Brand', 'PO / RPO / Gatepass Number', 'SO/GP Number', 'PO / RPO Quantity', 'PO / Invoice Value Total', 'Pickup Wh Name', 'Destination City', 'Appointment Date / EDD', 'Dispatch Date', 'Appointment ID'];
function sheetRow(o) {
  const idx = (n) => HEADERS.indexOf(n);
  const r = HEADERS.map(() => '');
  r[idx('SO/GP Number')] = o.so; r[idx('Pickup Wh Name')] = o.wh || 'Opp_RSG_MH';
  r[idx('PO / RPO / Gatepass Number')] = o.po || ''; r[idx('Appointment ID')] = o.appt || '';
  r[idx('Marketplace')] = o.mkt || 'AZ Etrade'; r[idx('Brand')] = o.brand || 'Acme';
  return r;
}
function googleMock({ rows = [], driveHas = () => false, draftReturns = { id: 'd1', message: { threadId: 't1' } } } = {}) {
  const capturedDrafts = []; const sentDrafts = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: 'Master' } }] } }),
    values: { get: async () => ({ data: { values: [HEADERS, ...rows] } }) },
  } };
  const drive = { files: {
    list: async ({ q }) => { const m = q.match(/name = '([^']+)\.pdf'/); const base = m ? m[1] : ''; return { data: { files: driveHas(base) ? [{ id: 'f', name: base + '.pdf' }] : [] } }; },
    get: async () => ({ data: new Uint8Array(Buffer.from('%PDF-1.4 fake pdf content padded out to over five hundred bytes ' + 'x'.repeat(600))).buffer }),
  } };
  const gmail = { users: { drafts: {
    create: async (arg) => { capturedDrafts.push(arg); return { data: draftReturns }; },
    send: async (arg) => { sentDrafts.push(arg); return { data: { id: arg.requestBody.id } }; },
  } } };
  return { google: { sheets, drive, gmail, delegatedUser: 'sca@opptra.com' }, capturedDrafts, sentDrafts };
}

const DIRECTORY = {
  Opp_RSG_MH: {
    warehouse: 'Opp_RSG_MH', to: ['ajit@risingscs.com', 'sachin@risingscs.com'],
    cc: ['indiaops@opptra.com'], finance: ['scfinance@opptra.com'],
    shortCode: 'RSG', contact: 'RSG',
  },
  Opp_WIQ_MH_1: {
    warehouse: 'Opp_WIQ_MH_1', to: ['akshay.madhavi@wareiq.com'],
    cc: ['hardik.arora@wareiq.com', 'indiaops@opptra.com'], finance: ['scfinance@opptra.com'],
    shortCode: 'WIQ', contact: 'WIQ',
  },
};
const CFG = {
  MASTER_SHEET_ID: 'sid', MASTER_TAB: 'Master', GOOGLE_DELEGATED_USER: 'sca@opptra.com',
  LABEL_DRIVE_FOLDER: 'labels', APPOINTMENT_DRIVE_FOLDER: 'appts',
  WAREHOUSE_EMAIL_SHEET_ID: 'wh-emails',
};
const rawOf = (arg) => Buffer.from(arg.requestBody.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const pipeOf = (uc, google, extra = {}) => makePackingPipeline(uc, CFG, google, { warehouseDirectory: DIRECTORY, ...extra });

/* ------------------------------- sheet parse ------------------------------- */

test('parseWarehouseEmailRows: reads To/CC/Finance columns (including duplicate To headers)', () => {
  const dir = parseWarehouseEmailRows([
    ['Warehouse Name', 'To', 'To', 'To', 'CC', 'CC', 'Finance'],
    ['Opp_RSG_MH', 'ajit@risingscs.com', 'sachin@risingscs.com', 'operations@risingscs.com', 'amit.sawant@opptra.com', 'indiaops@opptra.com', 'scfinance@opptra.com'],
    ['Opp_WIQ_KA', 'deekshith.mandadi@wareiq.com', '', 'wiqblr05@wareiq.com', 'hardik.arora@wareiq.com', 'indiaops@opptra.com', 'scfinance@opptra.com'],
    ['', '', '', '', '', 'indiaops@opptra.com', 'scfinance@opptra.com'], // blank warehouse row ignored
  ]);
  assert.equal(dir.Opp_RSG_MH.to.length, 3);
  assert.equal(dir.Opp_RSG_MH.cc.length, 2);
  assert.equal(dir.Opp_RSG_MH.finance[0], 'scfinance@opptra.com');
  assert.equal(dir.Opp_WIQ_KA.to.length, 2);
  assert.equal(resolveWarehouseEntry(dir, 'opp_rsg_mh').shortCode, 'RSG');
});

/* ------------------------------- step 0 / 1 ------------------------------- */

test('not connected: returns a clear error, does not throw', async () => {
  const { createDrafts } = makePackingPipeline({}, CFG, null);
  const r = await createDrafts(['SO1']);
  assert.equal(r.ok, false);
  assert.match(r.error, /Connect your Gmail/i);
});

test('preview: returns warehouse groups with To/CC options from the directory', async () => {
  const { google } = googleMock({ rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH', po: 'PO777', appt: 'APT9' })] });
  const r = await pipeOf({}, google).previewGroups(['SO1']);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].options.to, ['ajit@risingscs.com', 'sachin@risingscs.com']);
  assert.ok(r.groups[0].selectedTo.includes('ajit@risingscs.com'));
  assert.ok(r.groups[0].selectedCc.includes('indiaops@opptra.com'));
});

test('step 1: order table + label + appointment, To/CC from warehouse sheet (not hardcoded)', async () => {
  const { google, capturedDrafts } = googleMock({
    rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH', po: 'PO777', appt: 'APT9', mkt: 'AZ Etrade' })],
    driveHas: (base) => base === 'PO777' || base === 'APT9',
  });
  const r = await pipeOf({}, google).createDrafts(['SO1']);
  assert.equal(r.ok, true);
  assert.equal(r.draftCount, 1);
  assert.equal(r.drafts[0].attachmentCount, 2, 'label + appointment letter');
  assert.match(r.drafts[0].to, /ajit@risingscs\.com/);
  assert.match(r.drafts[0].cc, /indiaops@opptra\.com/);
  assert.match(r.drafts[0].subject, /^Consignment Packing & Readiness - .+ - \d{2}-[A-Z][a-z]+-\d{4} RSG$/);
  const raw = rawOf(capturedDrafts[0]);
  assert.match(raw, /To: ajit@risingscs\.com, sachin@risingscs\.com/);
  assert.match(raw, /Cc: indiaops@opptra\.com/);
  assert.match(raw, /Hi RSG,/);
  assert.match(raw, /Label_PO777\.pdf/);
  assert.match(raw, /Appt_APT9\.pdf/);
});

test('step 1: operator can narrow recipients via the recipients override', async () => {
  const { google, capturedDrafts } = googleMock({
    rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH', po: 'PO777', appt: 'APT9' })],
    driveHas: () => true,
  });
  const r = await pipeOf({}, google).createDrafts(['SO1'], {
    recipients: { Opp_RSG_MH: { to: ['ajit@risingscs.com'], cc: ['indiaops@opptra.com'], includeFinance: true } },
  });
  assert.equal(r.ok, true);
  const raw = rawOf(capturedDrafts[0]);
  assert.match(raw, /To: ajit@risingscs\.com\r/);
  assert.match(raw, /Cc: indiaops@opptra\.com, scfinance@opptra\.com/);
  assert.doesNotMatch(raw, /sachin@risingscs\.com/);
});

test('step 1: multiple SOs across warehouses -> one draft per warehouse', async () => {
  const { google } = googleMock({
    rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH', po: 'P1', appt: 'A1' }), sheetRow({ so: 'SO2', wh: 'Opp_WIQ_MH_1', po: 'P2', appt: 'A2' })],
    driveHas: () => true,
  });
  const r = await pipeOf({}, google).createDrafts(['SO1', 'SO2']);
  assert.equal(r.draftCount, 2);
  assert.deepEqual(r.drafts.map((d) => d.warehouse).sort(), ['Opp_RSG_MH', 'Opp_WIQ_MH_1']);
});

// A UC mock reproducing the asymmetry the warehouse lookup rests on: fetchSummary answers
// for any SO from any facility, while saleorder/fetch succeeds only at the facility that
// owns the order.
function ucOrderMock(orders = {}) {
  const norm = (s) => String(s || '').toUpperCase().replace(/[\s_-]/g, '');
  return {
    listFacilities: async () => ({ all: ['Opp_RSG_MH', 'Opp_WIQ_MH_1'], current: 'Opp_RSG_MH' }),
    data: async (path, body = {}, opts = {}) => {
      const o = orders[norm(body.code)];
      if (path.endsWith('/saleorder/fetchSummary')) {
        if (!o) return { successful: true };
        return {
          saleOrderSummary: {
            code: o.code, status: o.status || 'CREATED', channel: o.channel,
            totalPrice: o.value, saleOrderItemCount: o.units,
            shippingAddress: { city: o.city },
            customFieldValues: [{ fieldName: 'PO', fieldValue: o.po || null }],
          },
        };
      }
      if (path.endsWith('/saleorder/fetch')) {
        if (!o || o.facility !== opts.facility) return { successful: false };
        return { successful: true, saleOrderDTO: { code: o.code, saleOrderItems: [{ facilityCode: o.facility }] } };
      }
      return {};
    },
  };
}

// The sheet lags reality: an order Waypoint has not published is on no tab, so no first
// fill could have written it. Ops still need to mail its warehouse, and UC knows which one
// - so the draft gets built instead of dead-ending on "run Sheet Update first".
test('step 1: an SO missing from the sheet takes its warehouse from Unicommerce', async () => {
  const { google, capturedDrafts } = googleMock({ rows: [], driveHas: () => true });
  const uc = ucOrderMock({
    SO9: { code: 'SO9', facility: 'Opp_WIQ_MH_1', channel: 'RELIANCE_AJIO_SOR_B2B', po: '5179275981', units: 603, value: 80931, city: 'Tumkur' },
  });
  const r = await pipeOf(uc, google).createDrafts(['SO9']);
  assert.equal(r.ok, true);
  assert.equal(r.draftCount, 1);
  assert.equal(r.drafts[0].warehouse, 'Opp_WIQ_MH_1');
  assert.equal(r.drafts[0].to, 'akshay.madhavi@wareiq.com', 'and the directory still supplies the recipients');
  const body = rawOf(capturedDrafts[0]);
  assert.match(body, /Reliance Ajio/, 'the channel is readable in the order table');
  assert.match(body, /5179275981/);
  assert.match(body, /Tumkur/);
});

test('step 1: an SO on neither the sheet nor Unicommerce is reported, not silently dropped', async () => {
  const { google } = googleMock({ rows: [], driveHas: () => true });
  const r = await pipeOf(ucOrderMock({}), google).createDrafts(['SOX']);
  assert.equal(r.ok, false);
  assert.match(r.unresolved[0].reason, /no warehouse for it/);
});

// A row that exists but has an empty warehouse cell used to group under UNKNOWN, which has
// no email - visibly on the sheet, yet unmailable.
test('step 1: a sheet row with a blank warehouse is topped up from Unicommerce', async () => {
  const { google } = googleMock({
    rows: [sheetRow({ so: 'SO7', wh: '', po: 'P7', appt: 'A7' })],
    driveHas: () => true,
  });
  const uc = ucOrderMock({ SO7: { code: 'SO7', facility: 'Opp_RSG_MH', channel: 'AMAZON_B2B', po: 'P7' } });
  const r = await pipeOf(uc, google).createDrafts(['SO7']);
  assert.equal(r.draftCount, 1);
  assert.equal(r.drafts[0].warehouse, 'Opp_RSG_MH');
});

test('step 1: warehouse with no directory entry is reported clearly', async () => {
  const { google } = googleMock({
    rows: [sheetRow({ so: 'SO1', wh: 'Opp_UNKNOWN_XX', po: 'P1', appt: 'A1' })],
    driveHas: () => true,
  });
  const r = await pipeOf({}, google).createDrafts(['SO1']);
  assert.equal(r.draftCount, 0);
  assert.match(r.unresolved[0].reason, /no warehouse email/);
});

/* ------------------------------- step 2 ------------------------------- */

test('step 2: invoice + e-way bill from UC, drafted into the SAME thread', async () => {
  const { google, capturedDrafts } = googleMock({ rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH', po: 'PO777', appt: 'APT9' })] });
  const uc = {
    data: async (path, body, opts) => path.includes('fetchShippingPackageDetails') && opts.facility === 'Opp_RSG_MH'
      ? { shippingPackages: [{ invoiceCode: 'INV/1', ewayBillPdfUrl: 'https://s3/ewb.pdf' }] } : { shippingPackages: [] },
    dataBinary: async () => ({ contentType: 'application/pdf', buffer: Buffer.alloc(800, 37) }),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(600, 1)]) });
  try {
    const savedThreads = [{ warehouse: 'Opp_RSG_MH', thread_id: 't-existing', subject: 'Consignment Packing & Readiness - Amazon - 24-Jul-2026 RSG' }];
    const pipe = pipeOf(uc, google, { latestThreadFor: async (wh) => savedThreads.find((t) => t.warehouse === wh) || null });
    const r = await pipe.sendInvoiceEway(['SO1']);
    assert.equal(r.ok, true);
    assert.equal(r.drafts[0].attachmentCount, 2, 'invoice + e-way bill');
    assert.equal(r.drafts[0].threaded, true);
    assert.equal(capturedDrafts[0].requestBody.message.threadId, 't-existing', 'same Gmail thread');
    const raw = rawOf(capturedDrafts[0]);
    assert.match(raw, /Invoice_INV_1\.pdf/);
    assert.match(raw, /EWB_SO1\.pdf/);
    assert.match(raw, /To: ajit@risingscs\.com/);
  } finally { globalThis.fetch = realFetch; }
});

test('step 2: not invoiced yet = clearly reported, no empty draft', async () => {
  const { google } = googleMock({ rows: [sheetRow({ so: 'SO1', wh: 'Opp_RSG_MH' })] });
  const uc = { data: async () => ({ shippingPackages: [] }), dataBinary: async () => null };
  const r = await pipeOf(uc, google).sendInvoiceEway(['SO1']);
  assert.equal(r.draftCount, 0);
  assert.equal(r.ok, false);
  assert.match(r.unresolved[0].reason, /invoice|e-way/i);
});

/* ------------------------------- send ------------------------------- */

test('sendDraft dispatches the given draft id, not a fresh compose', async () => {
  const { google, sentDrafts } = googleMock({});
  const r = await pipeOf({}, google).sendDraft('draft-9');
  assert.equal(r.ok, true);
  assert.equal(sentDrafts[0].requestBody.id, 'draft-9');
});

test('sendDraft: not connected and missing id are reported cleanly', async () => {
  const disconnected = await makePackingPipeline({}, CFG, null).sendDraft('x');
  assert.equal(disconnected.ok, false);
  const { google } = googleMock({});
  const missingId = await pipeOf({}, google).sendDraft();
  assert.equal(missingId.ok, false);
});
