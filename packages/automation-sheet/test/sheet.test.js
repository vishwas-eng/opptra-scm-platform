import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSheetPipeline } from '../src/pipeline.js';

const CFG = { MASTER_SHEET_ID: 'sid', MASTER_TAB: 'Master', MASTER_SO_COL: 'A', WAYPOINT_BASE_URL: 'https://wp.test' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sheetsMock() {
  const state = { master: [['SO0001'], ['SO0002']], date: [], appended: [], updated: [] };
  const google = { sheets: {} };
  const sheets = {
    spreadsheets: { values: {
      get: async ({ range }) => ({ data: { values: range.includes('Master') ? state.master : state.date } }),
      append: async ({ range, requestBody }) => { state.appended.push({ range, rows: requestBody.values }); return { data: {} }; },
      update: async ({ range, requestBody }) => { state.updated.push({ range, rows: requestBody.values }); return { data: {} }; },
    } },
  };
  google.sheets = sheets;
  return { google, state };
}

test('not connected: returns a clear error, never throws', async () => {
  const { firstFill } = makeSheetPipeline({}, CFG, null);
  const r = await firstFill();
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/i);
});

test('first-fill writes only Waypoint orders missing from Master', async () => {
  const { google, state } = sheetsMock();
  globalThis.fetch = async () => ({ ok: true, text: async () => 'SO Number,Status\nSO0001,CREATED\nSO0003,CREATED\nSO0004,SHIPPED\n' });
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  const r = await firstFill();
  assert.equal(r.ok, true);
  // SO0001 already in Master; SO0004 not CREATED → only SO0003 written
  assert.equal(r.counts.written, 1);
  assert.equal(state.appended[0].rows[0][0], 'SO0003');
});

test('second-fill enriches only rows missing an invoice', async () => {
  const { google, state } = sheetsMock();
  state.date = [['SO0003', '2026-07-22', '', ''], ['SO0009', '2026-07-22', 'INV/EXISTING', 'TRK']];
  const uc = { data: async (path, body) => body.saleOrderCode === 'SO0003'
    ? { shippingPackages: [{ invoiceCode: 'INV/NEW', trackingNumber: 'TRK9' }] } : { shippingPackages: [] } };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.enriched, 1);           // only SO0003 (SO0009 already had an invoice)
  assert.match(state.updated[0].range, /C2:D2/); // row 2 (SO0003)
  assert.deepEqual(state.updated[0].rows[0], ['INV/NEW', 'TRK9']);
});

test('push appends the date tab rows into Master', async () => {
  const { google, state } = sheetsMock();
  state.date = [['SO0003', 'd', 'INV', 'TRK'], ['', '', '', '']]; // blank row ignored
  const { push } = makeSheetPipeline({}, CFG, google);
  const r = await push();
  assert.equal(r.ok, true);
  assert.equal(r.counts.pushed, 1);
  assert.match(state.appended[0].range, /Master/);
});

test('waypoint HTTP failure surfaces as a clean error', async () => {
  const { google } = sheetsMock();
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => '' });
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  await assert.rejects(() => firstFill(), /Waypoint export failed/);
});
