// Parse a Uniware credit-note PDF into structured fields for a Delivery Challan.
// Layout-proof: reads text positions from ALL pages (no fixed paint coordinates).
import { pageTextItems, pageTextItemsAll, computeLayout, extractPartiesFromCn } from './extract.js';

function afterLabel(items, labelRe, { maxDy = 20 } = {}) {
  const label = items.find((it) => labelRe.test(it.str.trim()));
  if (!label) return '';
  const next = items
    .filter((it) => it.page === label.page && it !== label)
    .filter((it) => it.yTop > label.yTop - 2 && it.yTop < label.yTop + maxDy)
    .sort((a, b) => (a.yTop - b.yTop) || (a.x - b.x));
  const right = next.find((it) => it.x >= label.x + Math.max(label.width - 2, 8) && it.yTop < label.yTop + 10);
  if (right && !/^(Credit|Bill|Ship|Order|No\.?|Date|Portal|Delivery)/i.test(right.str.trim())) return right.str.trim();
  const below = next.find((it) => it.yTop > label.yTop + 4 && Math.abs(it.x - label.x) < 40);
  return below ? below.str.trim() : '';
}

function findHeaderCols(items) {
  // Detect product-table column x positions from header labels (varies slightly per CN).
  const page1 = items.filter((it) => it.page === 1);
  const pick = (re) => page1.find((it) => re.test(it.str.trim()));
  const product = pick(/^Product\s*Name$/i);
  const code = pick(/^Product\s*Code\.?$/i);
  const qty = pick(/^Qty\.?$/i);
  const rate = pick(/^Rate$/i);
  // Some templates render "Taxable Value" as one token, others wrap it ("Taxable" / "Value" / "(INR)")
  const taxable = pick(/^Taxable(\s+Value)?$/i);
  const cgst = pick(/^CGST(\s*\(INR\))?$/i);
  const sgst = pick(/^SGST(\s*\(INR\))?$/i);
  const igst = pick(/^IGST(\s*\(INR\))?$/i);
  const amount = pick(/^Amount(\s*\(INR\))?$/i);
  const sr = pick(/^Sr\.?(\s*No\.?)?$/i) || pick(/^No\.?$/i);
  if (!product) return null;
  return {
    tableTop: product.yTop,
    sr: sr?.x ?? 22,
    name: product.x,
    code: code?.x ?? product.x + 140,
    qty: qty?.x ?? 336,
    rate: rate?.x ?? 365,
    taxable: taxable?.x ?? 400,
    cgst: cgst?.x ?? null,
    sgst: sgst?.x ?? null,
    igst: igst?.x ?? null,
    amount: amount?.x ?? 536,
    hasCgst: !!cgst,
    hasIgst: !!igst,
  };
}

function colBoundaries(cols) {
  // Build left-edge boundaries from header midpoints so content left of a centered
  // header (common on Uniware) still maps to the right column.
  const ordered = ['sr', 'name', 'code', 'qty', 'rate', 'taxable', 'cgst', 'sgst', 'igst', 'amount']
    .filter((k) => cols[k] != null)
    .map((k) => ({ key: k, x: cols[k] }));
  const bounds = [];
  for (let i = 0; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const next = ordered[i + 1];
    const left = prev ? (prev.x + cur.x) / 2 : 0;
    const right = next ? (cur.x + next.x) / 2 : 9999;
    bounds.push({ key: cur.key, left, right });
  }
  return bounds;
}

function colAt(x, bounds) {
  for (const b of bounds) {
    if (x >= b.left && x < b.right) return b.key;
  }
  return null;
}

