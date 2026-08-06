// Uniware-faithful Delivery Challan PDF built from parsed CN data.
// Source layout no longer matters, we always draw a consistent DC with full line items.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const NAVY = rgb(0.075, 0.102, 0.282); // #131A48
const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.35, 0.35, 0.35);

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML preview (optional). */
export function buildDeliveryChallanHtml(data = {}) {
  const from = (data.fromLines || []).map((l) => `<div>${esc(l)}</div>`).join('');
  const to = (data.toLines || []).map((l) => `<div>${esc(l)}</div>`).join('');
  const ship = (data.shipToLines || data.toLines || []).map((l) => `<div>${esc(l)}</div>`).join('');
  const igst = data.taxMode === 'igst';
  const rows = (data.lines || []).map((r, i) => `<tr>
    <td>${esc(r.sr || i + 1)}</td>
    <td>${esc(r.name)}${r.hsn ? `<div class="hsn">HSN code: ${esc(r.hsn)}</div>` : ''}</td>
    <td>${esc(r.code)}</td>
    <td>${esc(r.qty)}</td>
    <td>${esc(r.rate)}</td>
    <td>${esc(r.taxable)}</td>
    ${igst ? `<td>${esc(r.igst)}</td>` : `<td>${esc(r.cgst)}</td><td>${esc(r.sgst)}</td>`}
    <td>${esc(r.amount)}</td>
  </tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Delivery Challan</title>
<style>
  body{font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#111;margin:20px}
  h1{font-size:16px;text-align:center;margin:0 0 10px}
  .boxes{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:12px 0}
  .box{border:1px solid #333;padding:8px;min-height:100px}
  .box h3{margin:0 0 6px;font-size:10px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{border:1px solid #333;padding:4px 5px;vertical-align:top;font-size:10px}
  th{background:#131A48;color:#fff}
  .hsn{font-size:9px;color:#444}
  .meta{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px}
</style></head><body>
  <h1>Delivery Challan</h1>
  <div class="meta">
    <div><b>Delivery Challan No:</b> ${esc(data.creditNoteNo)}</div>
    <div><b>Date:</b> ${esc(data.creditNoteDate)}</div>
    <div><b>Order No:</b> ${esc(data.orderNo)}</div>
    <div><b>Portal:</b> ${esc(data.portal)}</div>
  </div>
  <div class="boxes">
    <div class="box"><h3>From</h3>${from || '-'}</div>
    <div class="box"><h3>Bill To</h3>${to || '-'}</div>
    <div class="box"><h3>Ship To</h3>${ship || '-'}</div>
  </div>
  <table><thead><tr>
    <th>Sr</th><th>Product Name</th><th>Product Code</th><th>Qty</th><th>Rate</th><th>Taxable</th>
    ${igst ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}
    <th>Amount</th>
  </tr></thead><tbody>${rows || '<tr><td colspan="9">No lines</td></tr>'}</tbody></table>
  ${data.totals?.totalAmount ? `<p><b>Total:</b> Qty ${esc(data.totals.totalQty)} · Amount ${esc(data.totals.totalAmount)}</p>` : ''}
  ${data.amountWords ? `<p><b>Amount Chargeable (in words):</b> ${esc(data.amountWords)}</p>` : ''}
</body></html>`;
}

function wrapText(font, text, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const trial = `${cur} ${words[i]}`;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) cur = trial;
    else { lines.push(cur); cur = words[i]; }
  }
  lines.push(cur);
  return lines;
}

