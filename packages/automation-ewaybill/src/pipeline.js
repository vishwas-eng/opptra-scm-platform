// E-way bill generation - ported from ewaybill-app/Ewb.gs.
//
// Per SO: resolve the invoice (fetchShippingPackageDetails is facility-scoped, so hop
// facilities until found) → generate the EWB via the PROVEN endpoint
// /data/oms/invoice/generateEWayBill (regenerateEWayBill is only for an invoice that
// ALREADY has an EWB - do not switch). transporterId MUST be a 15-char GSTIN.
//
// After generate (or when the SO already has an EWB), the PDF is downloaded so the UI
// can offer a direct "Download" link - operators should not have to dig in Unicommerce.
import { GSTIN_RE } from '@opptra/core/validate';

const v = (x) => (x == null ? '' : String(x).trim());

function toEpoch(d) {
  if (d == null || d === '') return null;
  if (typeof d === 'number') return d;
  const s = String(d).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); // DD/MM/YYYY
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function safeName(s) {
  return String(s || 'bill').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'bill';
}

function pdfFile(so, ewb, buf) {
  return {
    filename: `EWB_${safeName(so)}_${safeName(ewb)}.pdf`,
    contentType: 'application/pdf',
    base64: Buffer.from(buf).toString('base64'),
  };
}

