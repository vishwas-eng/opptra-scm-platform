// Reverse DC: Bulk Return ID + facility → download CN → PARSE all pages → render
// Uniware-style Delivery Challan. Layout of the source CN no longer matters — we
// rebuild from extracted data (parties + every line item + totals).
import { downloadCnByBulkReturn } from './download.js';
import { parseCreditNote } from './parseCn.js';
import { buildDeliveryChallanHtml, renderDeliveryChallanPdf } from './renderDc.js';
import { editCreditNoteToDeliveryChallan } from './edit.js';

/**
 * Validation gate for the hybrid approach: the rebuilt DC is only used when the
 * parsed line items reconcile against the CN's own printed totals. Returns null
 * when everything checks out, otherwise a human-readable reason to fall back.
 */
export function reconcileParsed(parsed) {
  const lines = parsed?.lines || [];
  if (!lines.length) return 'no line items parsed';

  for (const l of lines) {
    if (!String(l.name || '').trim()) return `row ${l.sr}: product name missing`;
    if (!String(l.qty || '').trim()) return `row ${l.sr}: quantity missing`;
    if (!String(l.amount || '').trim()) return `row ${l.sr}: amount missing`;
  }

  // Serials must be a continuous 1..N run — a gap means we dropped a row.
  for (let i = 0; i < lines.length; i++) {
    if (parseInt(lines[i].sr, 10) !== i + 1) {
      return `serial sequence broken at position ${i + 1} (saw "${lines[i].sr}")`;
    }
  }

  const int = (s) => parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0;
  const num = (s) => parseFloat(String(s).replace(/[^\d.]/g, '')) || 0;

  const totalQty = int(parsed.totals?.totalQty);
  if (totalQty) {
    const qtySum = lines.reduce((t, l) => t + int(l.qty), 0);
    if (qtySum !== totalQty) return `parsed qty sum ${qtySum} ≠ CN total qty ${totalQty}`;
  }

  const totalAmt = num(parsed.totals?.totalAmount);
  if (totalAmt) {
    const amtSum = lines.reduce((t, l) => t + num(l.amount), 0);
    if (Math.abs(amtSum - totalAmt) > Math.max(1, totalAmt * 0.001)) {
      return `parsed amount sum ${amtSum.toFixed(2)} ≠ CN total ${totalAmt.toFixed(2)}`;
    }
  }
  return null;
}

/** Today in IST, in the same DD-Mon-YYYY form Uniware prints on the credit note. */
export function istTodayDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('day')}-${get('month')}-${get('year')}`;
}

export function makeReverseDcPipeline(uc) {
  async function buildFromParsed(pdf, extra = {}) {
    const parsed = await parseCreditNote(pdf);
    if (!parsed.creditNoteNo && extra.creditNoteNo) parsed.creditNoteNo = extra.creditNoteNo;
    if (extra.bulkReturnId) parsed.bulkReturnId = extra.bulkReturnId;
    if (extra.facility) parsed.facility = extra.facility;
    // A Delivery Challan must carry a date. Some credit notes come through without one,
    // so the challan is dated today rather than shipping blank.
    let dateFilled = false;
    if (!String(parsed.creditNoteDate || '').trim()) {
      parsed.creditNoteDate = istTodayDate();
      dateFilled = true;
    }

    const failReason = reconcileParsed(parsed);
    if (failReason) {
      // Hybrid fallback: parse didn't reconcile against the CN's own totals, so
      // edit the original PDF in place — every byte of data stays intact.
      const edited = await editCreditNoteToDeliveryChallan(pdf, {}, {
        removeBarcode: true,
        challanDate: dateFilled ? parsed.creditNoteDate : '',
      });
      const safe = String(parsed.creditNoteNo || extra.bulkReturnId || 'DC').replace(/[^\w.-]+/g, '_');
      return {
        ok: true,
        mode: 'edit-fallback',
        fallbackReason: failReason,
        creditNoteNo: parsed.creditNoteNo || extra.creditNoteNo || '',
        bulkReturnId: extra.bulkReturnId || '',
        facility: extra.facility || '',
        challanDate: parsed.creditNoteDate,
        dateFilled,
        fromLines: parsed.fromLines,
        toLines: parsed.toLines,
        lineCount: parsed.lines?.length || 0,
        file: {
          filename: `Delivery_Challan_${safe}.pdf`,
          contentType: 'application/pdf',
          base64: edited.toString('base64'),
        },
      };
    }

    const html = buildDeliveryChallanHtml(parsed);
    const outPdf = await renderDeliveryChallanPdf(parsed);
    const safeName = String(parsed.creditNoteNo || extra.bulkReturnId || 'DC').replace(/[^\w.-]+/g, '_');
    return {
      ok: true,
      mode: 'rebuild',
      creditNoteNo: parsed.creditNoteNo || '',
      bulkReturnId: extra.bulkReturnId || '',
      facility: extra.facility || '',
      challanDate: parsed.creditNoteDate,
      dateFilled,
      fromLines: parsed.fromLines,
      toLines: parsed.toLines,
      lineCount: parsed.lines.length,
      html,
      file: {
        filename: `Delivery_Challan_${safeName}.pdf`,
        contentType: 'application/pdf',
        base64: outPdf.toString('base64'),
      },
    };
  }

  async function buildFromBulkReturn({ bulkReturnId, facility } = {}) {
    if (!uc) return { ok: false, error: 'Unicommerce session is not available on the server.' };
    try {
      const { pdf, creditNoteNo, bulkReturnId: id, facility: fac } = await downloadCnByBulkReturn(uc, bulkReturnId, facility);
      return await buildFromParsed(pdf, { creditNoteNo, bulkReturnId: id, facility: fac });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  async function buildFromUpload(pdfBuffer, parties = {}) {
    try {
      if (!pdfBuffer || pdfBuffer.length < 500 || pdfBuffer.slice(0, 4).toString() !== '%PDF') {
        return { ok: false, error: 'Upload is not a valid PDF (empty or corrupt).' };
      }
      const result = await buildFromParsed(pdfBuffer, {});
      const clean = (lines) => (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
      // Optional overrides still supported for rare manual fixes (rebuild path only).
      if (result.mode === 'rebuild' && (clean(parties.fromLines).length || clean(parties.toLines).length)) {
        const parsed = await parseCreditNote(pdfBuffer);
        if (result.challanDate) parsed.creditNoteDate = result.challanDate;
        if (clean(parties.fromLines).length) parsed.fromLines = clean(parties.fromLines);
        if (clean(parties.toLines).length) {
          parsed.toLines = clean(parties.toLines);
          parsed.shipToLines = clean(parties.toLines);
        }
        const outPdf = await renderDeliveryChallanPdf(parsed);
        result.file.base64 = outPdf.toString('base64');
        result.fromLines = parsed.fromLines;
        result.toLines = parsed.toLines;
        result.html = buildDeliveryChallanHtml(parsed);
      }
      return result;
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  async function listFacilities() {
    if (!uc) return { ok: false, error: 'Unicommerce session is not available on the server.', all: [] };
    const { all, current } = await uc.listFacilities();
    return { ok: true, all, current };
  }

  return { buildFromBulkReturn, buildFromUpload, listFacilities, buildFromParsed };
}
