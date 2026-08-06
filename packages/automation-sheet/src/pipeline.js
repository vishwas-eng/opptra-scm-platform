// Sheet update (A1) - the source-vlookup model, per the product owner's spec:
//
//   The READ-ONLY ops source sheet ("B2B-VIEW-INDIA") is the reference truth for Master.
//   first-fill  : ALL Waypoint orders - every status, no view filter - are looked up
//                 against our MASTER tab; anything Master does not have yet (and that is
//                 not already on a date tab) lands on TODAY'S date tab. Date tabs are
//                 permanent - never cleared. Typed SO numbers are additive on top of the
//                 sweep and come straight from Unicommerce, warehouse included, which is
//                 how an order Waypoint has not published yet still reaches the sheet.
//   second-fill : give it SO numbers and each one is topped up with its Unicommerce
//                 invoice data (invoice, tracking, transporter, status, destination). An SO
//                 on no date tab is FIRST FILLED from Unicommerce onto a fresh date tab and
//                 then enriched, so it never depends on the first fill having been run by
//                 hand. With no SO numbers it sweeps the date tabs for rows still missing an
//                 invoice. Master is never patched.
//   push        : manual action - copy today's tabs into our Master (dedup by SO).
//   sync-source : hourly + button - our Master is rewritten as an EXACT replica of the
//                 source B2B View MasterSheet (banner/headers kept; data block replaced).
//                 Date-tab rows are not mixed in - a human copies those into the source.
//
// Sheet layout facts: row 1 banner, row 2 headers, data from row 3; columns are
// found by header NAME, never position. Google Sheets client is INJECTED.
import { sheetsApi, a1 } from '@opptra/integrations-google';
import { makeUcOrderLookup } from '@opptra/uc-client';
import {
  HEADER_ROW, DATA_START_ROW, SO_HEADER,
  getHeaderMap, soColumnIndex, colLetter, objectToRow,
  soNorm, soCandidates,
  phase1Mapper, normalizeWaypointRow, parseWaypointCsv,
} from './schema.js';
import { fetchSOsFromNeon } from './waypointDb.js';

function istToday() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })
    .formatToParts(new Date());
  const day = parts.find((p) => p.type === 'day').value;
  const mon = parts.find((p) => p.type === 'month').value;
  const yr = parts.find((p) => p.type === 'year').value;
  return `${day}-${mon}-${yr}`; // legacy dateTabName_ format, e.g. "24-Jul-2026"
}