function extractLineItems(items) {
  const cols = findHeaderCols(items);
  if (!cols) return [];
  const bounds = colBoundaries(cols);

  const footerRe = /^(Total:?|Sub\s*Total|Amount Chargeable|Tax is payable|Declaration|Bill By|Powered By|E\.\s*&\s*O\.E)/i;
  const rows = [];

  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const pageItems = items.filter((it) => it.page === page);
    const minY = page === 1 ? cols.tableTop + 12 : 0;
    const footer = pageItems.find((it) => footerRe.test(it.str.trim()) && it.yTop > minY);
    const maxY = footer ? footer.yTop - 4 : 900;

    const body = pageItems.filter((it) => it.yTop > minY && it.yTop < maxY);
    const srItems = body
      .filter((it) => it.x < 45 && /^\d{1,3}$/.test(it.str.trim()))
      .sort((a, b) => a.yTop - b.yTop);

    for (let si = 0; si < srItems.length; si++) {
      const sr = srItems[si];
      // Never let this row's wrap-window swallow the NEXT row's cells on tight layouts.
      const nextTop = srItems[si + 1]?.yTop ?? Infinity;
      const belowMax = Math.min(sr.yTop + 26, nextTop - 2);
      const band = body.filter((it) => Math.abs(it.yTop - sr.yTop) < 3.5);
      const below = body
        .filter((it) => it.yTop > sr.yTop + 3 && it.yTop < belowMax)
        .sort((a, b) => (a.yTop - b.yTop) || (a.x - b.x));
      const row = {
        sr: sr.str.trim(),
        name: '', code: '', hsn: '', qty: '', rate: '', taxable: '',
        cgst: '', sgst: '', igst: '', amount: '',
      };
      const NUM_COLS = ['qty', 'rate', 'taxable', 'cgst', 'sgst', 'igst', 'amount'];
      for (const it of band) {
        if (it === sr) continue;
        const col = colAt(it.x, bounds);
        const v = it.str.trim();
        if (!col || col === 'sr') {
          if (it.x >= 40 && it.x < cols.code - 15) row.name = row.name ? `${row.name} ${v}` : v;
          continue;
        }
        if (col === 'name') row.name = row.name ? `${row.name} ${v}` : v;
        else if (!row[col]) row[col] = v;
        else if (NUM_COLS.includes(col) && /^[\d,.]+$/.test(v)) row[col] += v; // same-band numeric split
      }
      for (const it of below) {
        const t = it.str.trim();
        if (/^HSN\s*code:/i.test(t)) { row.hsn = t.replace(/^HSN\s*code:\s*/i, ''); continue; }
        if (/^\([\d.]+%\)$/.test(t)) {
          if (cols.hasCgst && it.x < (cols.sgst ?? 999)) {
            if (row.cgst && !row.cgst.includes('%')) row.cgst = `${row.cgst} ${t}`;
          } else if (row.sgst && !row.sgst.includes('%')) row.sgst = `${row.sgst} ${t}`;
          else if (row.igst && !row.igst.includes('%')) row.igst = `${row.igst} ${t}`;
          continue;
        }
        const col = colAt(it.x, bounds);
        // Wrapped product name → append; wrapped number ("280205.7" + "8") → concatenate.
        if (col === 'name') row.name = row.name ? `${row.name} ${t}` : t;
        else if (col && NUM_COLS.includes(col) && /^[\d,.]+$/.test(t)) row[col] = (row[col] || '') + t;
      }
      if (row.name || row.code) rows.push(row);
    }
  }
  return rows;
}

function extractTotals(items) {
  const totalLabel = items.find((it) => /^Total:?$/i.test(it.str.trim()));
  if (!totalLabel) return {};
  const band = items
    .filter((it) => it.page === totalLabel.page && Math.abs(it.yTop - totalLabel.yTop) < 4)
    .sort((a, b) => a.x - b.x);
  // Wrapped digits: a long total ("280205.7" / "8") continues just below the band —
  // stitch pure-digit continuations back onto the nearest number to their left.
  const wraps = items.filter((it) => it.page === totalLabel.page
    && it.yTop > totalLabel.yTop + 4 && it.yTop < totalLabel.yTop + 18
    && /^[\d,.]+$/.test(it.str.trim()));
  const nums = [];
  for (const it of band) {
    const s = it.str.trim();
    if (!/^[\d,.]+$/.test(s)) continue;
    const wrap = wraps.find((w) => w.x >= it.x - 8 && w.x <= it.x + Math.max(it.width, 30) + 45);
    nums.push(wrap ? s + wrap.str.trim() : s);
  }
  // Typical: qty, taxable, cgst, sgst, amount (or with IGST: qty, taxable, igst, amount)
  return {
    totalQty: nums[0] || '',
    totalTaxable: nums[1] || '',
    totalTax1: nums[2] || '',
    totalTax2: nums[3] || '',
    totalAmount: nums[nums.length - 1] || '',
  };
}