/** Fetch an e-way PDF from the Unicommerce / S3 URL returned on the shipping package. */
export async function downloadEwayPdf(url) {
  if (!url) return null;
  try {
    const res = await fetch(String(url), {
      headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'OpptraSCM/1.0' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 500 && buf.slice(0, 4).toString() === '%PDF' ? buf : null;
  } catch {
    return null;
  }
}

export function makeEwaybillPipeline(uc) {
  /** Resolve an SO's invoice in a specific facility. notHere=true → hop to the next. */
  async function resolveInFacility(so, facility) {
    const d = await uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: so }, { facility });
    const sps = d?.shippingPackages || [];
    if (!sps.length) return { ok: false, notHere: true, error: 'not in this facility' };
    const sp = sps.find((p) => p.invoiceCode);
    if (!sp) return { ok: false, error: `not invoiced yet (status ${sps[0].statusCode || '?'})` };
    const ewbNo = sp.ewayBillNo || sp.ewayBillNumber || '';
    const ewayPdfUrl = sp.ewayBillPdfUrl || sp.eWayBillPdfUrl || '';
    return {
      ok: true, invoiceCode: sp.invoiceCode, status: sp.statusCode, packageCode: sp.code,
      existingEwb: ewbNo || (ewayPdfUrl ? 'present' : null),
      ewayPdfUrl,
    };
  }

  /** Try each facility until the SO's invoice is found. */
  async function resolveInvoice(so) {
    const facs = await uc.dataGet('/data/user/facilities');
    const current = facs?.currentFacilityCode || null;
    const all = (facs?.facilityDTOList || []).map((f) => f.code);
    const order = [current, ...all.filter((f) => f && f !== current)].filter(Boolean);
    let lastErr = 'no facilities available';
    for (const fac of order) {
      const inv = await resolveInFacility(so, fac);
      if (inv.ok) return { ...inv, facility: fac };
      if (!inv.notHere) { lastErr = inv.error; break; } // here but not invoiced → stop
      lastErr = inv.error;
    }
    return { ok: false, error: lastErr };
  }

  function buildTransporterDetail(row) {
    const gstin = v(row.gstin);
    if (gstin && !GSTIN_RE.test(gstin)) {
      throw new Error(`transporter GSTIN must be a valid 15-character Indian GSTIN, got "${gstin}" (${gstin.length} chars)`);
    }
    const mode = v(row.transMode).toUpperCase();
    const vehicleNo = v(row.vehicleNo);
    // Explicit Road requires vehicle (GST 4011). Blank mode is left for UC defaults.
    if (mode === 'ROAD' && !vehicleNo) {
      throw new Error('vehicle number is required for Road transport (GST error 4011)');
    }
    const td = {};
    if (gstin) td.transporterId = gstin;
    if (v(row.transporterName)) td.transporterName = v(row.transporterName);
    if (vehicleNo) td.vehicleNo = vehicleNo;
    if (mode) td.transMode = mode;
    // NIC/GST rejects distance 0 / empty when ship-from and ship-to share a pincode
    // (error 107). Ops often leave distance blank for local moves — default to 1 km;
    // an explicit positive value still wins.
    const dist = v(row.distance);
    td.transDistance = dist && Number(dist) > 0 ? dist : '1';
    const dt = toEpoch(row.docDate); if (dt) td.transDocDate = dt;
    if (v(row.docNo)) td.transDocNo = v(row.docNo);
    if (v(row.vehicleType)) td.vehicleType = v(row.vehicleType).toUpperCase().replace(/\s+/g, '_');
    return td;
  }

  /** Prefer the generate response URL; if missing, re-read the package for one. */
  async function fetchPdf(so, facility, preferredUrl) {
    let buf = await downloadEwayPdf(preferredUrl);
    if (buf) return { buf, url: preferredUrl || null };
    const again = await resolveInFacility(so, facility).catch(() => null);
    if (!again?.ok || !again.ewayPdfUrl) return { buf: null, url: preferredUrl || null };
    buf = await downloadEwayPdf(again.ewayPdfUrl);
    return { buf, url: again.ewayPdfUrl };
  }

  /** Generate one EWB. dryRun → resolve + validate + return payload, no write / no PDF. */
  async function generateOne(row, { dryRun = false } = {}) {
    const so = v(row.so);
    if (!so) return { so, ok: false, error: 'empty SO' };

    const inv = await resolveInvoice(so);
    if (!inv.ok) return { so, ok: false, error: inv.error };

    // Already has an EWB (number and/or PDF URL) → never regenerate. Always try to hand
    // back the PDF, even when the UI asked for a dry run: downloading an existing bill is
    // read-only and is exactly what operators want when they paste SOs that are already done.
    if (inv.existingEwb) {
      const ewbLabel = inv.existingEwb === 'present' ? 'on-invoice' : inv.existingEwb;
      const { buf, url } = await fetchPdf(so, inv.facility, inv.ewayPdfUrl);
      return {
        so, ok: true, skipped: true, dryRun: !!dryRun, ewb: ewbLabel,
        invoiceCode: inv.invoiceCode, facility: inv.facility,
        note: 'already had EWB', pdf: url || null,
        file: buf ? pdfFile(so, ewbLabel, buf) : null,
        pdfError: buf ? undefined : 'EWB exists but PDF could not be downloaded',
      };
    }

    let td;
    try { td = buildTransporterDetail(row); }
    catch (e) { return { so, ok: false, invoiceCode: inv.invoiceCode, error: e.message }; }

    if (dryRun) return { so, ok: true, dryRun: true, invoiceCode: inv.invoiceCode, facility: inv.facility, payload: td };

    const d = await uc.data('/data/oms/invoice/generateEWayBill',
      { invoiceCode: inv.invoiceCode, transporterDetail: td }, { facility: inv.facility });
    if (d?.successful === false) {
      let err = (d.errors || []).map((x) => x.description || x.message).join('; ') || 'failed';
      // Tip for the two most common GST payload mistakes so operators fix input, not "retry forever".
      if (/4011|vehicle number/i.test(err) && !td.vehicleNo) {
        err += ' — add a vehicle number (required for Road transport).';
      }
      return { so, ok: false, invoiceCode: inv.invoiceCode, error: err };
    }
    const ewb = d.ewayBillNo || d.ewayBillNumber ||
      (d.ewbeinvoicelist && d.ewbeinvoicelist[0] && (d.ewbeinvoicelist[0].ewayBillNo || d.ewbeinvoicelist[0].ewbNo)) || '(generated)';
    const pdfUrl = d.ewayBillPdfUrl || d.eWayBillPdfUrl || null;
    const { buf, url } = await fetchPdf(so, inv.facility, pdfUrl || inv.ewayPdfUrl);
    return {
      so, ok: true, invoiceCode: inv.invoiceCode, facility: inv.facility, ewb,
      pdf: url || pdfUrl,
      file: buf ? pdfFile(so, ewb, buf) : null,
      pdfError: buf ? undefined : 'EWB generated but PDF could not be downloaded',
    };
  }

  return { generateOne, resolveInvoice, downloadEwayPdf };
}
