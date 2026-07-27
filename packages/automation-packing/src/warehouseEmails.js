// Warehouse → email directory loaded from the ops Google Sheet (never hardcoded).
// Sheet layout (row 1 headers, data from row 2):
//   Warehouse Name | To | To | To | CC | CC | Finance
// Multiple "To"/"CC" columns are intentional - each warehouse can list several
// recipients. Finance is optional and shown separately so the operator can include
// it only when they want to.
//
// Matching: exact warehouse code first, then case-insensitive, then fuzzy
// (substring either way) so sheet names like OPP_RISINGSCS_MUM_FMCG still resolve
// when the B2B sheet says Opp_RSG_MH-style codes (and vice versa).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function splitEmails(cell) {
  return String(cell ?? '')
    .split(/[\s,;]+|\n+/)
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s));
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** Parse the raw sheet values into { [warehouse]: { to, cc, finance, shortCode, contact } }. */
export function parseWarehouseEmailRows(values) {
  if (!values?.length) return {};
  const header = (values[0] || []).map((h) => String(h ?? '').trim().toLowerCase());
  const whCol = header.findIndex((h) => /warehouse/.test(h));
  if (whCol < 0) return {};

  const toCols = []; const ccCols = []; const financeCols = [];
  header.forEach((h, i) => {
    if (i === whCol) return;
    if (h === 'to' || h.startsWith('to ')) toCols.push(i);
    else if (h === 'cc' || h.startsWith('cc ')) ccCols.push(i);
    else if (/finance/.test(h)) financeCols.push(i);
  });
  // Fallback if headers are blank/odd: after warehouse col, first 3 = To, next 2 = CC, last = Finance
  if (!toCols.length && !ccCols.length) {
    for (let i = whCol + 1; i < header.length; i++) {
      const offset = i - whCol - 1;
      if (offset < 3) toCols.push(i);
      else if (offset < 5) ccCols.push(i);
      else financeCols.push(i);
    }
  }

  const out = {};
  for (const row of values.slice(1)) {
    const warehouse = String(row[whCol] ?? '').trim();
    if (!warehouse) continue;
    const pick = (cols) => uniq(cols.flatMap((c) => splitEmails(row[c])));
    const to = pick(toCols);
    const cc = pick(ccCols);
    const finance = pick(financeCols);
    if (!to.length && !cc.length && !finance.length) continue;
    out[warehouse] = {
      warehouse,
      to,
      cc,
      finance,
      shortCode: shortCodeOf(warehouse),
      contact: contactOf(warehouse, to),
    };
  }
  return out;
}

export function shortCodeOf(warehouse) {
  const parts = String(warehouse || '').split('_').filter(Boolean);
  if (parts.length <= 1) return String(warehouse || '');
  // Opp_RSG_MH → RSG; Opp_WIQ_MH_1 → WIQ; Opp_BSB_HR_1P → BSB
  return parts[1] || parts.slice(1).join('');
}

function contactOf(warehouse, to) {
  const code = shortCodeOf(warehouse);
  if (code) return code;
  const local = String(to[0] || '').split('@')[0];
  return local ? local.split('.')[0].replace(/^./, (c) => c.toUpperCase()) : 'Team';
}

/** Resolve a B2B-sheet warehouse name against the directory (exact → case → fuzzy). */
export function resolveWarehouseEntry(directory, warehouse) {
  const wh = String(warehouse || '').trim();
  if (!wh) return null;
  if (directory[wh]) return directory[wh];
  const low = wh.toLowerCase();
  for (const [k, v] of Object.entries(directory)) {
    if (k.toLowerCase() === low) return v;
  }
  for (const [k, v] of Object.entries(directory)) {
    const kl = k.toLowerCase();
    if (low.includes(kl) || kl.includes(low)) return v;
  }
  return null;
}

/**
 * Read the warehouse-email sheet via the injected Google Sheets client.
 * Returns {} (never throws) when the sheet id is missing or unreadable - callers
 * surface that as "no warehouse email" on the affected SO.
 */
export async function loadWarehouseDirectory(sheets, sheetId, tab = null) {
  if (!sheets || !sheetId) return {};
  try {
    // Prefer an explicit tab; otherwise the first sheet (gid=0 export matches).
    const range = tab ? `'${String(tab).replace(/'/g, "''")}'!A1:Z` : 'A1:Z';
    const { sheetsApi } = await import('@opptra/integrations-google');
    const values = await sheetsApi.read(sheets, sheetId, range);
    return parseWarehouseEmailRows(values);
  } catch {
    return {};
  }
}
