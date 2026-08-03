// Packing mail - ported from b2b Mailer.gs (A2), the two-stage warehouse flow:
//
//   STEP 0  previewGroups  (recipient picker)
//     SO list → warehouses from the B2B sheet + To/CC/Finance options from the
//     warehouse-email Google Sheet. The UI lets the operator tick who gets each mail.
//
//   STEP 1  createDrafts  (the FIRST email that starts the thread)
//     one Gmail draft per warehouse with the legacy template (order table + shipping
//     label + appointment letter from Drive). Recipients come from the sheet (or the
//     operator's selection) - never a hardcoded WAREHOUSE_MAP.
//
//   STEP 2  sendInvoiceEway  (the follow-up, SAME Gmail thread)
//     invoice + e-way bill from Unicommerce into the warehouse's existing thread.
//
//   Every run drafts first (never sends blind); sendDraft() dispatches the exact
//   reviewed draft.
import { gmailApi, driveApi, sheetsApi, a1, buildRawMessage } from '@opptra/integrations-google';
import { makeUcOrderLookup, prettyChannel } from '@opptra/uc-client';
import {
  loadWarehouseDirectory, resolveWarehouseEntry, shortCodeOf,
} from './warehouseEmails.js';

const FACILITIES = ['Opp_RSG_MH', 'Opp_WIQ_MH_1', 'Opp_BSB_HR_1P', 'Opp_WIQ_KA', 'Opp_WIQ_HR'];
const HEADER_ROW = 2;
const DATE_TAB_RE = /^\d{2}-[A-Za-z]{3}-\d{4}(_\d+)?$/;
// Columns in display order. Appointment ID (and any other col) is dropped from the HTML
// table when every row in the batch leaves it blank — no empty Appointment ID column.
const MAIL_COLS = [
  { key: 'marketplace', header: 'Marketplace' },
  { key: 'brand', header: 'Brand' },
  { key: 'po', header: 'Po No' },
  { key: 'so', header: 'So No' },
  { key: 'qty', header: 'Qty' },
  { key: 'value', header: 'Value', fmt: true },
  { key: 'warehouse', header: 'Pickup Wh Name' },
  { key: 'destCity', header: 'Destination City' },
  { key: 'appointmentDate', header: 'Appointment Date' },
  { key: 'dispatchDate', header: 'Dispatch Date' },
  { key: 'appointmentId', header: 'Appointment ID' },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const soNorm = (s) => String(s || '').trim().toUpperCase().replace(/[\s_-]/g, '');
const cleanEmails = (list) => [...new Set((list || []).map((e) => String(e || '').trim()).filter((e) => EMAIL_RE.test(e)))];

/** Normalize sheet dates to DD-Mon-YYYY (IST-friendly display). Handles Excel serials + common strings. */
function fmtSheetDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // Sheets serial day count (≈ 2000–2100 AD)
    if (n > 20_000 && n < 80_000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000;
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(new Date(ms));
      return `${parts.find((p) => p.type === 'day').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'year').value}`;
    }
  }
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
    || s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    let y; let mo; let d;
    if (m[1].length === 4) { y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]); }
    else { d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (y < 100) y += 2000; }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })
        .formatToParts(new Date(Date.UTC(y, mo - 1, d)));
      return `${parts.find((p) => p.type === 'day').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'year').value}`;
    }
  }
  // Already like 24-Jul-2026 / 24-July-2026 → collapse full month to short when possible
  const long = s.match(/^(\d{1,2})-([A-Za-z]+)-(\d{4})$/);
  if (long) {
    const months = { january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun', july: 'Jul', august: 'Aug', september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec' };
    const key = long[2].toLowerCase();
    const mon = months[key] || (long[2].length > 3 ? long[2].slice(0, 3) : long[2]);
    return `${long[1].padStart(2, '0')}-${mon[0].toUpperCase()}${mon.slice(1)}-${long[3]}`;
  }
  return s;
}

