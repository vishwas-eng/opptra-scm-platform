import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSheetPipeline } from '../src/pipeline.js';
import { soNorm } from '../src/schema.js';

// The mock keys sheets by TAB NAME and ignores spreadsheet ids, so the read-only
// source sheet is modeled as a 'MasterSheet' tab living alongside our own tabs.
const CFG = {
  MASTER_SHEET_ID: 'ours', MASTER_TAB: 'Master',
  SOURCE_SHEET_ID: 'source', SOURCE_MASTER_TAB: 'MasterSheet',
  WAYPOINT_BASE_URL: 'https://wp.test',
};
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Real working-copy layout: row 1 banner, row 2 headers, data from row 3.
const HEADERS = [
  'Category', 'Forward / Reverse', 'Type of Sales', 'Marketplace', 'Brand',
  'PO / RPO / Gatepass Number', 'Invoice/Consignment Note', 'SO/GP Number',
  'PO / RPO Quantity', 'PO / Invoice Value Total', 'PO / RPO Received Date',
  'Invoice Qty', 'Pickup Wh Name', 'Origin City', 'Destination City',
  'Appointment Date / EDD', 'Appointment ID', 'Overall Status',
];
const SO_COL = HEADERS.indexOf('SO/GP Number');
const BANNER = HEADERS.map(() => '');

