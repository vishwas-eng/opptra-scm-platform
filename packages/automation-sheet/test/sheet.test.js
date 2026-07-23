import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSheetPipeline } from '../src/pipeline.js';

const CFG = { MASTER_SHEET_ID: 'sid', MASTER_TAB: 'Master', MASTER_SO_COL: 'A', WAYPOINT_BASE_URL: 'https://wp.test' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sheetsMock(existingTabs = ['Master']) {
  const state = { master: [['SO0001'], ['SO0002']], date: [], appended: [], updated: [], addedTabs: [], ranges: [], tabs: [...existingTabs] };
  const sheets = {
    spreadsheets: {
      get: async () => ({ data: { sheets: state.tabs.map((t) => ({ properties: { title: t } })) } }),
      batchUpdate: async ({ requestBody }) => { const t = requestBody.requests[0].addSheet.properties.title; state.tabs.push(t); state.addedTabs.push(t); return { data: {} }; },
      values: {
        get: async ({ range }) => { state.ranges.push(range); return { data: { values: range.includes('Master') ? state.master : state.date } }; },
        append: async ({ range, requestBody }) => { state.ranges.push(range); state.appended.push({ range, rows: requestBody.values }); return { data: {} }; },
        update: async ({ range, requestBody }) => { state.ranges.push(range); state.updated.push({ range, rows: requestBody.values }); return { data: {} }; },
      },
    },
  };
  return { google: { sheets }, state };
}

test('not connected: returns a clear error, never throws', async () => {
  const { firstFill } = makeSheetPipeline({}, CFG, null);
  const r = await firstFill();
  assert.equal(r.ok, false);
  assert.match(r.error, /not connected/i);
});

test('first-fill: creates the date tab, quotes the range, writes only missing SOs', async () => {
  const { google, state } = sheetsMock(['Master']); // date tab does NOT exist yet
  globalThis.fetch = async () => ({ ok: true, text: async () => 'SO Number,Status\nSO0001,CREATED\nSO0003,CREATED\nSO0004,SHIPPED\n' });
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  const r = await firstFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.written, 1);                 // only SO0003 (SO0001 in Master, SO0004 not CREATED)
  assert.equal(state.addedTabs.length, 1, 'the date tab was created');
  // every date-tab range is single-quoted (name has a space) -> no "Unable to parse range"
  assert.ok(state.appended[0].range.startsWith("'") && state.appended[0].range.includes("'!A1"), state.appended[0].range);
  assert.equal(state.appended[0].rows[0][0], 'SO0003');
});

test('second-fill: hops facilities to resolve invoice, quotes ranges', async () => {
  const { google, state } = sheetsMock(['Master', 'today']);
  state.date = [['SO0003', '2026-07-23', '', ''], ['SO0009', '2026-07-23', 'INV/HAS', 'T']];
  let hops = 0;
  const uc = { data: async (path, body, opts) => { hops++; return opts.facility === 'Opp_WIQ_MH_1' && body.saleOrderCode === 'SO0003'
    ? { shippingPackages: [{ invoiceCode: 'INV/NEW', trackingNumber: 'TRK9' }] } : { shippingPackages: [] }; } };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  const r = await secondFill();
  assert.equal(r.ok, true);
  assert.equal(r.counts.enriched, 1);                // SO0003 enriched, SO0009 skipped (already has invoice)
  assert.ok(hops > 1, 'it hopped multiple facilities');
  assert.ok(state.updated[0].range.startsWith("'"), 'range is quoted');
  assert.deepEqual(state.updated[0].rows[0], ['INV/NEW', 'TRK9']);
});

test('second-fill: a dead session fails loud (not masked as under-enriched)', async () => {
  const { google } = sheetsMock(['Master', 'today']);
  google.sheets.spreadsheets.values.get = async () => ({ data: { values: [['SO1', 'd', '', '']] } });
  const uc = { data: async () => { const e = new Error('session expired'); e.name = 'SessionError'; throw e; } };
  const { secondFill } = makeSheetPipeline(uc, CFG, google);
  await assert.rejects(() => secondFill(), /session expired/);
});

test('push: appends date-tab rows into Master', async () => {
  const { google, state } = sheetsMock(['Master', 'today']);
  state.date = [['SO0003', 'd', 'INV', 'TRK'], ['', '', '', '']];
  const { push } = makeSheetPipeline({}, CFG, google);
  const r = await push();
  assert.equal(r.ok, true);
  assert.equal(r.counts.pushed, 1);
  assert.ok(state.appended.some((a) => a.range.includes('Master')));
});

test('waypoint HTTP failure surfaces cleanly', async () => {
  const { google } = sheetsMock();
  globalThis.fetch = async () => ({ ok: false, status: 502, text: async () => '' });
  const { firstFill } = makeSheetPipeline({}, CFG, google);
  await assert.rejects(() => firstFill(), /Waypoint export failed/);
});