function extractShipTo(items, layout) {
  // Ship To column sits roughly x 190–400 between Bill To label and table.
  const shipLabel = items.find((it) => /^Ship To:?$/i.test(it.str.trim()));
  const y0 = shipLabel ? shipLabel.yTop + 4 : layout.billToTop + 4;
  const y1 = layout.tableTop - 8;
  const inShip = items.filter((it) => it.page === 1 && it.x >= 185 && it.x < 405 && it.yTop >= y0 && it.yTop <= y1);
  const byLine = new Map();
  for (const it of inShip) {
    const key = Math.round(it.yTop / 4) * 4;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(it);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^Ship To:?$/i.test(l))
    .filter((l, i, arr) => l !== arr[i - 1]);
}

/** Full structured parse of a Uniware credit-note PDF (all pages). */
export async function parseCreditNote(pdfBuffer) {
  const items = await pageTextItemsAll(pdfBuffer);
  const page1 = items.filter((it) => it.page === 1);
  const layout = computeLayout(page1);
  const parties = await extractPartiesFromCn(pdfBuffer);

  const creditNoteNo = afterLabel(page1, /^Credit Note No:?$/i) || afterLabel(page1, /^Credit Note$/i);
  const creditNoteDate = afterLabel(page1, /^Credit Note Date$/i);
  const orderNo = afterLabel(page1, /^Order No:?/i, { maxDy: 8 })
    || (page1.find((it) => /Order No:\s*(.+)/i.test(it.str))?.str.match(/Order No:\s*(.+)/i)?.[1] || '').trim();
  const orderDate = (page1.find((it) => /Order Date:\s*(.+)/i.test(it.str))?.str.match(/Order Date:\s*(.+)/i)?.[1] || '').trim();
  const portal = afterLabel(page1, /^Portal:?$/i)
    || (() => {
      const lab = page1.find((it) => /^Portal:?$/i.test(it.str.trim()));
      if (!lab) return '';
      const right = page1.find((it) => it.yTop > lab.yTop - 2 && it.yTop < lab.yTop + 8 && it.x > lab.x + 10);
      return right?.str.trim() || '';
    })();

  const lines = extractLineItems(items);
  const totals = extractTotals(items);
  let shipToLines = extractShipTo(items, layout);
  // Prefer customer lines for ship-to if ship block empty; DC swaps To = seller
  if (shipToLines.filter((l) => !/^GSTIN/i.test(l)).length < 2) shipToLines = parties.customerLines;

  const amountWords = (() => {
    const lab = items.find((it) => /Amount Chargeable/i.test(it.str));
    if (!lab) return '';
    return items
      .filter((it) => it.page === lab.page && it.yTop > lab.yTop + 4 && it.yTop < lab.yTop + 80 && it.x < 300)
      .sort((a, b) => a.yTop - b.yTop)
      .map((it) => it.str.trim())
      .filter((s) => s && !/^Tax is payable/i.test(s) && !/^Declaration/i.test(s))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  })();

  return {
    creditNoteNo,
    creditNoteDate,
    orderNo,
    orderDate,
    portal,
    // Swap for Delivery Challan: From = customer (Bill To), To = seller (Opptra)
    fromLines: parties.customerLines,
    toLines: parties.sellerLines,
    shipToLines: parties.sellerLines, // reverse DC: ship to Opptra warehouse entity
    sellerLines: parties.sellerLines,
    customerLines: parties.customerLines,
    lines,
    totals,
    amountWords,
    layout,
    taxMode: findHeaderCols(items)?.hasIgst ? 'igst' : 'cgst',
  };
}
