// Sheet update (A1) - ported from b2b DailySync.gs, on the Google Sheets integration.
//   first-fill  : Waypoint CREATED orders not already in Master -> today's date tab
//   second-fill : for date-tab rows still missing an invoice, enrich from UC
//   push        : append the date tab's rows into Master
//
// Google Sheets client is INJECTED. When it (or Waypoint) is not configured the pipeline
// returns a clear "not connected" result rather than throwing.
import { sheetsApi } from '@opptra/integrations-google';

const todayTab = () => {
  const d = new Date();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${String(d.getDate()).padStart(2, '0')} ${mon}`;
};

export function makeSheetPipeline(uc, cfg = {}, google = null) {
  const sheetId = cfg.MASTER_SHEET_ID;
  const masterTab = cfg.MASTER_TAB || 'Master';
  const soCol = cfg.MASTER_SO_COL || 'A';

  const notReady = () => {
    if (!google) return 'Google Sheets is not connected on the server yet.';
    if (!sheetId) return 'MASTER_SHEET_ID is not set.';
    if (!cfg.WAYPOINT_BASE_URL) return 'Waypoint API is not configured.';
    return null;
  };

  // Waypoint CREATED sale orders (CSV export). Cookie-auth, per the proven b2b path.
  async function waypointCreatedSOs() {
    const url = `${cfg.WAYPOINT_BASE_URL.replace(/\/+$/, '')}/api/export/sales-orders?type=summary&format=csv`;
    const res = await fetch(url, { headers: cfg.WAYPOINT_COOKIE ? { Cookie: cfg.WAYPOINT_COOKIE } : {} });
    if (!res.ok) throw new Error(`Waypoint export failed (HTTP ${res.status})`);
    const rows = parseCsv(await res.text());
    // Expect a header with an SO/GP number column and a status column.
    const soKey = findKey(rows[0], ['so number', 'gp number', 'sale order', 'so']);
    const stKey = findKey(rows[0], ['status', 'order status']);
    return rows.filter((r) => !stKey || /created/i.test(r[stKey] || '')).map((r) => ({ so: String(r[soKey] || '').trim(), row: r })).filter((x) => x.so);
  }

  async function masterSOset() {
    const vals = await sheetsApi.read(google.sheets, sheetId, `${masterTab}!${soCol}2:${soCol}`);
    return new Set(vals.flat().map((v) => String(v || '').trim()).filter(Boolean));
  }

  async function firstFill() {
    const err = notReady(); if (err) return { ok: false, error: err };
    const created = await waypointCreatedSOs();
    const inMaster = await masterSOset();
    const missing = created.filter((c) => !inMaster.has(c.so));
    const tab = todayTab();
    if (missing.length) {
      await sheetsApi.append(google.sheets, sheetId, `${tab}!A1`, missing.map((m) => [m.so, new Date().toISOString().slice(0, 10)]));
    }
    return { ok: true, summary: `${missing.length} new order(s) written to ${tab}`, counts: { waypoint: created.length, alreadyInMaster: created.length - missing.length, written: missing.length } };
  }

  async function secondFill() {
    const err = notReady(); if (err) return { ok: false, error: err };
    const tab = todayTab();
    const rows = await sheetsApi.read(google.sheets, sheetId, `${tab}!A2:D`);
    let enriched = 0;
    for (let i = 0; i < rows.length; i++) {
      const so = String(rows[i][0] || '').trim();
      if (!so || rows[i][2]) continue; // has invoice already
      const d = await uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: so }).catch(() => null);
      const p = (d?.shippingPackages || []).find((x) => x.invoiceCode);
      if (p) {
        await sheetsApi.update(google.sheets, sheetId, `${tab}!C${i + 2}:D${i + 2}`, [[p.invoiceCode, p.trackingNumber || '']]);
        enriched += 1;
      }
    }
    return { ok: true, summary: `${enriched} row(s) enriched with invoice/tracking`, counts: { scanned: rows.length, enriched } };
  }

  async function push() {
    const err = notReady(); if (err) return { ok: false, error: err };
    const tab = todayTab();
    const rows = await sheetsApi.read(google.sheets, sheetId, `${tab}!A2:D`);
    const fresh = rows.filter((r) => String(r[0] || '').trim());
    if (fresh.length) await sheetsApi.append(google.sheets, sheetId, `${masterTab}!A1`, fresh);
    return { ok: true, summary: `${fresh.length} row(s) pushed from ${tab} into ${masterTab}`, counts: { pushed: fresh.length } };
  }

  return { firstFill, secondFill, push };
}

/* ---- tiny CSV helpers ---- */
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const o = {};
    headers.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}
function splitCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
function findKey(rowObj, candidates) {
  const keys = Object.keys(rowObj || {});
  for (const cand of candidates) { const k = keys.find((x) => x.includes(cand)); if (k) return k; }
  return keys[0];
}
