// Reverse Delivery Challan — ported from b2b ReverseDc.gs.
//   1. download the ORIGINAL credit-note PDF: GET /oms/invoice/show?invoiceCodes={CN}&legacy=1
//      (facility-scoped → hop until found), via uc.dataBinary
//   2. edit it in place → Delivery Challan (edit.js, pdf-lib)
//   3. return the edited PDF (base64 artifact) + parties
//
// Party extraction from the CN text is best-effort; the caller can also pass explicit
// From/To lines (the seller/customer blocks) when OCR isn't available server-side.
import { editCreditNoteToDeliveryChallan } from './edit.js';

const DEFAULT_FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];

export function makeReverseDcPipeline(uc, cfg = {}) {
  const configured = String(cfg.UC_ASN_FACILITIES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const facilities = [...new Set(['Opp_RSG_MH', ...configured, ...DEFAULT_FACILITIES])];
  const opptraTo = (cfg.UC_REVERSEDC_TO_LINES || 'Opptra Retail Private Limited').split('|').map((s) => s.trim());

  async function downloadCn(creditNote) {
    const path = `/oms/invoice/show?invoiceCodes=${encodeURIComponent(creditNote)}&legacy=1`;
    for (const facility of facilities) {
      const res = await uc.dataBinary(path, { facility }).catch(() => null);
      if (res && res.contentType.includes('pdf') && res.buffer.length > 500) return { buffer: res.buffer, facility };
    }
    return null;
  }

  async function build({ creditNote, fromLines = [], toLines = null, removeBarcode = true }) {
    if (!creditNote) return { ok: false, error: 'Enter a Credit Note number (e.g. SRRMH2627/0134).' };
    const cn = await downloadCn(creditNote);
    if (!cn) return { ok: false, error: `Credit note ${creditNote} PDF not found in any facility` };

    const parties = { fromLines, toLines: toLines && toLines.length ? toLines : opptraTo };
    const edited = await editCreditNoteToDeliveryChallan(cn.buffer, parties, { removeBarcode });

    return {
      ok: true, creditNote, facility: cn.facility,
      file: { filename: `DC_${String(creditNote).replace(/[^0-9A-Za-z]/g, '-')}.pdf`, contentType: 'application/pdf', base64: edited.toString('base64') },
      parties,
    };
  }

  return { build, downloadCn };
}
