// Download a credit-note PDF from Unicommerce using a bulk return id + facility.
// Proven path (CONTEXT.md): GET /oms/invoice/bulkReturn/show?bulkReturnId=…&legacy=1
// Fallback: fetchBulkReturnSummary → credit-note invoice codes → /oms/invoice/show.
import { validateReverseDcInput } from '@opptra/core/validate';

/** Real PDF only — never trust Content-Type alone (UC returns application/pdf with 0 bytes on bad IDs). */
function isRealPdf(buf) {
  return !!(buf && buf.length > 500 && buf.slice(0, 4).toString() === '%PDF');
}

async function tryBinary(uc, path, facility) {
  const res = await uc.dataBinary(path, { facility }).catch(() => null);
  if (res && isRealPdf(res.buffer)) return res.buffer;
  return null;
}

function pickInvoiceCodes(meta) {
  if (!meta || typeof meta !== 'object') return [];
  const pools = [
    meta.creditNotes, meta.invoices, meta.returnInvoices, meta.creditNoteList,
    meta.invoiceCodes, meta.cirList, meta.data?.creditNotes, meta.data?.invoices,
  ].filter(Boolean);
  const codes = [];
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      for (const x of pool) {
        if (typeof x === 'string') codes.push(x);
        else {
          const c = x?.code || x?.invoiceCode || x?.creditNoteCode || x?.displayCode || x?.invoiceCodeDisplay;
          if (c) codes.push(String(c));
        }
      }
    }
  }
  // Also scan nested objects for invoice-like codes
  const blob = JSON.stringify(meta);
  for (const m of blob.matchAll(/"(?:SR|CN|CIR|RT)[A-Z0-9/_-]{4,}"/gi)) {
    codes.push(m[0].slice(1, -1));
  }
  return [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
}

/**
 * @param {object} uc  uc-client instance
 * @param {string} bulkReturnId
 * @param {string} facility  warehouse / facility code (required - UC is facility-scoped)
 * @returns {Promise<{ pdf: Buffer, creditNoteNo?: string, meta?: object }>}
 */
export async function downloadCnByBulkReturn(uc, bulkReturnId, facility) {
  // Catch typos / multi-IDs before burning UC round-trips (shared with API pre-flight).
  const checked = validateReverseDcInput({ bulkReturnId, facility });
  if (!checked.ok) throw new Error(checked.error);
  const id = checked.bulkReturnId;
  const fac = checked.facility;

  const enc = encodeURIComponent(id);
  // Primary: bulk-return print endpoint (returns the CIR credit note PDF).
  let pdf = await tryBinary(uc, `/oms/invoice/bulkReturn/show?bulkReturnId=${enc}&legacy=1`, fac);
  if (!pdf) pdf = await tryBinary(uc, `/oms/invoice/bulkReturn/show?bulkReturnId=${enc}`, fac);
  if (!pdf) pdf = await tryBinary(uc, `/oms/invoice/bulkReturn?bulkReturnId=${enc}&legacy=1`, fac);

  let creditNoteNo = '';
  let meta = null;
  // Soft resolve: summary often carries the CN invoice code(s) even when the print
  // endpoint needs a hop - also used to label the output file.
  try {
    meta = await uc.data('/data/oms/returns/reversePickup/bulkReturn/fetchSummary', { bulkReturnId: id }, { facility: fac });
    const codes = pickInvoiceCodes(meta);
    if (codes[0]) creditNoteNo = String(codes[0]);
    if (!pdf && codes.length) {
      for (const code of codes) {
        pdf = await tryBinary(uc, `/oms/invoice/show?invoiceCodes=${encodeURIComponent(code)}&legacy=1`, fac);
        if (!pdf) pdf = await tryBinary(uc, `/oms/invoice/show?invoiceCodes=${encodeURIComponent(code)}`, fac);
        if (pdf) { creditNoteNo = String(code); break; }
      }
    }
  } catch { /* summary is best-effort */ }

  if (!isRealPdf(pdf)) {
    throw new Error(
      `Could not download the credit note PDF for bulk return "${id}" at ${fac}. `
      + `Check the Bulk Return ID and warehouse match, and that a credit note exists for it.`,
    );
  }
  return { pdf, creditNoteNo, meta, bulkReturnId: id, facility: fac };
}
