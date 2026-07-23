// Packing mail - ported from b2b Mailer.gs (A2).
//   input: SO list → resolve each SO's invoice + facility (UC), download the invoice PDF
//   (uc.dataBinary), group by warehouse (WAREHOUSE_MAP: facility → email), and create ONE
//   Gmail draft per warehouse with the invoices attached, for the operator to review + send.
//
// Google is INJECTED ({ gmail } client + gmailApi wrapper). When Google isn't configured
// the pipeline returns a clear, non-throwing "not connected" result so the UI can show it.
import { gmailApi, buildRawMessage } from '@opptra/integrations-google';

const FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];

export function makePackingPipeline(uc, cfg = {}, google = null) {
  const warehouseMap = parseMap(cfg.WAREHOUSE_MAP);
  const sender = cfg.GOOGLE_DELEGATED_USER || '';
  const configured = ['Opp_RSG_MH', ...FACILITIES];

  // Resolve an SO's invoice by hopping facilities (fetchShippingPackageDetails is scoped).
  async function resolveInvoice(so) {
    for (const facility of configured) {
      const d = await uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: so }, { facility }).catch(() => null);
      const sp = (d?.shippingPackages || []).find((p) => p.invoiceCode);
      if (sp) return { invoiceCode: sp.invoiceCode, facility, ewbUrl: sp.ewayBillPdfUrl || null };
    }
    return null;
  }

  async function downloadInvoicePdf(invoiceCode, facility) {
    const path = `/oms/invoice/show?invoiceCodes=${encodeURIComponent(invoiceCode)}&legacy=1`;
    const res = await uc.dataBinary(path, { facility }).catch(() => null);
    return res && res.contentType.includes('pdf') && res.buffer.length > 500 ? res.buffer : null;
  }

  /** Build a per-warehouse Gmail draft for the given SOs. */
  async function createDrafts(soList) {
    if (!google) {
      return { ok: false, error: 'Google Workspace is not connected on the server yet. Set the service account to enable packing mail.' };
    }
    const perWarehouse = new Map(); // email -> { warehouse, sos:[], attachments:[] }
    const unresolved = [];

    for (const so of soList) {
      const inv = await resolveInvoice(so);
      if (!inv) { unresolved.push({ so, reason: 'no invoice found' }); continue; }
      const to = warehouseMap[inv.facility] || cfg.PACKING_DEFAULT_TO || '';
      if (!to) { unresolved.push({ so, reason: `no warehouse email for ${inv.facility}` }); continue; }
      if (!perWarehouse.has(to)) perWarehouse.set(to, { warehouse: inv.facility, to, sos: [], attachments: [] });
      const group = perWarehouse.get(to);
      group.sos.push(so);
      const pdf = await downloadInvoicePdf(inv.invoiceCode, inv.facility);
      if (pdf) group.attachments.push({ filename: `${inv.invoiceCode.replace(/[^\w-]/g, '_')}.pdf`, contentType: 'application/pdf', buffer: pdf });
    }

    const drafts = [];
    for (const g of perWarehouse.values()) {
      const subject = `Packing - ${g.sos.length} order(s): ${g.sos.slice(0, 6).join(', ')}${g.sos.length > 6 ? '…' : ''}`;
      const htmlBody = `<p>Hi ${escapeHtml(g.warehouse)} team,</p>
        <p>Please pack the following ${g.sos.length} order(s). Invoices attached.</p>
        <ul>${g.sos.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
        <p>- Opptra Supply Chain</p>`;
      const res = await gmailApi.createDraft(google.gmail, {
        to: g.to, from: sender ? `Opptra Supply Chain <${sender}>` : undefined,
        subject, htmlBody, attachments: g.attachments,
      });
      drafts.push({ warehouse: g.warehouse, to: g.to, sos: g.sos, attachmentCount: g.attachments.length, draftId: res?.data?.id || null });
    }

    return { ok: unresolved.length === 0, draftCount: drafts.length, drafts, unresolved };
  }

  return { createDrafts, resolveInvoice, _buildRawMessage: buildRawMessage };
}

function parseMap(v) {
  if (!v) return {};
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return {}; }
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