// Operator-typed SO input for the second fill: an array, or one blob of text pasted
// from anywhere (newlines, commas, semicolons, spaces all separate).
function parseSoInput(input = {}) {
  const raw = input.saleOrders ?? input.saleOrder ?? input.sos ?? [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  const out = []; const seen = new Set();
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const key = soNorm(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Do NOT invent Brand from the warehouse code (Opp_WIQ_MH_1 → "WIQ"). WIQ/RSG/EKT are
// 3PL / facility tokens, not product brands. Brand stays blank until Waypoint or a
// later enrich has a real brand_name, ops can fill the cell if needed.
export function ucOrderToWaypointRow(o) {
  return {
    'SO Code': o.so || '',
    'PO Code': o.po || '',
    Marketplace: o.channel || '',
    Customer: o.customer || o.customerCode || '',
    'Brand(s)': o.brand || '',
    Warehouse: o.facility || '',
    'Ship-to City': o.city || '',
    'Total Units': o.units || '',
    'SO Value': o.value || '',
    'Created Date': o.orderedAt || '',
    'SO Status': o.status || '',
    'Appt ID': o.appointmentId || '',
  };
}

const DEFAULT_FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];
const INVOICE_HEADERS = ['Invoice/Consignment Note', 'Invoice'];
const DATE_TAB_RE = /^\d{2}-[A-Za-z]{3}-\d{4}(_\d+)?$/;

export function makeSheetPipeline(uc, cfg = {}, google = null, deps = {}) {
  const fetchWaypointSOs = deps.fetchSOsFromNeon || deps.fetchCreatedSOsFromNeon || fetchSOsFromNeon;
  const sheetId = cfg.MASTER_SHEET_ID;
  let masterTab = cfg.MASTER_TAB || 'Master';
  const sourceId = cfg.SOURCE_SHEET_ID;
  const sourceTab = cfg.SOURCE_MASTER_TAB || 'MasterSheet';
  const facilities = [...new Set([...DEFAULT_FACILITIES, ...String(cfg.UC_ASN_FACILITIES || '').split(',').map((s) => s.trim()).filter(Boolean)])];
  const maxSos = cfg.SHEET_ENRICH_MAX_SOS || 200;
  // Resolves an SO straight from Unicommerce (fields + pickup warehouse) for orders
  // Waypoint has not published yet. Shared by both fills so one facility hop per SO is
  // reused across them.
  const ucOrders = deps.ucOrders || makeUcOrderLookup(uc, { preferFacilities: facilities });

  const notReady = () => {
    if (!google) return 'Google Sheets is not connected on the server yet.';
    if (!sheetId) return 'MASTER_SHEET_ID is not set.';
    return null;
  };
  const notReadyForFirstFill = () => notReady()
    || (!cfg.WAYPOINT_DB_URL && !cfg.WAYPOINT_BASE_URL ? 'Waypoint is not configured (need WAYPOINT_DB_URL or WAYPOINT_BASE_URL).' : null);

  /* ---------------------- the master tab, as ops keeps it ---------------------- */
  // Ops renames this tab. It was recently rebuilt as an IMPORTRANGE mirror named Master_IR
  // and then renamed back to Master, and while the configured name did not exist EVERY fill
  // died on "Could not read Master". A tab rename should not take the automation down, so
  // the configured name is a preference and these are the names we accept in its place.
  const MASTER_TAB_CANDIDATES = ['Master_IR', 'Master', 'MasterSheet'];
  let masterResolved = false;
  async function resolveMasterTab() {
    if (masterResolved) return masterTab;
    try {
      const tabs = await sheetsApi.listTabs(google.sheets, sheetId);
      if (!tabs.includes(masterTab)) {
        const alt = [cfg.MASTER_TAB, ...MASTER_TAB_CANDIDATES].find((t) => t && tabs.includes(t));
        if (alt) masterTab = alt;
      }
      masterResolved = true;
    } catch { /* leave the configured name; the caller reports the read failure */ }
    return masterTab;
  }

  // Is the master tab a live IMPORTRANGE mirror of the ops source? Ops switched it to one
  // so that it refreshes itself, and that changes what we may do with it: everything from
  // A1 down is ONE spilled formula result, so writing any cell inside it replaces the
  // formula with #REF! and kills the mirror for everybody. The actions that used to write
  // to Master have to refuse rather than "succeed" by destroying the refresh.
  let mirrorCache;
  async function masterIsMirror() {
    if (mirrorCache !== undefined) return mirrorCache;
    try {
      const cells = await sheetsApi.readFormulas(google.sheets, sheetId, a1(masterTab, 'A1:D3'));
      mirrorCache = cells.flat().some((c) => /IMPORTRANGE\s*\(/i.test(String(c ?? '')));
    } catch { mirrorCache = false; }
    return mirrorCache;
  }
  const mirrorRefusal = (action) => ({
    ok: false,
    mirror: true, // lets the scheduled sync log "nothing to do" instead of an error

    error: `"${masterTab}" is a live IMPORTRANGE mirror of the source sheet, so ${action} is not needed `
      + 'and would break it: the tab is one spilled formula, and writing into it replaces that formula '
      + 'with #REF! and stops the auto-refresh. Master keeps itself in sync now. To get date-tab rows '
      + 'into Master, paste them into the SOURCE sheet - the mirror brings them back on its own.',
  });

  /* ------------------------------ sheet reads ------------------------------ */
  async function readSheet(tab, spreadsheetId = sheetId) {
    const values = await sheetsApi.read(google.sheets, spreadsheetId, a1(tab, `A${HEADER_ROW}:ZZ`));
    const headerMap = getHeaderMap(values[0] || []);
    const dataRows = values.slice(1);
    return { headerMap, dataRows, width: Math.max(...Object.values(headerMap), 1) };
  }

  function rowToObject(headerMap, row) {
    const obj = {};
    for (const [header, col] of Object.entries(headerMap)) obj[header] = row[col - 1] ?? '';
    return obj;
  }

  // Master's SO numbers only. It is a ~29k-row mirror of the whole ops sheet, and the fill
  // needs exactly one column of it, so read that column rather than dragging ~2M cells over
  // the wire on every run.
  async function masterSoKeys() {
    const header = await sheetsApi.read(google.sheets, sheetId, a1(masterTab, `A${HEADER_ROW}:ZZ${HEADER_ROW}`));
    const col = soColOf(masterTab, getHeaderMap(header[0] || []));
    const letter = colLetter(col);
    const values = await sheetsApi.read(google.sheets, sheetId, a1(masterTab, `${letter}${DATA_START_ROW}:${letter}`));
    const keys = new Set();
    for (const row of values) {
      const so = String(row?.[0] ?? '').trim();
      if (so) keys.add(soNorm(so));
    }
    return keys;
  }

  function soColOf(tab, headerMap) {
    try { return soColumnIndex(headerMap); }
    catch {
      throw new Error(`The "${tab}" tab's row ${HEADER_ROW} has no "SO/GP Number" column header. `
        + `That row must hold the column labels - if it shows order data instead, the sheet layout is damaged: `
        + `open the sheet, use File > Version history, and restore the last good version.`);
    }
  }

  const hasContent = (row) => (row || []).some((c) => String(c ?? '').trim() !== '');

  async function listDateTabs() {
    const tabs = await sheetsApi.listTabs(google.sheets, sheetId);
    return { all: tabs, dateTabs: tabs.filter((t) => DATE_TAB_RE.test(t)) };
  }

  // New date tabs get Master's banner + header rows with FULL formatting (colours,
  // bold, column widths, frozen rows) - not just values. Ops reads the colours as
  // ownership markers; an unstyled tab is a bug, not a nicety.
  //
  // Also repair EXISTING tabs whose row-2 headers were wiped or overwritten with order
  // data (manual edits, a failed prior clone while Master IMPORTRANGE was still loading).
  // Without this, second-fill / append die with "row 2 has no SO/GP Number column" even
  // though Master is fine and the tab only needs its header block restored.
  async function ensureDateTab(tab) {
    const created = await sheetsApi.ensureTab(google.sheets, sheetId, tab);
    let needsHeaders = created;
    if (!needsHeaders) {
      try {
        const { headerMap } = await readSheet(tab);
        soColumnIndex(headerMap);
      } catch {
        needsHeaders = true;
      }
    }
    if (needsHeaders) {
      await sheetsApi.cloneHeaderFormatting(google.sheets, sheetId, masterTab, tab, HEADER_ROW);
      // Confirm Master actually rendered usable headers (IMPORTRANGE can briefly be empty).
      try {
        const { headerMap } = await readSheet(tab);
        soColumnIndex(headerMap);
      } catch {
        throw new Error(
          `Could not restore headers on "${tab}" from "${masterTab}". `
          + `Check that Master row ${HEADER_ROW} still has an "SO/GP Number" column `
          + `(IMPORTRANGE may still be loading, retry in a minute).`,
        );
      }
    }
    return created;
  }

  // Dedup by SO against the target sheet, then write at the row right after the LAST
  // row that has an SO. Both naive alternatives corrupted the real sheet: Google's
  // append treated the empty banner cell A1 as an empty table and overwrote the
  // headers, and the legacy first-empty-cell scan landed in a mid-data gap. Below the
  // data also sit thousands of leftover formula cells that make "last non-empty row"
  // lie. Last-SO-row + 1 can only ever overwrite rows that hold no orders.
  async function appendMappedRows(tab, rowObjects) {
    if (!rowObjects.length) return { written: 0, skipped: 0 };
    const { headerMap, dataRows, width } = await readSheet(tab);
    const soCol = soColOf(tab, headerMap);
    const existing = new Set(dataRows.map((r) => String(r[soCol - 1] || '').trim()).filter(Boolean));
    const matrix = []; let skipped = 0;
    const seen = new Set();
    for (const obj of rowObjects) {
      const so = String(obj[SO_HEADER] || '').trim();
      if (!so || existing.has(so) || seen.has(so)) { skipped++; continue; }
      seen.add(so);
      matrix.push(objectToRow(headerMap, obj, Math.max(width, Object.keys(headerMap).length)));
    }
    if (matrix.length) {
      let lastSo = HEADER_ROW;
      dataRows.forEach((r, i) => { if (String(r[soCol - 1] || '').trim()) lastSo = HEADER_ROW + 1 + i; });
      const startRow = Math.max(lastSo + 1, DATA_START_ROW);
      await sheetsApi.ensureGridRows(google.sheets, sheetId, tab, startRow + matrix.length - 1);
      await sheetsApi.update(google.sheets, sheetId, a1(tab, `A${startRow}`), matrix);
    }
    return { written: matrix.length, skipped };
  }

  // Patch non-empty fields onto matching rows by SO (never appends, never blanks).
  async function updateRowsBySo(tab, patches) {
    if (!patches.length) return { patchedCells: 0, matched: 0, missed: 0 };
    const { headerMap, dataRows } = await readSheet(tab);
    const soCol = soColOf(tab, headerMap);
    const soToRow = new Map();
    dataRows.forEach((row, i) => {
      const so = String(row[soCol - 1] || '').trim();
      if (so) soToRow.set(soNorm(so), DATA_START_ROW + i);
    });
    const data = []; let matched = 0; let missed = 0;
    for (const patch of patches) {
      const key = String(patch[SO_HEADER] || '').trim();
      const rowNum = key && soToRow.get(soNorm(key));
      if (!rowNum) { missed++; continue; }
      matched++;
      for (const [header, value] of Object.entries(patch)) {
        if (header.startsWith('_') || header === SO_HEADER) continue;
        if (value === null || value === undefined || value === '') continue;
        const col = headerMap[header];
        if (!col) continue;
        data.push({ range: a1(tab, `${colLetter(col)}${rowNum}`), values: [[value]] });
      }
    }
    if (data.length) await sheetsApi.batchUpdateValues(google.sheets, sheetId, data);
    return { patchedCells: data.length, matched, missed };
  }

  /* ------------------------------- Waypoint ------------------------------- */
  // Waypoint's own Neon Postgres - direct SQL, no session to babysit. The CSV export
  // stays only as a fallback when the DB isn't configured. NO status filter on either
  // path: whichever Waypoint view/filter the export came from, every order it lists is
  // taken (CREATED, PROCESSING, DISPATCHED, ...).
  async function waypointRows() {
    if (cfg.WAYPOINT_DB_URL) return fetchWaypointSOs(cfg.WAYPOINT_DB_URL);
    const url = `${cfg.WAYPOINT_BASE_URL.replace(/\/+$/, '')}/api/export/sales-orders?type=summary&format=csv`;
    const res = await fetch(url, { headers: cfg.WAYPOINT_COOKIE ? { Cookie: cfg.WAYPOINT_COOKIE } : {} });
    if (!res.ok) throw new Error(`Waypoint export failed (HTTP ${res.status})`);
    return parseWaypointCsv(await res.text()).map(normalizeWaypointRow);
  }

  /* --------------------------------- UC ---------------------------------- */
  async function packagesAcrossFacilities(so, preferFacility) {
    const order = [...new Set([preferFacility, ...facilities].filter(Boolean))];
    for (const facility of order) {
      for (const code of soCandidates(so)) {
        const d = await uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: code }, { facility })
          .catch((e) => { if (e?.name === 'SessionError') throw e; return null; });
        const pkgs = d?.shippingPackages || [];
        if (pkgs.length) return { packages: pkgs, facility };
      }
    }
    return { packages: [], facility: preferFacility || order[0] || null };
  }

  async function fetchSummaryFields(so, facility) {
    for (const code of soCandidates(so)) {
      const d = await uc.data('/data/oms/saleorder/fetchSummary', { code }, { facility })
        .catch((e) => { if (e?.name === 'SessionError') throw e; return null; });
      const summary = d?.saleOrderSummary || d || {};
      if (summary.status || summary.statusCode) {
        const addr = summary.shippingAddress || summary.address || {};
        return {
          status: summary.status || summary.statusCode,
          city: addr.city || '',
          pincode: addr.pincode || addr.pinCode || '',
        };
      }
    }
    return null;
  }

  async function fetchInvoiceCodeFallback(so, facility) {
    for (const code of soCandidates(so)) {
      const d = await uc.data('/data/oms/saleorder/fetchInvoiceDetails', { saleOrderCode: code }, { facility })
        .catch((e) => { if (e?.name === 'SessionError') throw e; return null; });
      const invoices = d?.invoices || [];
      const clean = invoices.find((iv) => !/^(ISR|CN)/i.test(String(iv.code || iv.invoiceCode || '')));
      const pick = clean || invoices[0];
      if (pick) return pick.code || pick.invoiceCode || '';
    }
    return '';
  }

  // Port of DailySync.gs enrichSoFromUc_ - the full second-fill field set.
  async function enrichSoFromUc(so, preferFacility) {
    const { packages, facility } = await packagesAcrossFacilities(so, preferFacility);
    let invCode = ''; let tracking = ''; let transporter = ''; let dispatchType = ''; let ewbNo = ''; let invQty = 0;
    for (const p of packages) {
      invCode = invCode || p.invoiceCode || p.invoiceDisplayCode || '';
      tracking = tracking || p.trackingNumber || p.trackingNo || '';
      transporter = transporter || p.shippingProviderCode || p.shippingProvider || p.shippingCourier || '';
      dispatchType = dispatchType || p.shippingMethodCode || p.shippingMethod || '';
      ewbNo = ewbNo || p.ewbNo || p.ewayBillNumber || '';
      const items = p.shippingPackageLineItems || p.shippingPackageItems || p.items || [];
      const q = items.reduce((sum, it) => sum + (Number(it.quantity || it.qty) || 0), 0);
      if (q > invQty) invQty = q;
      if (!invQty && p.noOfItems) invQty = Number(p.noOfItems) || 0;
    }
    if (!invCode) invCode = await fetchInvoiceCodeFallback(so, facility);

    const summary = await fetchSummaryFields(so, facility);
    const out = { [SO_HEADER]: so };
    if (invCode) { out['Invoice/Consignment Note'] = invCode; out['Invoice'] = invCode; }
    if (tracking) { out['Tracking number'] = tracking; out['Tracking No'] = tracking; }
    if (transporter) out['Transporter'] = transporter;
    if (dispatchType) out['Dispatch type'] = dispatchType;
    if (invQty) out['Invoice Qty'] = invQty;
    if (ewbNo) { out['E-Way Bill No'] = ewbNo; out['Eway Bill No'] = ewbNo; out['EWB No'] = ewbNo; }
    if (summary?.status) out['Overall Status'] = summary.status;
    if (summary?.city) out['Destination City'] = summary.city;
    if (summary?.pincode) out['Destination Pincode'] = summary.pincode;
    return out;
  }

  /* ------------------------------ source sheet ------------------------------ */
  async function readSource() {
    const values = await sheetsApi.read(google.sheets, sourceId, a1(sourceTab, `A${HEADER_ROW}:ZZ`));
    const headerMap = getHeaderMap(values[0] || []);
    const soCol = soColOf(`source ${sourceTab}`, headerMap);
    return { headerMap, soCol, dataRows: values.slice(1) };
  }

  /* --------------------- shared first-fill machinery --------------------- */
  // Typed SOs resolved straight from Unicommerce into first-fill rows. BOTH fills go
  // through this, so an order added by either one lands identical - same mapper, same
  // warehouse resolution, no second dialect of first-fill row.
  async function ucFirstFillRows(soList) {
    const rows = [];
    const notInUc = [];
    for (const so of soList) {
      const order = await ucOrders.resolveOrder(so);
      if (!order) { notInUc.push(so); continue; }
      rows.push(phase1Mapper(normalizeWaypointRow(ucOrderToWaypointRow(order)), cfg));
    }
    return { rows, notInUc };
  }

  // The tab a new batch belongs on: today's base tab while it is still fresh, else the
  // next free _n in today's family. Ops reads one tab as one batch, so a run that writes
  // rows opens its own tab instead of mixing into one that already holds a batch.
  async function freshDateTab(tabs) {
    const base = istToday();
    let target = base;
    if ((tabs || []).includes(base)) {
      const { dataRows } = await readSheet(base);
      if (dataRows.some(hasContent)) {
        let n = 1;
        while (tabs.includes(`${base}_${n}`)) {
          const { dataRows: d } = await readSheet(`${base}_${n}`);
          if (!d.some(hasContent)) break;
          n++;
        }
        target = `${base}_${n}`;
      }
    }
    await ensureDateTab(target);
    return target;
  }

  /* ------------------------------- pipeline steps ------------------------------- */
  // First fill: EVERY Waypoint order (any status) vs our MASTER (vlookup). Anything
  // Master does not already have (and that is not already on a date tab) lands on
  // TODAY'S date tab. Sync-from-source is a separate button - it rewrites Master as a
  // replica of the main B2B View sheet. First fill does not touch Master.
  //
  // Typed SO numbers are ADDITIVE: the Waypoint sweep still runs, and each typed SO is
  // resolved straight from Unicommerce on top of it. That covers the case this whole
  // entry point exists for - an order Waypoint has not published yet, which therefore
  // reaches neither the date tab nor (later) the packing mail's warehouse lookup.
  async function firstFill(input = {}) {
    const requested = parseSoInput(input);
    // Waypoint config is only a hard requirement when it is the sole source of rows.
    const err = requested.length ? notReady() : notReadyForFirstFill();
    if (err) return { ok: false, error: err };
    await resolveMasterTab();

    // With typed SOs in hand a Waypoint outage must not sink the run: those SOs are the
    // part the operator is actually waiting on, and UC serves them without Waypoint.
    let waypoint = [];
    let waypointError = '';
    if (cfg.WAYPOINT_DB_URL || cfg.WAYPOINT_BASE_URL) {
      try {
        waypoint = await waypointRows();
      } catch (e) {
        if (!requested.length) throw e;
        waypointError = String(e.message || e);
      }
    }
    const phase1 = waypoint.map((r) => phase1Mapper(r, cfg)).filter((o) => o[SO_HEADER]);

    const { rows: fromUc, notInUc } = await ucFirstFillRows(requested);

    // Known SOs = everything already on Master + everything already on any date tab.
    let onMaster;
    try {
      onMaster = await masterSoKeys();
    } catch (e) {
      return { ok: false, error: `Could not read "${masterTab}": ${String(e.message || e)}` };
    }

    const { all: tabs, dateTabs } = await listDateTabs();
    const onDateTabs = new Set();
    for (const t of dateTabs) {
      try {
        const { headerMap, dataRows } = await readSheet(t);
        const col = soColumnIndex(headerMap);
        dataRows.forEach((r) => { const so = String(r[col - 1] || '').trim(); if (so) onDateTabs.add(soNorm(so)); });
      } catch { /* a malformed tab never blocks the fill */ }
    }

    // UC rows first: when a typed SO also appears in the Waypoint sweep, the UC row wins,
    // because that is the one carrying the pickup warehouse we just resolved.
    const bySo = new Map();
    for (const o of [...fromUc, ...phase1]) {
      const key = soNorm(o[SO_HEADER]);
      if (key && !bySo.has(key)) bySo.set(key, o);
    }
    const already = new Set();
    const missing = [...bySo.values()].filter((o) => {
      const key = soNorm(o[SO_HEADER]);
      if (onMaster.has(key) || onDateTabs.has(key)) { already.add(key); return false; }
      return true;
    });

    // Anything the operator asked for by name and did NOT get is reported by name - a
    // typed SO silently doing nothing is the failure mode that sent them here.
    const note = () => {
      const bits = [];
      const dup = requested.filter((s) => already.has(soNorm(s)));
      if (dup.length) bits.push(`already on the sheet: ${dup.join(', ')}`);
      if (notInUc.length) bits.push(`not in Unicommerce: ${notInUc.join(', ')}`);
      if (waypointError) bits.push(`Waypoint unavailable, typed SOs only (${waypointError})`);
      return bits.length ? ` (${bits.join('; ')})` : '';
    };
    const ucDetails = fromUc.map((o) => ({
      so: o[SO_HEADER],
      warehouse: o['Pickup Wh Name'] || '',
      po: o['PO / RPO / Gatepass Number'] || '',
      marketplace: o.Marketplace || '',
      brand: o.Brand || '',
      qty: o['PO / RPO Quantity'] || '',
      destCity: o['Destination City'] || '',
      status: o['Overall Status'] || '',
    }));

    if (!missing.length) {
      return {
        ok: notInUc.length === 0,
        summary: `Everything is up to date - all ${bySo.size} order(s) are already on Master or a date tab.${note()}`,
        counts: {
          waypoint: waypoint.length, requested: requested.length, fromUc: fromUc.length,
          alreadyKnown: already.size, written: 0, onMaster: onMaster.size,
        },
        notInUc,
        details: ucDetails,
      };
    }

    const target = await freshDateTab(tabs);
    const result = await appendMappedRows(target, missing);
    const typedWritten = requested.filter((s) => missing.some((o) => soNorm(o[SO_HEADER]) === soNorm(s)));
    return {
      ok: notInUc.length === 0,
      summary: `${result.written} new order(s) written to ${target}`
        + (requested.length
          ? `, including ${typedWritten.length} of ${requested.length} typed SO(s)`
          : ' (all Waypoint statuses, not already on Master)')
        + `.${note()}`,
      counts: {
        waypoint: waypoint.length, requested: requested.length, fromUc: fromUc.length,
        alreadyKnown: already.size, written: result.written, tab: target, onMaster: onMaster.size,
      },
      notInUc,
      details: ucDetails,
    };
  }

  // Date tabs newest-first, today's family always ahead of older ones.
  function orderDateTabs(dateTabs, base) {
    return [...dateTabs].sort((x, y) => {
      const todayFirst = (t) => (t === base || t.startsWith(`${base}_`) ? 0 : 1);
      if (todayFirst(x) !== todayFirst(y)) return todayFirst(x) - todayFirst(y);
      return Date.parse(y.split('_')[0]) - Date.parse(x.split('_')[0]) || x.localeCompare(y);
    });
  }

  // Every first-fill row on the date tabs, keyed by SO. Carrying the whole row (not just
  // the warehouse) is what lets an operator-supplied SO report its first-fill data next
  // to the invoice data we are about to add. `stopAfterPending` keeps the unattended scan
  // from reading every tab in the sheet once it already has a full batch.
  async function indexDateTabRows(orderedTabs, { stopAfterPending = Infinity } = {}) {
    const index = new Map();
    let pending = 0;
    for (const t of orderedTabs) {
      let sheet;
      try { sheet = await readSheet(t); } catch { continue; }
      let soCol;
      try { soCol = soColumnIndex(sheet.headerMap); } catch { continue; }
      const invCol = sheet.headerMap[INVOICE_HEADERS[0]] || sheet.headerMap[INVOICE_HEADERS[1]];
      const whCol = sheet.headerMap['Pickup Wh Name'];
      for (const row of sheet.dataRows) {
        const so = String(row[soCol - 1] || '').trim();
        if (!so) continue;
        const key = soNorm(so);
        if (index.has(key)) continue; // newest tab wins
        const invoiced = !!(invCol && String(row[invCol - 1] || '').trim());
        index.set(key, {
          so,
          tab: t,
          invoiced,
          warehouse: whCol ? String(row[whCol - 1] || '').trim() : '',
          firstFill: rowToObject(sheet.headerMap, row),
        });
        if (!invoiced) pending++;
      }
      if (pending >= stopAfterPending) break;
    }
    return index;
  }

  // Second fill: enrich DATE TABS only (today's family first, then recent tabs).
  // Master is a mirror of the source and is never patched here.
  //
  // Give it SO numbers and it does exactly those: each SO's invoice data from Unicommerce
  // is written onto its first-fill row - even if that row already carries an invoice,
  // since asking for an SO by name means "refresh it". An SO with no first-fill row gets
  // one first, from Unicommerce, on a fresh date tab, so the second fill never depends on
  // the first having been run by hand. With no SO numbers it keeps the old unattended
  // behaviour: sweep the date tabs and enrich everything still missing an invoice.
  async function secondFill(input = {}) {
    const err = notReady(); if (err) return { ok: false, error: err };
    await resolveMasterTab(); // date tabs are created from its header block
    const requested = parseSoInput(input);
    const base = istToday();
    const { all: tabs, dateTabs } = await listDateTabs();
    if (!dateTabs.length && !requested.length) {
      return { ok: true, summary: 'No date tabs yet - run First fill first.', counts: { scanned: 0, enriched: 0 } };
    }
    const ordered = orderDateTabs(dateTabs, base);
    const index = dateTabs.length
      ? await indexDateTabRows(ordered, requested.length ? {} : { stopAfterPending: maxSos })
      : new Map();

    const notFound = [];
    const offTabs = [];
    let candidates;
    if (requested.length) {
      candidates = [];
      for (const so of requested) {
        const hit = index.get(soNorm(so));
        if (hit) candidates.push(hit);
        else offTabs.push(so);
      }
    } else {
      candidates = [...index.values()].filter((c) => !c.invoiced).slice(0, maxSos);
    }

    // A typed SO on no date tab used to dead-end here with "run First fill first". It no
    // longer does: the second fill does that first fill itself, through the same shared
    // machinery - UC resolution, and the same fresh-tab convention, so a batch created here
    // opens its own date tab exactly as the first-fill button would. Handing over an SO
    // number should not require knowing which fill it needs.
    const createdRows = [];
    let createdTab = '';
    if (offTabs.length) {
      const { rows, notInUc } = await ucFirstFillRows(offTabs);
      notFound.push(...notInUc);
      if (rows.length) {
        createdTab = await freshDateTab(tabs);
        await appendMappedRows(createdTab, rows);
        for (const row of rows) {
          createdRows.push(row[SO_HEADER]);
          candidates.push({
            so: row[SO_HEADER],
            tab: createdTab,
            invoiced: false,
            warehouse: row['Pickup Wh Name'] || '',
            firstFill: row,
          });
        }
      }
    }

    const byTab = new Map();
    const details = [];
    let enriched = 0;
    for (const c of candidates) {
      const patch = await enrichSoFromUc(c.so, c.warehouse);
      const invoice = patch['Invoice/Consignment Note'] || '';
      if (invoice || patch['Overall Status']) enriched++;
      if (!byTab.has(c.tab)) byTab.set(c.tab, []);
      byTab.get(c.tab).push(patch);
      details.push({
        so: c.so,
        tab: c.tab,
        // from the first fill
        marketplace: c.firstFill.Marketplace || '',
        brand: c.firstFill.Brand || '',
        po: c.firstFill['PO / RPO / Gatepass Number'] || '',
        warehouse: c.warehouse,
        // from Unicommerce
        invoice,
        invoiceQty: patch['Invoice Qty'] || '',
        tracking: patch['Tracking number'] || '',
        ewayBill: patch['E-Way Bill No'] || '',
        status: patch['Overall Status'] || '',
      });
    }
    let patchedCells = 0;
    for (const [t, patches] of byTab) patchedCells += (await updateRowsBySo(t, patches)).patchedCells;

    const summary = (() => {
      if (requested.length) {
        let head = `${enriched} of ${requested.length} requested SO(s) enriched on the date tabs`;
        if (createdRows.length) head += `, ${createdRows.length} first filled from Unicommerce onto ${createdTab} first`;
        return notFound.length
          ? `${head}. Not in Unicommerce either: ${notFound.join(', ')}`
          : head;
      }
      return candidates.length === 0
        ? 'Nothing to enrich - every order on the date tabs already has an invoice.'
        : `${enriched} of ${candidates.length} order(s) enriched on the date tabs`;
    })();

    return {
      ok: requested.length ? notFound.length === 0 : true,
      summary,
      requested,
      notFound,
      created: createdRows,
      details,
      counts: {
        requested: requested.length, scanned: candidates.length, enriched, patchedCells,
        notFound: notFound.length, created: createdRows.length,
        ...(createdTab ? { createdTab } : {}),
      },
    };
  }

  // Push: manual copy of today's tabs into Master (dedup). Prefer the human path
  // instead: copy date-tab rows into the main B2B View sheet, then Sync - Master
  // becomes an exact replica of that source. This button is kept for ops who still
  // want a direct Master append.
  async function push() {
    const err = notReady(); if (err) return { ok: false, error: err };
    await resolveMasterTab();
    if (await masterIsMirror()) return mirrorRefusal('pushing rows into it');
    const base = istToday();
    const { dateTabs } = await listDateTabs();
    const todays = dateTabs.filter((t) => t === base || t.startsWith(`${base}_`));
    if (!todays.length) return { ok: true, summary: `No date tab for today (${base}) yet - run First fill first.`, counts: { pushed: 0 } };
    const rows = [];
    for (const t of todays) {
      try { await ensureDateTab(t); } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
      const { headerMap, dataRows } = await readSheet(t);
      const soCol = soColOf(t, headerMap);
      for (const r of dataRows) if (String(r[soCol - 1] || '').trim()) rows.push(rowToObject(headerMap, r));
    }
    const result = await appendMappedRows(masterTab, rows);
    return {
      ok: true,
      summary: result.written === 0
        ? `${masterTab} is already up to date - every order on today's tab(s) is on it.`
        : `${result.written} row(s) copied from ${todays.join(', ')} into ${masterTab} (the date tabs keep their data)`,
      counts: { pushed: result.written, skipped: result.skipped },
    };
  }

  // Mirror the source into our Master as an EXACT row-for-row replica of the source
  // data block. Banner (row 1) + headers (row 2) stay; everything from row 3 is cleared
  // and rewritten. We deliberately do NOT dedupe by SO - the source sheet can (and does)
  // carry the same SO on multiple rows, and collapsing those was why Master showed ~3158
  // while the source had ~3549. Empty-SO rows with other content are kept too.
  async function syncFromSource() {
    const err = notReady(); if (err) return { ok: false, error: err };
    await resolveMasterTab();
    // The mirror does this job now, continuously and without us.
    if (await masterIsMirror()) return mirrorRefusal('syncing it from the source');
    if (!sourceId) return { ok: false, error: 'SOURCE_SHEET_ID is not set.' };
    const src = await readSource();
    const master = await readSheet(masterTab);
    const width = Math.max(master.width, Object.keys(master.headerMap).length, 1);

    const matrix = [];
    let withSo = 0; let blankSkipped = 0;
    for (const srow of src.dataRows) {
      const hasAny = (srow || []).some((c) => String(c ?? '').trim() !== '');
      if (!hasAny) { blankSkipped++; continue; } // trailing / fully empty rows only
      const so = String(srow[src.soCol - 1] || '').trim();
      if (so) withSo++;
      const obj = {};
      for (const [name, col] of Object.entries(src.headerMap)) {
        const v = srow[col - 1];
        if (v !== undefined && v !== null && v !== '') obj[name] = v;
      }
      // Always carry the SO header key even when blank, so column alignment stays stable.
      if (so) obj[SO_HEADER] = so;
      matrix.push(objectToRow(master.headerMap, obj, width));
    }

    // Wipe the Master data block, then write the full source snapshot.
    // Chunk large writes - a single 3k+ row update can time out / hit payload limits.
    await sheetsApi.clear(google.sheets, sheetId, a1(masterTab, `A${DATA_START_ROW}:ZZ`));
    if (matrix.length) {
      await sheetsApi.ensureGridRows(google.sheets, sheetId, masterTab, DATA_START_ROW + matrix.length - 1);
      const CHUNK = 1000;
      for (let i = 0; i < matrix.length; i += CHUNK) {
        const chunk = matrix.slice(i, i + CHUNK);
        await sheetsApi.update(google.sheets, sheetId, a1(masterTab, `A${DATA_START_ROW + i}`), chunk);
      }
    }
    return {
      ok: true,
      summary: matrix.length === 0
        ? `${masterTab} cleared to match an empty source sheet.`
        : `${masterTab} rewritten as an exact replica of the source (${matrix.length} row(s), ${withSo} with an SO).`,
      counts: {
        sourceRows: src.dataRows.length,
        written: matrix.length,
        withSo,
        blankSkipped,
        added: matrix.length,
        refreshedCells: 0,
      },
    };
  }

  return { firstFill, secondFill, push, syncFromSource };
}
