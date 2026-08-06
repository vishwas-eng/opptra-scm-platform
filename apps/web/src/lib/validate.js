// Client-side mirror of packages/core/src/validate.js.
//
// This exists to fail fast in the browser, NOT to be the authority — the server
// re-validates everything. Keep the rules in step with core; when they drift, the
// server's answer is the correct one.

export const SO_RE = /^[A-Za-z0-9/_-]{2,40}$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i;
export const BULK_RETURN_RE = /^BR-?\d{3,}$/i;

const ok = { ok: true };
const fail = (message) => ({ ok: false, message });

export function validateSaleOrder(so, label = 'Sale Order') {
  const v = String(so || '').trim();
  if (!v) return fail(`${label} is required`);
  if (!SO_RE.test(v)) return fail(`${label} "${v}" doesn't look like a sale order code`);
  return ok;
}

export function validateSaleOrderList(list, label = 'Sale Orders') {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return fail(`Enter at least one ${label.toLowerCase().replace(/s$/, '')}`);
  for (const so of items) {
    const r = validateSaleOrder(so, label.replace(/s$/, ''));
    if (!r.ok) return r;
  }
  return ok;
}

export function validateBulkReturnId(id) {
  const v = String(id || '').trim();
  if (!v) return fail('Bulk Return ID is required');
  if (/[\s,;]/.test(v)) {
    return fail('Enter one Bulk Return ID like BR0160 (not multiple, not random text)');
  }
  if (!BULK_RETURN_RE.test(v)) {
    return fail('Enter one Bulk Return ID like BR0160 (not multiple, not random text)');
  }
  return ok;
}

/**
 * E-way rows. The vehicle-number rule is the one that actually bites: GST rejects a
 * ROAD consignment with no vehicle number as error 4011, so catching it here saves a
 * round trip and a confusing upstream code.
 */
export function validateEwayRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return fail('Add at least one row');
  if (list.length > 100) return fail(`Too many rows (${list.length}). Maximum is 100 per run.`);

  for (let i = 0; i < list.length; i += 1) {
    const r = list[i] || {};
    const where = `Row ${i + 1} (${r.so || 'no SO'}):`;
    const so = String(r.so || '').trim();
    if (!so) return fail(`${where} Sale Order is required`);
    if (!SO_RE.test(so)) return fail(`${where} "${so}" doesn't look like a sale order code`);
    const gstin = String(r.gstin || '').trim();
    if (gstin && !GSTIN_RE.test(gstin)) return fail(`${where} GSTIN "${gstin}" is not a valid 15-character GSTIN`);
    const mode = String(r.transMode || 'ROAD').trim().toUpperCase();
    if (mode === 'ROAD' && !String(r.vehicleNo || '').trim()) {
      return fail(`${where} Vehicle number is required for ROAD transport (GST error 4011)`);
    }
  }
  return ok;
}