function istTabName() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'day').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'year').value}`;
}

function blankRow(overrides = {}) {
  const row = HEADERS.map(() => '');
  for (const [k, v] of Object.entries(overrides)) row[HEADERS.indexOf(k)] = v;
  return row;
}

function sheetsMock({
  masterRows = [], sourceRows = [], tabs = ['Master', 'MasterSheet'], mirrorTabs = [],
} = {}) {
  const state = {
    tabs: [...tabs],
    sheets: { Master: [BANNER, HEADERS, ...masterRows], MasterSheet: [BANNER, HEADERS, ...sourceRows] },
    updated: [], batchUpdated: [], addedTabs: [],
  };
  const writeAt = (tab, row0, col0, matrix) => {
    state.sheets[tab] = state.sheets[tab] || [];
    matrix.forEach((vals, i) => {
      while (state.sheets[tab].length <= row0 + i) state.sheets[tab].push([]);
      const r = state.sheets[tab][row0 + i];
      vals.forEach((v, j) => { while (r.length <= col0 + j) r.push(''); r[col0 + j] = v; });
    });
  };
  const api = {
    spreadsheets: {
      get: async () => ({ data: { sheets: state.tabs.map((t, i) => ({ properties: { title: t, sheetId: i + 1, gridProperties: { rowCount: 1000 } } })) } }),
      batchUpdate: async ({ requestBody }) => {
        for (const req of requestBody.requests) {
          if (req.addSheet) { const t = req.addSheet.properties.title; state.tabs.push(t); state.addedTabs.push(t); state.sheets[t] = []; }
          if (req.copyPaste) {
            // sheetId in the mock = index in state.tabs + 1 (see spreadsheets.get)
            const from = state.tabs[req.copyPaste.source.sheetId - 1];
            const to = state.tabs[req.copyPaste.destination.sheetId - 1];
            const rows = (state.sheets[from] || []).slice(req.copyPaste.source.startRowIndex, req.copyPaste.source.endRowIndex).map((r) => [...r]);
            state.sheets[to] = state.sheets[to] || [];
            rows.forEach((r, i) => { state.sheets[to][req.copyPaste.destination.startRowIndex + i] = r; });
          }
          // updateSheetProperties / updateDimensionProperties: formatting only - no-op here
        }
        return { data: {} };
      },
      values: {
        // Column-aware on purpose: the fill reads Master's SO column alone (it is a ~29k-row
        // mirror), so a mock that returned whole rows for a one-column range would hand back
        // the wrong column and prove nothing.
        get: async ({ range, valueRenderOption }) => {
          const tab = tabNameFromRange(range);
          // An IMPORTRANGE mirror shows its formula only under FORMULA rendering.
          if (valueRenderOption === 'FORMULA' && mirrorTabs.includes(tab)) {
            return { data: { values: [[`=IMPORTRANGE("https://docs.google.com/spreadsheets/d/src","${tab}!A1:ZZ")`]] } };
          }
          const m = range.match(/!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?/) || [];
          const startCol = m[1] ? colIdx(m[1]) : 0;
          const startRow = Number(m[2] || 1);
          const endCol = m[3] ? colIdx(m[3]) : startCol;
          const endRow = m[4] ? Number(m[4]) : undefined;
          const rows = (state.sheets[tab] || []).slice(startRow - 1, endRow)
            .map((r) => r.slice(startCol, endCol + 1));
          while (rows.length && rows[rows.length - 1].every((c) => c === '' || c == null)) rows.pop();
          return { data: { values: rows } };
        },
        append: async () => { throw new Error('values.append is banned - use an explicit-range update (Master overwrite regression)'); },
        update: async ({ range, requestBody }) => {
          const tab = tabNameFromRange(range);
          const m = range.match(/!([A-Z]+)(\d+)/);
          writeAt(tab, Number(m[2]) - 1, colIdx(m[1]), requestBody.values);
          state.updated.push({ range, rows: requestBody.values });
          return { data: {} };
        },
        clear: async ({ range }) => {
          const tab = tabNameFromRange(range);
          const m = range.match(/![A-Z]+(\d+)/);
          const start = Number(m?.[1] || 1) - 1;
          if (state.sheets[tab]) state.sheets[tab] = state.sheets[tab].slice(0, start);
          state.cleared = state.cleared || [];
          state.cleared.push(range);
          return { data: {} };
        },
        batchUpdate: async ({ requestBody }) => {
          for (const { range, values } of requestBody.data) {
            const tab = tabNameFromRange(range);
            const m = range.match(/!([A-Z]+)(\d+)/);
            writeAt(tab, Number(m[2]) - 1, colIdx(m[1]), values);
          }
          state.batchUpdated.push(requestBody.data);
          return { data: {} };
        },
      },
    },
  };
  return { google: { sheets: api }, state };
}
function tabNameFromRange(range) { return range.match(/^'?([^'!]+)'?!/)[1]; }
function colIdx(letters) { let n = 0; for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; }

const wpCsv = (rows) => ({ ok: true, text: async () => 'SO Code,SO Status,Warehouse,Marketplace,Brand(s),Total Units\n' + rows.join('\n') + '\n' });

// A UC mock that reproduces the ONE asymmetry the warehouse lookup depends on:
// fetchSummary answers for any SO whatever facility we ask as, while saleorder/fetch
// succeeds ONLY at the facility that owns the order. That is what turns a bare SO number
// into a pickup warehouse, so a mock that ignored it would prove nothing.
const FACILITIES_LIVE = ['Opp_RSG_MH', 'Opp_EKT_KA', 'Opp_WIQ_MH_1', 'AMAZON_FBA_BLR4_KA'];
function ucOrderMock(orders = {}, { packagesFor = () => [] } = {}) {
  const calls = { hops: [], summaries: [] };
  const find = (code) => orders[soNorm(code || '')] || null;
  const uc = {
    listFacilities: async () => ({ all: FACILITIES_LIVE, current: 'Opp_RSG_MH' }),
    data: async (path, body = {}, opts = {}) => {
      if (path.endsWith('/saleorder/fetchSummary')) {
        const o = find(body.code);
        calls.summaries.push(body.code);
        if (!o) return { successful: true };
        return {
          saleOrderSummary: {
            code: o.code, status: o.status, channel: o.channel,
            totalPrice: o.value, saleOrderItemCount: o.units,
            shippingAddress: { city: o.city, pincode: o.pincode || '' },
            customFieldValues: [
              { fieldName: 'PO', fieldValue: o.po || null },
              { fieldName: 'AppointmentReferenceNo', fieldValue: o.appointmentId || null },
            ],
          },
        };
      }
      if (path.endsWith('/saleorder/fetch')) {
        const o = find(body.code);
        calls.hops.push({ so: body.code, facility: opts.facility });
        if (!o || o.facility !== opts.facility) return { successful: false };
        return { successful: true, saleOrderDTO: { code: o.code, saleOrderItems: [{ facilityCode: o.facility }] } };
      }
      if (path.endsWith('/fetchShippingPackageDetails')) return { shippingPackages: packagesFor(body.saleOrderCode) };
      return {};
    },
  };
  return { uc, calls };
}

/* ------------------------------- first fill ------------------------------- */

test('not connected: returns a clear error, never throws', async () => {
  const { firstFill } = makeSheetPipeline({}, CFG, null);
  const r = await firstFill();
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/i);
});

test('first-fill: vlookup vs MASTER; every Waypoint status goes to the date tab, not just CREATED', async () => {
  const { google, state } = sheetsMock({
    // SO0001 is already on Master → must NOT land on the date tab
    masterRows: [blankRow({ 'SO/GP Number': 'SO0001' })],
    sourceRows: [],
  });
  globalThis.fetch = async () => wpCsv([
    'SO0001,CREATED,Opp_RSG_MH,AMAZON_FBA,Acme,5',
    'SO0003,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3',
    'SO0004,SHIPPED,Opp_RSG_MH,AMAZON_FBA,Acme,2',
    'SO0005,PROCESSING,Opp_RSG_MH,BLINKIT_B2B,Acme,7',
    'SO0006,,Opp_RSG_MH,AMAZON_FBA,Acme,1',
  ]);
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  const r = await firstFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.written, 4, 'every status lands except SO0001, which is already on Master');
  const dateTab = state.sheets[istTabName()];
  assert.deepEqual(dateTab[1], HEADERS, 'headers copied to the date tab');
  const written = dateTab.slice(2).map((x) => x[SO_COL]);
  assert.deepEqual(written, ['SO0003', 'SO0004', 'SO0005', 'SO0006']);
  assert.equal(dateTab[2][HEADERS.indexOf('Marketplace')], 'Zepto');
  // First fill does not rewrite Master
  assert.equal(state.sheets.Master.filter((x) => x[SO_COL] === 'SO0001').length, 1);
  assert.ok(!state.sheets.Master.some((x) => x[SO_COL] === 'SO0003'), 'new orders stay on the date tab, not Master');
});

test('first-fill rerun: date-tab rows persist and are not duplicated; nothing new = no new tab', async () => {
  const { google, state } = sheetsMock({});
  globalThis.fetch = async () => wpCsv(['SO0009,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3']);
  const pipe = makeSheetPipeline({}, CFG, google);
  const r1 = await pipe.firstFill();
  assert.equal(r1.counts.written, 1);
  const r2 = await pipe.firstFill(); // same Waypoint data again
  assert.equal(r2.counts.written, 0);
  assert.match(r2.summary, /up to date/i);
  const tabCount = state.tabs.filter((t) => t.startsWith(istTabName())).length;
  assert.equal(tabCount, 1, 'no _1 tab when there is nothing new');
  assert.equal(state.sheets[istTabName()][2][SO_COL], 'SO0009', 'original row still there');
});

// Typed SOs are ADDITIVE: the Waypoint sweep still runs. An order Waypoint has not
// published has no other way onto the sheet, and without a sheet row the packing mail has
// no warehouse to group by - which is where operators actually felt this.
test('first-fill: a typed SO absent from Waypoint is resolved from UC, warehouse and all', async () => {
  const { google, state } = sheetsMock({});
  globalThis.fetch = async () => wpCsv(['SO0003,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3']);
  const { uc, calls } = ucOrderMock({
    SO02780: {
      code: 'SO02780', facility: 'Opp_EKT_KA', status: 'PROCESSING',
      channel: 'RELIANCE_AJIO_SOR_B2B', po: '5179275981', units: 603, value: 80931, city: 'Tumkur',
    },
  });
  const { firstFill } = makeSheetPipeline(uc, CFG, google);
  const r = await firstFill({ saleOrders: ['SO02780'] });

  assert.equal(r.ok, true);
  assert.equal(r.counts.written, 2, 'the Waypoint order AND the typed one');
  assert.equal(r.counts.fromUc, 1);
  const rows = state.sheets[istTabName()].slice(2);
  const ucRow = rows.find((x) => x[SO_COL] === 'SO02780');
  assert.ok(ucRow, 'the typed SO reached the date tab');
  assert.equal(ucRow[HEADERS.indexOf('Pickup Wh Name')], 'Opp_EKT_KA');
  assert.equal(ucRow[HEADERS.indexOf('Marketplace')], 'AJIO');
  assert.equal(ucRow[HEADERS.indexOf('PO / RPO / Gatepass Number')], '5179275981');
  assert.equal(ucRow[HEADERS.indexOf('PO / RPO Quantity')], 603);
  assert.equal(ucRow[HEADERS.indexOf('Destination City')], 'Tumkur');
  assert.equal(ucRow[HEADERS.indexOf('Brand')], '', 'Brand is not invented from the warehouse code (WIQ/EKT/RSG are not brands)');
  assert.ok(rows.some((x) => x[SO_COL] === 'SO0003'), 'the Waypoint sweep still ran');
  // The hop stops at the owning facility instead of walking all of them.
  assert.ok(!calls.hops.some((h) => h.facility === 'AMAZON_FBA_BLR4_KA'), 'channel drop points are not hopped');
  assert.deepEqual(r.details[0].warehouse, 'Opp_EKT_KA');
});

test('first-fill: a typed SO Unicommerce does not have is reported, and never invents a row', async () => {
  const { google, state } = sheetsMock({});
  globalThis.fetch = async () => wpCsv([]);
  const { uc } = ucOrderMock({});
  const { firstFill } = makeSheetPipeline(uc, CFG, google);
  const r = await firstFill({ saleOrders: ['SO_GHOST'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.notInUc, ['SO_GHOST']);
  assert.match(r.summary, /not in Unicommerce/i);
  assert.ok(!(state.sheets[istTabName()] || []).slice(2).some((x) => x[SO_COL] === 'SO_GHOST'));
});

// Typed SOs are the part the operator is waiting on, so Waypoint being down must not
// take them with it.
test('first-fill: typed SOs still land when Waypoint is unavailable', async () => {
  const { google, state } = sheetsMock({});
  globalThis.fetch = async () => { throw new Error('waypoint down'); };
  const { uc } = ucOrderMock({
    SO02780: { code: 'SO02780', facility: 'Opp_EKT_KA', status: 'PROCESSING', channel: 'AMAZON_B2B', po: 'P1', units: 5, value: 10, city: 'Pune' },
  });
  const { firstFill } = makeSheetPipeline(uc, CFG, google);
  const r = await firstFill({ saleOrders: ['SO02780'] });
  assert.equal(r.counts.written, 1);
  assert.match(r.summary, /Waypoint unavailable/i);
  assert.equal(state.sheets[istTabName()][2][SO_COL], 'SO02780');
});

test('first-fill: with no typed SOs a Waypoint outage is still a hard failure', async () => {
  const { google } = sheetsMock({});
  globalThis.fetch = async () => { throw new Error('waypoint down'); };
  const { uc } = ucOrderMock({});
  const { firstFill } = makeSheetPipeline(uc, CFG, google);
  await assert.rejects(() => firstFill(), /waypoint down/i);
});

test('first-fill rerun with NEW orders same day: opens the next _1 tab, earlier tab untouched', async () => {
  const { google, state } = sheetsMock({});
  const pipe = makeSheetPipeline({}, CFG, google);
  globalThis.fetch = async () => wpCsv(['SO0010,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3']);
  await pipe.firstFill();
  globalThis.fetch = async () => wpCsv(['SO0010,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3', 'SO0011,CREATED,Opp_RSG_MH,BLINKIT_B2B,Acme,4']);
  const r2 = await pipe.firstFill();
  assert.equal(r2.counts.written, 1, 'only the genuinely new SO0011');
  assert.equal(r2.counts.tab, `${istTabName()}_1`);
  assert.equal(state.sheets[`${istTabName()}_1`][2][SO_COL], 'SO0011');
  assert.equal(state.sheets[istTabName()][2][SO_COL], 'SO0010', 'first tab unchanged');
});

/* ------------------------------- second fill ------------------------------ */

test('second-fill: enriches date tabs by header name; Master is never patched', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab], masterRows: [blankRow({ 'SO/GP Number': 'SO0003' })] });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0003', 'Pickup Wh Name': 'Opp_WIQ_MH_1' })];
  const uc = {
    data: async (path, body, opts) => {
      if (path.includes('fetchShippingPackageDetails')) {
        return opts.facility === 'Opp_WIQ_MH_1' && body.saleOrderCode === 'SO0003'
          ? { shippingPackages: [{ invoiceCode: 'INV/NEW', trackingNumber: 'TRK9' }] } : { shippingPackages: [] };
      }
      if (path.includes('fetchSummary')) return { status: 'DISPATCHED', shippingAddress: { city: 'Mumbai', pincode: '400001' } };
      return {};
    },
  };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.enriched, 1);
  const row = state.sheets[tab][2];
  assert.equal(row[HEADERS.indexOf('Invoice/Consignment Note')], 'INV/NEW');
  assert.equal(row[HEADERS.indexOf('Overall Status')], 'DISPATCHED');
  const masterRow = state.sheets.Master[2];
  assert.equal(masterRow[HEADERS.indexOf('Invoice/Consignment Note')], '', 'Master row untouched by second fill');
});

// Driven by SO input: the SO is looked up in the first-fill rows and topped up with its
// invoice data. Rows for other SOs must not be touched.
test('second-fill: given SO numbers, only those rows are enriched', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS,
    blankRow({ 'SO/GP Number': 'SO0003', 'Pickup Wh Name': 'Opp_WIQ_MH_1', Brand: 'Acme', Marketplace: 'Zepto', 'PO / RPO / Gatepass Number': 'PO-9' }),
    blankRow({ 'SO/GP Number': 'SO0004', 'Pickup Wh Name': 'Opp_WIQ_MH_1' }),
  ];
  const asked = [];
  const uc = {
    data: async (path, body) => {
      if (path.includes('fetchShippingPackageDetails')) {
        asked.push(body.saleOrderCode);
        return { shippingPackages: [{ invoiceCode: `INV/${body.saleOrderCode}`, trackingNumber: 'TRK9', ewbNo: 'EWB1' }] };
      }
      if (path.includes('fetchSummary')) return { status: 'DISPATCHED', shippingAddress: { city: 'Mumbai', pincode: '400001' } };
      return {};
    },
  };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['so-0003'] }); // loose typing still matches
  assert.equal(r.ok, true);
  assert.equal(r.counts.requested, 1);
  assert.equal(r.counts.enriched, 1);
  assert.equal(state.sheets[tab][2][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/SO0003');
  assert.equal(state.sheets[tab][3][HEADERS.indexOf('Invoice/Consignment Note')], '', 'the SO we did not ask for stays untouched');
  assert.ok(!asked.includes('SO0004'), 'UC is not called for unrequested SOs');
  // The result joins the first-fill row to the invoice data it just fetched.
  assert.deepEqual(
    { so: r.details[0].so, brand: r.details[0].brand, po: r.details[0].po, invoice: r.details[0].invoice, status: r.details[0].status },
    { so: 'SO0003', brand: 'Acme', po: 'PO-9', invoice: 'INV/SO0003', status: 'DISPATCHED' },
  );
});

test('second-fill: a requested SO already carrying an invoice is refreshed, not skipped', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0003', 'Invoice/Consignment Note': 'INV/OLD' })];
  const uc = {
    data: async (path) => {
      if (path.includes('fetchShippingPackageDetails')) return { shippingPackages: [{ invoiceCode: 'INV/FRESH' }] };
      if (path.includes('fetchSummary')) return { status: 'DELIVERED' };
      return {};
    },
  };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['SO0003'] });
  assert.equal(r.counts.enriched, 1);
  assert.equal(state.sheets[tab][2][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/FRESH');
});

// The dead end that made this whole path necessary: an SO Waypoint never published is on
// no date tab, so the second fill used to answer "run First fill first" - and the first
// fill could not help either, because Waypoint is where it looks. UC is the source of
// record for these orders, so the row is created from UC and enriched in one run.
test('second-fill: an SO on no date tab is created from Unicommerce, then enriched', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS];
  const { uc } = ucOrderMock(
    { SO02780: { code: 'SO02780', facility: 'Opp_EKT_KA', status: 'PROCESSING', channel: 'RELIANCE_AJIO_SOR_B2B', po: '5179275981', units: 603, value: 80931, city: 'Tumkur' } },
    { packagesFor: () => [{ invoiceCode: 'SIEKA/0811', trackingNumber: 'B3452392', ewbNo: 'EWB7' }] },
  );
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['SO02780'] });

  assert.equal(r.ok, true);
  assert.deepEqual(r.notFound, [], 'nothing is reported missing - UC had it');
  assert.deepEqual(r.created, ['SO02780']);
  const row = state.sheets[tab][2];
  assert.equal(row[SO_COL], 'SO02780');
  assert.equal(row[HEADERS.indexOf('Pickup Wh Name')], 'Opp_EKT_KA', 'warehouse resolved by facility hop');
  assert.equal(row[HEADERS.indexOf('PO / RPO / Gatepass Number')], '5179275981');
  assert.equal(row[HEADERS.indexOf('Marketplace')], 'AJIO');
  assert.equal(row[HEADERS.indexOf('Invoice/Consignment Note')], 'SIEKA/0811', 'and enriched in the same run');
  assert.equal(row[HEADERS.indexOf('Tracking number')] ?? '', '');
});

// The first fill's tab convention applies to rows the second fill creates too: one tab per
// batch, so a batch never gets mixed into a tab that already holds one.
test('second-fill: rows it first-fills open a fresh date tab when today\'s already has a batch', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0001', 'Invoice/Consignment Note': 'INV/OLD' })];
  const { uc } = ucOrderMock(
    { SO02780: { code: 'SO02780', facility: 'Opp_EKT_KA', status: 'PROCESSING', channel: 'RELIANCE_AJIO_SOR_B2B', po: 'P1', units: 6, value: 9, city: 'Tumkur' } },
    { packagesFor: () => [{ invoiceCode: 'INV/NEW' }] },
  );
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['SO02780'] });

  assert.equal(r.counts.createdTab, `${tab}_1`, 'a fresh tab, not the occupied one');
  assert.ok(state.addedTabs.includes(`${tab}_1`));
  const fresh = state.sheets[`${tab}_1`];
  assert.deepEqual(fresh[1], HEADERS, 'the new tab carries Master\'s headers');
  assert.equal(fresh[2][SO_COL], 'SO02780');
  assert.equal(fresh[2][HEADERS.indexOf('Pickup Wh Name')], 'Opp_EKT_KA');
  assert.equal(fresh[2][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/NEW', 'enriched on the tab it was created on');
  assert.equal(state.sheets[tab][2][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/OLD', 'the occupied tab is untouched');
});

test('second-fill: an SO in neither the date tabs nor Unicommerce is reported by name', async () => {
  const tab = istTabName();
  const { google } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  const { uc } = ucOrderMock({});
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['SO_NOT_THERE'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.notFound, ['SO_NOT_THERE']);
  assert.match(r.summary, /not in Unicommerce/i);
});

// Regression: a date tab whose row 2 was wiped / overwritten used to hard-fail every
// second-fill with "row 2 has no SO/GP Number". ensureDateTab must restore headers
// from Master before writing.
test('second-fill: repairs a date tab whose header row was damaged', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  // Damaged: row 2 is order data, not headers (the Jul-31 production failure mode).
  state.sheets[tab] = [BANNER, blankRow({ 'SO/GP Number': 'SO_OLD' })];
  const { uc } = ucOrderMock(
    { SO02780: { code: 'SO02780', facility: 'Opp_EKT_KA', status: 'PROCESSING', channel: 'ZEPTO_B2B', po: 'P1', units: 2, value: 5, city: 'Pune' } },
    { packagesFor: () => [{ invoiceCode: 'INV/X' }] },
  );
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill({ saleOrders: ['SO02780'] });
  assert.equal(r.ok, true, r.error || r.summary);
  // Either repaired the base tab or opened _1 after treating base as occupied, // either way headers must be real SO/GP headers.
  const writtenTab = r.counts.createdTab || tab;
  assert.deepEqual(state.sheets[writtenTab][1], HEADERS, 'headers restored from Master');
  assert.ok(state.sheets[writtenTab].some((row, i) => i >= 2 && row[SO_COL] === 'SO02780'));
});

test('second-fill: no SO input keeps the old sweep of every un-invoiced row', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS,
    blankRow({ 'SO/GP Number': 'SO0003' }),
    blankRow({ 'SO/GP Number': 'SO0004', 'Invoice/Consignment Note': 'INV/DONE' }),
  ];
  const uc = {
    data: async (path) => {
      if (path.includes('fetchShippingPackageDetails')) return { shippingPackages: [{ invoiceCode: 'INV/SWEEP' }] };
      if (path.includes('fetchSummary')) return { status: 'DISPATCHED' };
      return {};
    },
  };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill();
  assert.equal(r.counts.scanned, 1, 'only the row without an invoice');
  assert.equal(state.sheets[tab][2][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/SWEEP');
  assert.equal(state.sheets[tab][3][HEADERS.indexOf('Invoice/Consignment Note')], 'INV/DONE', 'already-invoiced row left alone');
});

test('second-fill: a dead session fails loud (not masked as under-enriched)', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({ tabs: ['Master', 'MasterSheet', tab] });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO1' })];
  const uc = { data: async () => { const e = new Error('session expired'); e.name = 'SessionError'; throw e; } };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  await assert.rejects(() => secondFill(), /session expired/);
});

/* ---------------------------------- push ---------------------------------- */

test('push: copies today\'s tabs into Master (dedup), and the date tabs KEEP their rows', async () => {
  const tab = istTabName();
  const { google, state } = sheetsMock({
    tabs: ['Master', 'MasterSheet', tab, `${tab}_1`],
    masterRows: [blankRow({ 'SO/GP Number': 'SO0001' })],
  });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0001' }), blankRow({ 'SO/GP Number': 'SO0003' })];
  state.sheets[`${tab}_1`] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0004' })];
  const { push } = makeSheetPipeline({}, CFG, google);
  const r = await push();
  assert.equal(r.counts.pushed, 2, 'SO0003 + SO0004 (SO0001 already on Master)');
  assert.ok(state.sheets.Master.some((x) => x[SO_COL] === 'SO0003'));
  assert.ok(state.sheets.Master.some((x) => x[SO_COL] === 'SO0004'));
  assert.equal(state.sheets[tab][3][SO_COL], 'SO0003', 'date tab rows persist after push');
});

/* ----------------------------- REGRESSION guards --------------------------- */

test('REGRESSION: writes land after the LAST SO row - immune to banner cells, residue rows, and mid-data SO gaps', async () => {
  const tab = istTabName();
  const residueRow = () => { const r = HEADERS.map(() => ''); r[0] = 'na'; return r; };
  const gapRow = blankRow({ 'Overall Status': 'note row without SO' });
  const { google, state } = sheetsMock({
    tabs: ['Master', 'MasterSheet', tab],
    masterRows: [blankRow({ 'SO/GP Number': 'SO0001' }), gapRow, blankRow({ 'SO/GP Number': 'SO0002' }), residueRow(), residueRow()],
  });
  state.sheets[tab] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0009' })];
  const { push } = makeSheetPipeline({}, CFG, google);
  const r = await push();
  assert.equal(r.counts.pushed, 1);
  // Master: banner(1) headers(2) SO0001(3) gap(4) SO0002(5) residue(6,7) -> new row at 6, over residue only
  assert.deepEqual(state.sheets.Master[0], BANNER, 'banner untouched');
  assert.deepEqual(state.sheets.Master[1], HEADERS, 'headers untouched');
  assert.deepEqual(state.sheets.Master[3], gapRow, 'mid-data gap row untouched');
  assert.equal(state.sheets.Master[5][SO_COL], 'SO0009', 'lands right after the last SO row');
});

/* ------------------------------- source sync ------------------------------- */

test('sync-source: Master is rewritten as an exact replica of the source', async () => {
  const { google, state } = sheetsMock({
    sourceRows: [
      blankRow({ 'SO/GP Number': 'SO0001', 'Overall Status': 'Delivered', Brand: 'Acme' }),
      blankRow({ 'SO/GP Number': 'SO0777', Brand: 'Hamleys', Marketplace: 'Blinkit' }),
    ],
    masterRows: [
      blankRow({ 'SO/GP Number': 'SO0001', 'Overall Status': 'Pickup Pending' }),
      blankRow({ 'SO/GP Number': 'SO0900' }), // was on Master only - must disappear after sync
    ],
  });
  const { syncFromSource } = makeSheetPipeline({}, CFG, google);
  const r = await syncFromSource();
  assert.equal(r.counts.written, 2);
  assert.ok(state.sheets.Master.some((x) => x[SO_COL] === 'SO0777'));
  assert.ok(state.sheets.Master.some((x) => x[SO_COL] === 'SO0001'));
  assert.ok(!state.sheets.Master.some((x) => x[SO_COL] === 'SO0900'), 'rows not on source are removed');
  const so1 = state.sheets.Master.find((x) => x[SO_COL] === 'SO0001');
  assert.equal(so1[HEADERS.indexOf('Overall Status')], 'Delivered');
  assert.deepEqual(state.sheets.Master[0], BANNER, 'banner untouched');
  assert.deepEqual(state.sheets.Master[1], HEADERS, 'headers untouched');
  const again = await syncFromSource();
  assert.equal(again.counts.written, 2, 'second run still rewrites the same snapshot');
});

test('sync-source: duplicate SOs and rows without an SO are kept (exact row count)', async () => {
  const { google, state } = sheetsMock({
    sourceRows: [
      blankRow({ 'SO/GP Number': 'SO0001', Brand: 'A' }),
      blankRow({ 'SO/GP Number': 'SO0001', Brand: 'B' }), // same SO, second line - MUST stay
      blankRow({ Brand: 'no-so-but-content' }),           // empty SO - MUST stay
    ],
    masterRows: [],
  });
  const { syncFromSource } = makeSheetPipeline({}, CFG, google);
  const r = await syncFromSource();
  assert.equal(r.counts.written, 3, 'two SO0001 rows + one empty-SO content row');
  assert.equal(r.counts.withSo, 2);
  const soRows = state.sheets.Master.filter((x) => x[SO_COL] === 'SO0001');
  assert.equal(soRows.length, 2, 'duplicate SO rows are not collapsed');
  assert.ok(state.sheets.Master.some((x) => x[HEADERS.indexOf('Brand')] === 'no-so-but-content'));
});

/* --------------------------------- misc ----------------------------------- */

/* --------------------- Master as an IMPORTRANGE mirror --------------------- */
// Ops rebuilt Master as =IMPORTRANGE(source) so it refreshes itself. The whole tab is then
// one spilled formula result: writing ANY cell inside it replaces the formula with #REF!
// and stops the refresh for everyone. So the two actions that write to Master must refuse.

test('mirror: push refuses rather than overwriting the IMPORTRANGE formula', async () => {
  const { google, state } = sheetsMock({ mirrorTabs: ['Master'], tabs: ['Master', 'MasterSheet', istTabName()] });
  state.sheets[istTabName()] = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0003' })];
  const r = await makeSheetPipeline({}, CFG, google).push();
  assert.equal(r.ok, false);
  assert.match(r.error, /IMPORTRANGE mirror/i);
  assert.match(r.error, /source sheet/i, 'and says where the rows should go instead');
  assert.equal(state.updated.length, 0, 'nothing was written to Master');
});

test('mirror: sync-source refuses - the mirror already does that job', async () => {
  const { google, state } = sheetsMock({ mirrorTabs: ['Master'], sourceRows: [blankRow({ 'SO/GP Number': 'SO0009' })] });
  const r = await makeSheetPipeline({}, CFG, google).syncFromSource();
  assert.equal(r.ok, false);
  assert.match(r.error, /IMPORTRANGE mirror/i);
  assert.equal((state.cleared || []).length, 0, 'the Master data block was never cleared');
  assert.equal(state.updated.length, 0);
});

// Reading the mirror is fine and necessary - only writing to it is not.
test('mirror: first fill still reads Master and writes to the date tab', async () => {
  const { google, state } = sheetsMock({
    mirrorTabs: ['Master'],
    masterRows: [blankRow({ 'SO/GP Number': 'SO0001' })],
  });
  globalThis.fetch = async () => wpCsv([
    'SO0001,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3',
    'SO0003,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3',
  ]);
  const r = await makeSheetPipeline({}, CFG, google).firstFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.onMaster, 1, 'the mirror was read for known SOs');
  assert.equal(r.counts.written, 1, 'only SO0003 is new');
  assert.equal(state.sheets[istTabName()][2][SO_COL], 'SO0003');
  assert.ok(!state.updated.some((u) => u.range.includes('Master')), 'Master itself is untouched');
});

// A rename used to kill every fill with "Could not read Master".
test('master tab: a renamed master tab is found instead of failing the run', async () => {
  const { google, state } = sheetsMock({ tabs: ['Master_IR', 'MasterSheet'] });
  state.sheets.Master_IR = [BANNER, HEADERS, blankRow({ 'SO/GP Number': 'SO0001' })];
  delete state.sheets.Master;
  globalThis.fetch = async () => wpCsv([
    'SO0001,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3',
    'SO0003,CREATED,Opp_RSG_MH,ZEPTO_B2B,Acme,3',
  ]);
  const r = await makeSheetPipeline({}, CFG, google).firstFill();
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.counts.onMaster, 1, 'Master_IR was used as the master tab');
  assert.equal(r.counts.written, 1);
});

test('waypoint HTTP failure surfaces cleanly', async () => {
  const { google } = sheetsMock({});
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => '' });
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  await assert.rejects(() => firstFill(), /Waypoint export failed/);
});

test('first-fill: prefers the Neon DB over the Waypoint CSV export when WAYPOINT_DB_URL is set', async () => {
  const { google } = sheetsMock({ masterRows: [blankRow({ 'SO/GP Number': 'SO0001' })] });
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return wpCsv([]); };
  const fetchSOsFromNeon = async () => [
    { 'SO Code': 'SO0001', 'SO Status': 'CREATED', Warehouse: 'Opp_RSG_MH', Marketplace: 'AMAZON_B2B', 'Brand(s)': 'Acme', 'Total Units': 5 },
    { 'SO Code': 'SO0003', 'SO Status': 'DISPATCHED', Warehouse: 'Opp_RSG_MH', Marketplace: 'ZEPTO_B2B', 'Brand(s)': 'Acme', 'Total Units': 3 },
  ];
  const { firstFill } = makeSheetPipeline({}, { ...CFG, WAYPOINT_DB_URL: 'postgres://neon-test' }, google, { fetchSOsFromNeon });
  const r = await firstFill();
  assert.equal(r.counts.written, 1, 'SO0001 already on Master, only SO0003 new');
  assert.equal(fetchCalled, false, 'CSV export not hit when the DB is configured');
});

test('the Neon query asks for every status, not just CREATED', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/waypointDb.js', import.meta.url), 'utf8');
  const sql = src.slice(src.indexOf('SELECT'), src.lastIndexOf('ORDER BY'));
  assert.ok(!/so_status\s*=/.test(sql), 'no status equality filter in the SQL');
  assert.match(sql, /suppressed = false/, 'withdrawn rows still excluded');
});
