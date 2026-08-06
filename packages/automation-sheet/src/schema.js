// Real B2B-VIEW working-copy schema, ported verbatim from the proven
// b2b-india-automation Apps Script (Config.gs / SheetOps.gs / Waypoint.gs / Mailer.gs).
// Row 1 = ownership colour banner, row 2 = headers, data starts row 3.
// Columns are matched by header NAME, never by fixed letter - the sheet's column
// order is not something this pipeline owns.
export const HEADER_ROW = 2;
export const DATA_START_ROW = 3;
export const SO_HEADER = 'SO/GP Number';

/** { headerName: 1-based column index } from a header row's values. */
export function getHeaderMap(headerRowValues) {
  const map = {};
  (headerRowValues || []).forEach((h, i) => {
    const name = String(h ?? '').trim();
    if (name) map[name] = i + 1;
  });
  return map;
}

export function soColumnIndex(headerMap) {
  if (headerMap[SO_HEADER]) return headerMap[SO_HEADER];
  const k = Object.keys(headerMap).find((h) => /SO\/GP/i.test(h) || /^SO\b/i.test(h));
  if (!k) throw new Error('Cannot find SO/GP Number column');
  return headerMap[k];
}

export const colLetter = (n) => {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** Row object -> full-width row array placed at the right columns for this sheet's header map. */
export function objectToRow(headerMap, obj, width) {
  const row = new Array(width).fill('');
  for (const [header, value] of Object.entries(obj)) {
    if (header.startsWith('_')) continue;
    const col = headerMap[header];
    if (col) row[col - 1] = value ?? '';
  }
  return row;
}

/* ---------------------------- SO normalization --------------------------- */
// SO01163 / SO-01163 / so 01163 -> SO01163
export const soNorm = (s) => String(s || '').trim().toUpperCase().replace(/[\s_-]/g, '');

export function soMatch(a, b) {
  const x = soNorm(a); const y = soNorm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.replace(/^SO/, '') === y.replace(/^SO/, '') && (x.startsWith('SO') || y.startsWith('SO'));
}

// SO code variants to try against UC - same as engine/_so_candidates.
export function soCandidates(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const out = [s];
  const up = s.toUpperCase().replace(/\s+/g, '');
  if (!out.includes(up)) out.push(up);
  const m = s.match(/SO\s*-?\s*\d+/i);
  if (m) {
    const so = m[0].replace(/\s+/g, '').replace(/SO-/i, 'SO').toUpperCase();
    if (!out.includes(so)) out.push(so);
  }
  if (/^OPT-SO-/i.test(up) && !out.includes(up)) out.push(up);
  return out;
}

/* ------------------------------ Waypoint -> Phase 1 ------------------------------ */
const MARKETPLACE_MAP = {
  AMAZON_B2B: 'AZ Etrade', AMAZON: 'Amazon FBA', AMAZON_FBA: 'Amazon FBA',
  ZEPTO_B2B: 'Zepto', ZEPTO: 'Zepto', FLIPKART_B2B: 'Flipkart Alpha',
  BLINKIT_B2B: 'Blinkit', BLINKIT: 'Blinkit', INSTAMART_B2B: 'Instamart', INSTAMART: 'Instamart',
  RELIANCE_AJIO_SOR_B2B: 'AJIO', AJIO: 'AJIO', COCOBLU: 'cocoblu',
  BIGBASKET_B2B_SOR: 'BigBasket', BIGBASKET_B2B: 'BigBasket', BIGBASKET: 'BigBasket',
};

// Flexible matchers: accept legacy sheet spellings (Coco Blue, Cocoa Blue, ClickTag, …)
// while canonical display labels stay cocoblu / clickTech.
const RE_COCOBLU = /COCO\s*A?\s*BLU|COCOBLU/i;
const RE_CLICKTECH = /CLICK\s*TECH|CLICKTECH|CLICK\s*TAG|CLICKTAG/i;

export function mapMarketplaceDropdown(raw) {
  const v = String(raw || '').trim();
  if (!v) return v;
  if (MARKETPLACE_MAP[v]) return MARKETPLACE_MAP[v];
  const u = v.toUpperCase();
  if (MARKETPLACE_MAP[u]) return MARKETPLACE_MAP[u];
  // Waypoint Customer codes (customer_code) are the real marketplace signal for Amazon
  // family and several 1P channels — match those before falling back to the raw string.
  if (/AJIO/i.test(v)) return 'AJIO';
  if (/ZEPTO|B2B0000\d/i.test(v)) return 'Zepto';
  if (/BLINKIT/i.test(v)) return 'Blinkit';
  if (/INSTAMART|SWIGGY/i.test(v)) return 'Instamart';
  if (/BIGBASKET|BIG_BASKET|Big_Basket/i.test(v)) return 'BigBasket';
  if (/FLIPKART/i.test(v) && /FBF/i.test(v)) return 'Flipkart FBF';
  if (/FLIPKART/i.test(v)) return 'Flipkart Alpha';
  if (RE_COCOBLU.test(v)) return 'cocoblu';
  if (/KKOC/i.test(v)) return 'AZ KKOC';
  if (/ETRADE/i.test(v)) return 'AZ Etrade';
  if (RE_CLICKTECH.test(v)) return 'clickTech';
  if (/RETAILEZ/i.test(v)) return 'AZ RetailEZ';
  if (/FBA/i.test(v)) return 'Amazon FBA';
  if (/AMAZON/i.test(v) || /^AZ\b/i.test(v)) return 'AZ Etrade';
  if (/SHOPPERS?STOP/i.test(v)) return 'Shoppersstop';
  return v;
}

/**
 * What goes in the B2B Marketplace column.
 * Amazon-family customers collapse to short labels ops use day-to-day; Swiggy/Flipkart
 * similarly. Everything else stays the Waypoint customer name as-is.
 */
export function marketplaceLabelFromCustomer(customer, channel = '') {
  const c = String(customer || '').trim();
  const ch = String(channel || '').trim();
  const src = `${c} ${ch}`.trim();
  if (!src) return '';

  // Amazon UCB family — only these four short names
  if (/ETRADE/i.test(src)) return 'E-Trade';
  if (/KKOC/i.test(src)) return 'KKOC';
  if (RE_COCOBLU.test(src)) return 'cocoblu';
  if (RE_CLICKTECH.test(src)) return 'clickTech';

  // Channel short names (match customer or marketplace channel)
  if (/SWIGGY|INSTAMART/i.test(src)) return 'Swiggy';
  if (/FLIPKART/i.test(src)) return 'Flipkart';

  // Prefer the customer name when we have it; otherwise a readable channel fallback.
  if (c) return c;
  return mapMarketplaceDropdown(ch);
}

export function mapOverallStatus(soStatus) {
  const s = String(soStatus || '').toUpperCase();
  if (s === 'CREATED' || s === 'PROCESSING') return 'Pickup Pending';
  if (s === 'DELIVERED') return 'Delivered';
  if (s === 'CANCELLED') return 'Pre-dispatch cancelled';
  return s || '';
}

function firstBrand(s) {
  const t = String(s || '').trim();
  return t ? t.split(',')[0].trim() : '';
}

// Accepts an already-parsed Date, an ISO-ish string, or "dd Mon yyyy" style text.
// Returns an ISO yyyy-MM-dd string (or '' / the raw text if unparseable) - the REST
// API writes plain values, not Apps Script Date objects, so a stable string is safer
// than relying on Sheets to infer a date from ambiguous text.
export function parseFlexibleDate(v) {
  if (v === null || v === undefined || v === '') return '';
  // node-postgres already returns timestamp columns as real Date objects - use directly
  // rather than round-tripping through Date's default toString() and re-parsing it.
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  const m = s.match(/(\d{1,2})[/\-\s]([A-Za-z]{3,9})[/\-\s](\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
    d = new Date(`${m[1]} ${m[2]} ${yr}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return s;
}

/** Waypoint so-summary export row -> B2B-VIEW Phase-1 headers (Config.gs phase1Mapper_). */
export function phase1Mapper(wpRow, cfg = {}) {
  // Marketplace column: Amazon family → E-Trade / KKOC / cocoblu / clickTech;
  // Swiggy / Flipkart short names; everything else = Waypoint customer name as-is.
  const customer = String(
    wpRow['Customer'] || wpRow['customer'] || wpRow['Customer Code']
    || wpRow['customer_code'] || '',
  ).trim();
  const channel = String(wpRow['Marketplace'] || wpRow['marketplace'] || '').trim();
  const marketplace = marketplaceLabelFromCustomer(customer, channel);

  let typeOfSales = wpRow['Type of Sales'] || '';
  if (!typeOfSales) {
    const typeHint = mapMarketplaceDropdown(channel) || marketplace;
    if (/FBA/i.test(typeHint)) typeOfSales = 'FBA';
    else if (/FBF/i.test(typeHint)) typeOfSales = 'FBF';
    else typeOfSales = cfg.defaultTypeOfSales || '1P';
  }
  let brand = firstBrand(wpRow['Brand(s)'] || wpRow['Brand'] || '');
  if (brand.replace(/\s+/g, '').toLowerCase() === 'jack&jones') brand = 'Jack & Jones';

  // Origin City must NOT be filled with the warehouse code — Pickup Wh Name already
  // holds that. Only keep a distinct city value if one was supplied explicitly.
  const origin = String(wpRow['Origin City'] || '').trim();
  const warehouse = String(wpRow['Warehouse'] || wpRow['Pickup Wh Name'] || '').trim();
  const originCity = origin && origin !== warehouse ? origin : '';

  return {
    Category: wpRow['Category'] || cfg.defaultCategory || 'HARDLINES',
    'Forward / Reverse': wpRow['Forward / Reverse'] || cfg.defaultForward || 'Forward',
    'Type of Sales': typeOfSales,
    Marketplace: marketplace,
    Brand: brand,
    'PO / RPO / Gatepass Number': wpRow['PO Code'] || wpRow['PO / RPO / Gatepass Number'] || '',
    'Invoice/Consignment Note': wpRow['Invoice/Consignment Note'] || '',
    'SO/GP Number': wpRow['SO Code'] || wpRow['SO/GP Number'] || '',
    'PO / RPO Quantity': wpRow['Total Units'] || wpRow['PO / RPO Quantity'] || '',
    'PO / Invoice Value Total': wpRow['SO Value'] || wpRow['PO / Invoice Value Total'] || '',
    'PO / RPO Received Date': parseFlexibleDate(wpRow['Created Date'] || wpRow['PO / RPO Received Date'] || ''),
    'Invoice Qty': wpRow['Invoice Qty'] || '',
    'Pickup Wh Name': wpRow['Warehouse'] || wpRow['Pickup Wh Name'] || '',
    'Origin City': originCity,
    'Destination City': wpRow['Ship-to City'] || wpRow['Ship-to'] || wpRow['Destination City'] || '',
    'Appointment Date / EDD': parseFlexibleDate(wpRow['Appt Date'] || wpRow['Appointment Date / EDD'] || ''),
    'Appointment ID': wpRow['Appt ID'] || wpRow['Appointment ID'] || '',
    'Overall Status': mapOverallStatus(wpRow['SO Status'] || wpRow['Overall Status'] || ''),
  };
}

// Waypoint.gs normalizeWaypointRow_ - fills the aliases phase1Mapper_ reads from.
export function normalizeWaypointRow(r) {
  const out = {};
  for (const k of Object.keys(r)) out[String(k).replace(/^﻿/, '').trim()] = r[k];
  if (!out['SO Code'] && out['SO/GP Number']) out['SO Code'] = out['SO/GP Number'];
  if (!out['PO Code'] && out['PO / RPO / Gatepass Number']) out['PO Code'] = out['PO / RPO / Gatepass Number'];
  if (!out['Warehouse'] && out['Pickup Wh Name']) out['Warehouse'] = out['Pickup Wh Name'];
  if (!out['Ship-to City'] && out['Destination City']) out['Ship-to City'] = out['Destination City'];
  if (!out['Brand(s)'] && out['Brand']) out['Brand(s)'] = out['Brand'];
  if (!out['Total Units'] && out['PO / RPO Quantity']) out['Total Units'] = out['PO / RPO Quantity'];
  if (!out['SO Value'] && out['PO / Invoice Value Total']) out['SO Value'] = out['PO / Invoice Value Total'];
  if (!out.Customer && (out['Customer Code'] || out.customer_code || out.customer)) {
    out.Customer = out['Customer Code'] || out.customer_code || out.customer;
  }
  return out;
}

/* --------------------------------- CSV --------------------------------- */
// Case-preserving (Waypoint's real headers, e.g. "SO Code", "SO Status", matter as-is).
export function parseWaypointCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.replace(/^﻿/, '').trim());
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = cells[i]; });
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