/** PDF Delivery Challan mirroring Uniware CN structure, filled from parsed data. */
export async function renderDeliveryChallanPdf(data = {}) {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595;
  const H = 842;
  const margin = 24;
  const igst = data.taxMode === 'igst';

  const lines = data.lines?.length ? data.lines : [];
  // Paginate ~18 product rows per page after the header block on page 1; more on continuation.
  const firstPageRows = 16;
  const nextPageRows = 28;
  const pages = [];
  if (!lines.length) pages.push([]);
  else {
    pages.push(lines.slice(0, firstPageRows));
    for (let i = firstPageRows; i < lines.length; i += nextPageRows) {
      pages.push(lines.slice(i, i + nextPageRows));
    }
  }

  const drawText = (page, str, x, y, size = 8, bold = false, color = BLACK) => {
    const t = String(str ?? '');
    if (!t) return;
    page.drawText(t.slice(0, 120), { x, y, size, font: bold ? helvBold : helv, color });
  };
  const drawLine = (page, x0, y0, x1, y1) => {
    page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 0.7, color: rgb(0.15, 0.15, 0.15) });
  };
  const drawRect = (page, x, y, w, h) => {
    drawLine(page, x, y, x + w, y);
    drawLine(page, x, y + h, x + w, y + h);
    drawLine(page, x, y, x, y + h);
    drawLine(page, x + w, y, x + w, y + h);
  };

  const colDefs = igst
    ? [
      { key: 'sr', title: 'Sr', x: margin, w: 22 },
      { key: 'name', title: 'Product Name', x: margin + 22, w: 150 },
      { key: 'code', title: 'Product Code', x: margin + 172, w: 95 },
      { key: 'qty', title: 'Qty', x: margin + 267, w: 36 },
      { key: 'rate', title: 'Rate', x: margin + 303, w: 42 },
      { key: 'taxable', title: 'Taxable', x: margin + 345, w: 55 },
      { key: 'igst', title: 'IGST', x: margin + 400, w: 55 },
      { key: 'amount', title: 'Amount', x: margin + 455, w: W - margin - (margin + 455) },
    ]
    : [
      { key: 'sr', title: 'Sr', x: margin, w: 22 },
      { key: 'name', title: 'Product Name', x: margin + 22, w: 130 },
      { key: 'code', title: 'Product Code', x: margin + 152, w: 88 },
      { key: 'qty', title: 'Qty', x: margin + 240, w: 32 },
      { key: 'rate', title: 'Rate', x: margin + 272, w: 38 },
      { key: 'taxable', title: 'Taxable', x: margin + 310, w: 50 },
      { key: 'cgst', title: 'CGST', x: margin + 360, w: 48 },
      { key: 'sgst', title: 'SGST', x: margin + 408, w: 48 },
      { key: 'amount', title: 'Amount', x: margin + 456, w: W - margin - (margin + 456) },
    ];

  const drawTableHeader = (page, yTop) => {
    const rowH = 18;
    const y = yTop - rowH;
    page.drawRectangle({ x: margin, y, width: W - 2 * margin, height: rowH, color: NAVY });
    for (const c of colDefs) {
      drawText(page, c.title, c.x + 3, y + 5, 7, true, rgb(1, 1, 1));
      drawLine(page, c.x, y, c.x, y + rowH);
    }
    drawLine(page, margin + (W - 2 * margin), y, margin + (W - 2 * margin), y + rowH);
    drawLine(page, margin, y, W - margin, y);
    drawLine(page, margin, y + rowH, W - margin, y + rowH);
    return y;
  };

  const drawProductRows = (page, rows, startY) => {
    let y = startY;
    for (const r of rows) {
      const nameLines = wrapText(helv, r.name || '', 7, colDefs.find((c) => c.key === 'name').w - 6);
      const hsnLine = r.hsn ? `HSN code: ${r.hsn}` : '';
      const extra = (hsnLine ? 1 : 0) + Math.max(0, nameLines.length - 1);
      const rowH = 14 + extra * 9;
      y -= rowH;
      if (y < 40) break;
      drawRect(page, margin, y, W - 2 * margin, rowH);
      for (const c of colDefs) drawLine(page, c.x, y, c.x, y + rowH);

      let nameY = y + rowH - 10;
      for (const nl of nameLines.slice(0, 3)) {
        drawText(page, nl, colDefs.find((c) => c.key === 'name').x + 3, nameY, 7);
        nameY -= 9;
      }
      if (hsnLine) drawText(page, hsnLine, colDefs.find((c) => c.key === 'name').x + 3, y + 3, 6, false, GREY);

      const cellY = y + rowH - 10;
      for (const c of colDefs) {
        if (c.key === 'name') continue;
        const val = c.key === 'sr' ? (r.sr || '') : (r[c.key] || '');
        // strip trailing percent from tax cells for main line; percent drawn smaller if present
        const main = String(val).replace(/\s*\([\d.]+%\)\s*/g, '').trim();
        const pct = String(val).match(/\([\d.]+%\)/);
        drawText(page, main, c.x + 3, cellY, 7);
        if (pct && (c.key === 'cgst' || c.key === 'sgst' || c.key === 'igst')) {
          drawText(page, pct[0], c.x + 3, cellY - 9, 6, false, GREY);
        }
      }
    }
    return y;
  };

  const drawAddressBox = (page, title, lines, x, yBottom, w, h) => {
    drawRect(page, x, yBottom, w, h);
    drawText(page, title, x + 5, yBottom + h - 12, 8, true);
    let yy = yBottom + h - 24;
    for (const raw of (lines || []).slice(0, 10)) {
      const t = String(raw || '').trim();
      if (!t) continue;
      const wrapped = wrapText(helv, t, 7, w - 10);
      for (const wl of wrapped) {
        if (yy < yBottom + 6) break;
        drawText(page, wl, x + 5, yy, 7);
        yy -= 9;
      }
    }
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const page = doc.addPage([W, H]);
    let y = H - margin;

    if (pi === 0) {
      drawText(page, 'Delivery Challan', W / 2 - 55, y - 6, 14, true);
      y -= 22;

      // Meta row
      drawText(page, 'Delivery Challan No:', margin, y, 8, true);
      drawText(page, data.creditNoteNo || data.bulkReturnId || '', margin + 105, y, 8);
      drawText(page, 'Date:', 280, y, 8, true);
      drawText(page, data.creditNoteDate || '', 310, y, 8);
      drawText(page, 'Order No:', 420, y, 8, true);
      drawText(page, data.orderNo || '', 470, y, 8);
      y -= 12;
      if (data.orderDate || data.portal) {
        if (data.orderDate) {
          drawText(page, 'Order Date:', margin, y, 8, true);
          drawText(page, data.orderDate, margin + 60, y, 8);
        }
        if (data.portal) {
          drawText(page, 'Portal:', 280, y, 8, true);
          drawText(page, data.portal, 315, y, 8);
        }
        if (data.bulkReturnId) {
          drawText(page, 'Bulk Return:', 420, y, 7, true);
          drawText(page, data.bulkReturnId, 480, y, 7);
        }
        y -= 14;
      }

      // Address boxes: From (customer) | Bill To (Opptra) | Ship To (Opptra)
      const boxH = 110;
      const gap = 6;
      const boxW = (W - 2 * margin - 2 * gap) / 3;
      const boxBottom = y - boxH;
      drawAddressBox(page, 'From', data.fromLines, margin, boxBottom, boxW, boxH);
      drawAddressBox(page, 'Bill To', data.toLines, margin + boxW + gap, boxBottom, boxW, boxH);
      drawAddressBox(page, 'Ship To', data.shipToLines || data.toLines, margin + 2 * (boxW + gap), boxBottom, boxW, boxH);
      y = boxBottom - 10;
    } else {
      drawText(page, `Delivery Challan ${data.creditNoteNo || ''} (continued)`, margin, y - 4, 10, true);
      y -= 18;
    }

    y = drawTableHeader(page, y);
    y = drawProductRows(page, pages[pi], y);

    // Totals + words only on last page
    if (pi === pages.length - 1) {
      // Totals as the LAST ROW of the table: bordered, column-aligned, flush with
      // the product rows above (not floating text below the table).
      const t = data.totals || {};
      const totRowH = 16;
      y -= totRowH;
      drawRect(page, margin, y, W - 2 * margin, totRowH);
      for (const c of colDefs) drawLine(page, c.x, y, c.x, y + totRowH);
      const putTotal = (key, val) => {
        const c = colDefs.find((cd) => cd.key === key);
        if (c && val) drawText(page, val, c.x + 3, y + 5, 7, true);
      };
      drawText(page, 'Total:', colDefs.find((c) => c.key === 'name').x + 3, y + 5, 8, true);
      putTotal('qty', t.totalQty);
      putTotal('taxable', t.totalTaxable);
      if (igst) putTotal('igst', t.totalTax1);
      else { putTotal('cgst', t.totalTax1); putTotal('sgst', t.totalTax2); }
      putTotal('amount', t.totalAmount);
      y -= 18;
      if (data.amountWords) {
        drawText(page, 'Amount Chargeable (in words)', margin, y, 8, true);
        y -= 12;
        for (const wl of wrapText(helv, data.amountWords, 8, W - 2 * margin)) {
          drawText(page, wl, margin, y, 8);
          y -= 11;
        }
      }
      y -= 8;
      drawText(page, 'This is a Delivery Challan for reverse movement, not a tax invoice.', margin, Math.max(28, y), 7, false, GREY);
    }
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