export function makePackingPipeline(uc, cfg = {}, google = null, deps = {}) {
  // The mailbox that actually holds the drafts: the Google account whose refresh
  // token was used (per-user OAuth for packing). Never a hardcoded shared mailbox.
  const sender = google?.delegatedUser || '';
  const fromName = deps.fromName || cfg.MAIL_FROM_NAME || (sender ? String(sender).split('@')[0] : 'SupplyChain');
  const configured = [...new Set(FACILITIES)];
  const saveThread = deps.saveThread || (async () => {});
  const latestThreadFor = deps.latestThreadFor || (async () => null);
  // Optional test seam for the warehouse-email directory (avoids Sheets in unit tests).
  const directoryOverride = deps.warehouseDirectory || null;
  // Last resort for an SO the B2B sheet has never seen: Unicommerce knows the order and,
  // via a facility hop, the warehouse that ships it.
  const ucOrders = deps.ucOrders || makeUcOrderLookup(uc, { preferFacilities: configured });

  const orNull = (e) => { if (e?.name === 'SessionError') throw e; return null; };

  const gmailRequired = () => {
    if (!google?.gmail) {
      return { ok: false, error: 'Connect your Gmail on the Packing Mail tab first — drafts are created in your own mailbox.' };
    }
    return null;
  };

  async function warehouseDirectory() {
    if (directoryOverride) return directoryOverride;
    return loadWarehouseDirectory(google?.sheets, cfg.WAREHOUSE_EMAIL_SHEET_ID, cfg.WAREHOUSE_EMAIL_TAB || null);
  }

  /* ---- order details from the B2B sheet (Master + date tabs), like loadOrdersForMail_ ---- */
  async function loadSheetRows(soList) {
    const bySo = new Map();
    if (!cfg.MASTER_SHEET_ID) return bySo;
    const wanted = new Set(soList.map(soNorm));
    try {
      const tabs = await sheetsApi.listTabs(google.sheets, cfg.MASTER_SHEET_ID);
      const scan = [...tabs.filter((t) => DATE_TAB_RE.test(t)), cfg.MASTER_TAB || 'Master'];
      for (const tab of scan) {
        if (bySo.size >= wanted.size) break;
        let values;
        try { values = await sheetsApi.read(google.sheets, cfg.MASTER_SHEET_ID, a1(tab, `A${HEADER_ROW}:ZZ`)); } catch { continue; }
        const map = {};
        (values[0] || []).forEach((h, i) => { const n = String(h ?? '').trim(); if (n) map[n] = i; });
        const soCol = map['SO/GP Number'];
        if (soCol === undefined) continue;
        const col = (row, name) => (map[name] === undefined ? '' : String(row[map[name]] ?? '').trim());
        for (const row of values.slice(1)) {
          const so = String(row[soCol] ?? '').trim();
          if (!so || !wanted.has(soNorm(so)) || bySo.has(soNorm(so))) continue;
          bySo.set(soNorm(so), {
            marketplace: col(row, 'Marketplace'), brand: col(row, 'Brand'),
            po: col(row, 'PO / RPO / Gatepass Number'), so,
            qty: col(row, 'PO / RPO Quantity'), value: col(row, 'PO / Invoice Value Total'),
            warehouse: col(row, 'Pickup Wh Name'), destCity: col(row, 'Destination City'),
            appointmentDate: fmtSheetDate(col(row, 'Appointment Date / EDD')),
            // B2B tracker header is "Dispatch / Pickup Date" (ops fill this manually before packing mail).
            dispatchDate: fmtSheetDate(col(row, 'Dispatch / Pickup Date') || col(row, 'Dispatch Date')),
            appointmentId: col(row, 'Appointment ID'),
          });
        }
      }
    } catch { /* sheet unavailable: caller reports the SO as unresolved */ }
    return bySo;
  }

  // Group SO rows by warehouse. Recipients are resolved separately (sheet + user picks).
  function groupByWarehouse(rows) {
    const groups = new Map();
    for (const row of rows) {
      const wh = row.warehouse || 'UNKNOWN';
      if (!groups.has(wh)) groups.set(wh, { warehouse: wh, orders: [] });
      groups.get(wh).orders.push(row);
    }
    return groups;
  }

  // Apply operator picks (or sheet defaults) onto a warehouse group.
  // recipientsByWh: { [warehouse]: { to: string[], cc: string[], includeFinance?: boolean } }
  function applyRecipients(group, directory, recipientsByWh = {}) {
    const entry = resolveWarehouseEntry(directory, group.warehouse);
    const override = recipientsByWh[group.warehouse] || (entry ? recipientsByWh[entry.warehouse] : null) || null;
    let to = [];
    let cc = [];
    if (override) {
      to = cleanEmails(override.to);
      cc = cleanEmails(override.cc);
      if (override.includeFinance && entry?.finance?.length) cc = cleanEmails([...cc, ...entry.finance]);
    } else if (entry) {
      // Default: every To + every CC on the sheet. Finance stays optional (UI opt-in).
      to = cleanEmails(entry.to);
      cc = cleanEmails(entry.cc);
    }
    return {
      ...group,
      entry,
      to,
      cc,
      shortCode: entry?.shortCode || shortCodeOf(group.warehouse),
      contact: entry?.contact || shortCodeOf(group.warehouse) || 'Team',
      options: entry ? {
        to: entry.to, cc: entry.cc, finance: entry.finance,
        shortCode: entry.shortCode, contact: entry.contact,
      } : null,
    };
  }

  /* ---- legacy template pieces ---- */
  const istToday = () => {
    // Match sheet date-tab format (e.g. 24-Jul-2026), not month:long (24-July-2026).
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(new Date());
    return `${parts.find((p) => p.type === 'day').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'year').value}`;
  };

  function marketplaceLabel(list) {
    const mkts = [...new Set(list.map((o) => String(o.marketplace || '').trim()).filter(Boolean))];
    if (mkts.length === 1) return mkts[0];
    if (mkts.length > 1) return 'Multi-Marketplace';
    return 'Packing';
  }
  // Body phrase uses the real Marketplace value from the sheet (e.g. AZ Etrade, Blinkit) —
  // never the old "Amazon UCB" blanket for every Amazon-family channel.
  const marketplacePhrase = (list) => {
    const label = marketplaceLabel(list);
    if (label === 'Packing') return 'marketplace';
    if (label === 'Multi-Marketplace') return 'multi-marketplace';
    return label;
  };

  const fmtValue = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isNaN(n) || v === '' || v == null ? String(v ?? '') : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  };
  const tdCell = (v) => `<td style="border:1px solid #ccc;padding:6px 8px;font-size:12px;">${escapeHtml(v ?? '')}</td>`;

  // The navy-header order table — shared by BOTH emails in the thread so the
  // invoice/e-way follow-up keeps the exact same look as the first packing mail.
  // Columns with no data across the whole batch (e.g. blank Appointment ID) are omitted.
  function orderTableHtml(list) {
    const cols = MAIL_COLS.filter((c) => list.some((o) => {
      const raw = c.fmt ? fmtValue(o[c.key]) : String(o[c.key] ?? '').trim();
      return String(raw ?? '').trim() !== '';
    }));
    const head = cols.map((c) => `<th style="border:1px solid #ccc;padding:6px 8px;background:#131A48;color:#fff;font-size:12px;">${c.header}</th>`).join('');
    const rows = list.map((o) => '<tr>'
      + cols.map((c) => tdCell(c.fmt ? fmtValue(o[c.key]) : (o[c.key] ?? ''))).join('')
      + '</tr>').join('');
    return `<table style="border-collapse:collapse;margin-top:12px;"><tr>${head}</tr>${rows}</table>`;
  }

  function buildOrderTableHtml(contact, list) {
    return `<div style="font-family:Arial,sans-serif;font-size:13px;color:#222;">`
      + `<p>Hi ${escapeHtml(contact)},</p>`
      + `<p>Please find the Sales Order details for the ${escapeHtml(marketplacePhrase(list))} dispatches below and start the packing process.</p>`
      + `<p><b>No packing slip is required for this shipment. Paste the attached shipping labels only on the master cartons.</b></p>`
      + orderTableHtml(list)
      + `<p style="margin-top:16px;">Thanks &amp; Regards,<br/>${escapeHtml(fromName)}.</p>`
      + `</div>`;
  }

  /* ---- Drive attachments: shipping label ({PO}.pdf) + appointment letter ({ApptID}.pdf) ---- */
  async function collectDriveAttachments(orders) {
    const atts = []; const missing = []; const seen = new Set();
    for (const o of orders) {
      const po = String(o.po || '').trim();
      const appt = String(o.appointmentId || '').trim();
      if (po && !seen.has(`L:${po.toUpperCase()}`)) {
        const buf = await driveApi.findPdfByName(google.drive, cfg.LABEL_DRIVE_FOLDER, po);
        if (buf) { atts.push({ filename: `Label_${po}.pdf`, contentType: 'application/pdf', buffer: buf }); seen.add(`L:${po.toUpperCase()}`); }
        else missing.push(`shipping label for PO ${po}`);
      }
      // No appointment ID is normal for many channels — don't flag it as missing, and
      // don't look for an appointment PDF that does not exist.
      if (appt && !seen.has(`A:${appt.toUpperCase()}`)) {
        const buf = await driveApi.findPdfByName(google.drive, cfg.APPOINTMENT_DRIVE_FOLDER, appt);
        if (buf) { atts.push({ filename: `Appt_${appt}.pdf`, contentType: 'application/pdf', buffer: buf }); seen.add(`A:${appt.toUpperCase()}`); }
        else missing.push(`appointment letter ${appt}`);
      }
    }
    return { atts, missing };
  }

  /* ---- UC attachments: invoice PDF + e-way bill PDF ---- */
  // Prefer known Opp_* warehouses, then hop every live facility. A static FACILITIES
  // list silently missed newer centers (e.g. Opp_SDG_*) and marked "no invoice/e-way"
  // when the package lived elsewhere.
  async function facilityHopOrder(prefer = null) {
    let live = [];
    try {
      if (typeof uc.listFacilities === 'function') {
        const { all, current } = await uc.listFacilities();
        live = all || [];
        if (!prefer && current) prefer = current;
      }
    } catch (e) { if (e?.name === 'SessionError') throw e; }
    const opp = live.filter((f) => /^Opp/i.test(f));
    const rest = live.filter((f) => !/^Opp/i.test(f));
    return [...new Set([prefer, ...configured, ...opp, ...rest].filter(Boolean))];
  }

  async function resolveInvoiceAndEway(so) {
    const order = await facilityHopOrder();
    for (const facility of order) {
      const d = await uc.data('/data/oms/saleorder/fetchShippingPackageDetails', { saleOrderCode: so }, { facility }).catch(orNull);
      const sp = (d?.shippingPackages || []).find((p) => p.invoiceCode || p.ewayBillPdfUrl || p.eWayBillPdfUrl);
      if (sp) return { invoiceCode: sp.invoiceCode || sp.invoiceDisplayCode || '', ewayUrl: sp.ewayBillPdfUrl || sp.eWayBillPdfUrl || '', facility };
    }
    return null;
  }
  async function downloadInvoicePdf(invoiceCode, facility) {
    if (!invoiceCode) return null;
    const path = `/oms/invoice/show?invoiceCodes=${encodeURIComponent(invoiceCode)}&legacy=1`;
    const res = await uc.dataBinary(path, { facility }).catch(orNull);
    return res && res.contentType.includes('pdf') && res.buffer.length > 500 ? res.buffer : null;
  }
  async function downloadEwayPdf(url) {
    if (!url) return null;
    try {
      const res = await fetch(String(url), { headers: { Accept: 'application/pdf,*/*', 'User-Agent': 'OpptraSCM/1.0' } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 500 && buf.slice(0, 4).toString() === '%PDF' ? buf : null;
    } catch { return null; }
  }
  async function collectUcAttachments(orders) {
    const atts = []; const missing = [];
    for (const o of orders) {
      const inv = await resolveInvoiceAndEway(o.so);
      if (!inv) { missing.push(`no invoice/e-way yet for ${o.so}`); continue; }
      const invPdf = await downloadInvoicePdf(inv.invoiceCode, inv.facility);
      if (invPdf) atts.push({ filename: `Invoice_${String(inv.invoiceCode).replace(/[^\w-]/g, '_')}.pdf`, contentType: 'application/pdf', buffer: invPdf });
      else if (inv.invoiceCode) missing.push(`invoice PDF for ${o.so}`);
      else missing.push(`not invoiced yet: ${o.so}`);
      const ewbPdf = await downloadEwayPdf(inv.ewayUrl);
      if (ewbPdf) atts.push({ filename: `EWB_${o.so}.pdf`, contentType: 'application/pdf', buffer: ewbPdf });
    }
    return { atts, missing };
  }

  // An SO the B2B sheet has never seen (Waypoint has not published it, so no first fill
  // could have written it) still has a warehouse, and Unicommerce knows which. Reading it
  // from there beats dead-ending: the operator asked to mail these orders, and the sheet
  // being behind is not a reason they cannot be mailed.
  async function rowFromUc(so) {
    const o = await ucOrders.resolveOrder(so).catch(orNull);
    if (!o || !o.facility) return null;
    return {
      so: o.so || so,
      marketplace: prettyChannel(o.channel),
      brand: shortCodeOf(o.facility),
      po: o.po || '',
      qty: o.units || '',
      value: o.value || '',
      warehouse: o.facility,
      destCity: o.city || '',
      appointmentDate: '',
      dispatchDate: '',
      appointmentId: o.appointmentId || '',
      viaUc: true,
    };
  }

  // A sheet row whose Pickup Wh Name is blank is as unusable as no row at all: it groups
  // under UNKNOWN, which has no email, so the mail goes nowhere. Top the warehouse up from
  // UC instead of reporting a row we can plainly see.
  async function withWarehouse(row, so) {
    if (row?.warehouse) return row;
    const fromUc = await rowFromUc(so);
    if (!fromUc) return row || null;
    return row ? { ...row, warehouse: fromUc.warehouse, viaUc: true } : fromUc;
  }

  async function resolveOrderGroups(soList, recipientsByWh = {}) {
    const sheetRows = await loadSheetRows(soList);
    const unresolved = [];
    const rows = [];
    for (const so of soList) {
      const row = await withWarehouse(sheetRows.get(soNorm(so)), so);
      if (!row?.warehouse) {
        unresolved.push({ so, reason: 'no warehouse for it on the B2B sheet or in Unicommerce' });
        continue;
      }
      rows.push(row);
    }
    const directory = await warehouseDirectory();
    const groups = [...groupByWarehouse(rows).values()].map((g) => applyRecipients(g, directory, recipientsByWh));
    for (const g of groups) {
      if (!g.to.length) {
        g.orders.forEach((o) => unresolved.push({
          so: o.so,
          reason: `No warehouse email for ${g.warehouse} — add it on the warehouse email sheet`,
        }));
      }
    }
    return { groups: groups.filter((g) => g.to.length), unresolved, directory };
  }

  /* ============================ STEP 0: preview for recipient picker ============================ */
  async function previewGroups(soList) {
    if (!google?.sheets) {
      return { ok: false, error: 'Google Sheets is not available. An admin must connect shared Workspace (Admin → Google), or connect your own Gmail first.' };
    }
    if (!cfg.WAREHOUSE_EMAIL_SHEET_ID) {
      return { ok: false, error: 'WAREHOUSE_EMAIL_SHEET_ID is not set - point it at the warehouse To/CC sheet.' };
    }
    const { groups, unresolved, directory } = await resolveOrderGroups(soList);
    return {
      ok: unresolved.length === 0 && groups.length > 0,
      groups: groups.map((g) => ({
        warehouse: g.warehouse,
        sos: g.orders.map((o) => o.so),
        shortCode: g.shortCode,
        contact: g.contact,
        // Defaults the UI pre-ticks: all To + all CC. Finance is offered but off by default.
        selectedTo: g.to,
        selectedCc: g.cc,
        options: g.options || { to: g.to, cc: g.cc, finance: [] },
      })),
      unresolved,
      directoryCount: Object.keys(directory).length,
      sender: sender || null,
    };
  }

  /* ============================ STEP 1: packing drafts ============================ */
  async function createDrafts(soList, { recipients = {} } = {}) {
    const blocked = gmailRequired();
    if (blocked) return blocked;
    if (!google?.sheets) return { ok: false, error: 'Google Sheets is not available for warehouse lookup.' };
    const { groups, unresolved } = await resolveOrderGroups(soList, recipients);

    const drafts = [];
    for (const g of groups) {
      const { atts, missing } = await collectDriveAttachments(g.orders);
      const subject = `Consignment Packing & Readiness - ${marketplaceLabel(g.orders)} - ${istToday()} ${g.shortCode}`;
      const res = await gmailApi.createDraft(google.gmail, {
        to: g.to, cc: g.cc, from: sender ? `${fromName} <${sender}>` : undefined,
        subject, htmlBody: buildOrderTableHtml(g.contact, g.orders), attachments: atts,
      });
      const draftId = res?.data?.id || null;
      const threadId = res?.data?.message?.threadId || null;
      await saveThread({ warehouse: g.warehouse, toEmail: g.to.join(', '), subject, threadId }).catch(() => {});
      drafts.push({
        warehouse: g.warehouse, to: g.to.join(', '), cc: g.cc.join(', '),
        sos: g.orders.map((o) => o.so), attachmentCount: atts.length,
        missing, subject, draftId, from: sender || null,
        viewUrl: threadId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(sender)}#drafts/${threadId}` : null,
      });
    }
    return { ok: unresolved.length === 0, draftCount: drafts.length, drafts, unresolved, from: sender || null };
  }

  /* ==================== STEP 2: invoice + e-way DRAFT into same thread ==================== */
  async function sendInvoiceEway(soList, { recipients = {} } = {}) {
    const blocked = gmailRequired();
    if (blocked) return blocked;
    const sheetRows = await loadSheetRows(soList);
    const unresolved = [];
    const rows = [];
    for (const so of soList) {
      const row = await withWarehouse(sheetRows.get(soNorm(so)), so)
        || { so, warehouse: '', po: '', appointmentId: '' };
      rows.push(row);
    }
    const directory = await warehouseDirectory();
    const groups = [...groupByWarehouse(rows).values()]
      .map((g) => applyRecipients(g, directory, recipients))
      .filter((g) => {
        if (g.to.length) return true;
        g.orders.forEach((o) => unresolved.push({ so: o.so, reason: `No warehouse email for ${g.warehouse} — add it on the warehouse email sheet` }));
        return false;
      });

    const drafts = [];
    for (const g of groups) {
      const { atts, missing } = await collectUcAttachments(g.orders);
      if (!atts.length) {
        g.orders.forEach((o) => unresolved.push({ so: o.so, reason: missing.join('; ') || 'no invoice or e-way bill ready yet' }));
        continue;
      }
      const thread = await latestThreadFor(g.warehouse).catch(() => null);
      const subject = thread?.subject || `Consignment Packing & Readiness - ${marketplaceLabel(g.orders)} - ${istToday()} ${g.shortCode}`;
      const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:13px;color:#222;">`
        + `<p>Hi ${escapeHtml(g.contact)},</p>`
        + `<p>Please find attached the tax invoice(s) and e-way bill(s) for the dispatches below.</p>`
        + orderTableHtml(g.orders)
        + `<p style="margin-top:16px;">Thanks &amp; Regards,<br/>${escapeHtml(fromName)}.</p>`
        + `</div>`;
      const res = await gmailApi.createDraft(google.gmail, {
        to: g.to, cc: g.cc, from: sender ? `${fromName} <${sender}>` : undefined, subject, htmlBody, attachments: atts,
      }, { threadId: thread?.thread_id });
      const draftId = res?.data?.id || null;
      const threadId = res?.data?.message?.threadId || null;
      drafts.push({
        warehouse: g.warehouse, to: g.to.join(', '), cc: g.cc.join(', '),
        sos: g.orders.map((o) => o.so),
        attachmentCount: atts.length, missing, subject, draftId, threaded: !!thread,
        from: sender || null,
        viewUrl: threadId ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(sender)}#drafts/${threadId}` : null,
      });
    }
    return { ok: unresolved.length === 0 && drafts.length > 0, draftCount: drafts.length, drafts, unresolved, from: sender || null };
  }

  /** Dispatch a draft created by either step, after the operator has viewed it. */
  async function sendDraft(draftId) {
    const blocked = gmailRequired();
    if (blocked) return blocked;
    if (!draftId) return { ok: false, error: 'draftId is required' };
    await gmailApi.sendDraft(google.gmail, draftId);
    return { ok: true, draftId, from: sender || null };
  }

  return { previewGroups, createDrafts, sendInvoiceEway, sendDraft, _buildRawMessage: buildRawMessage };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
