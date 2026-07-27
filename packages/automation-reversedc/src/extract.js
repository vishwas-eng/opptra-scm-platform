// Read the two party blocks off the original credit note, exactly like the proven
// reverse_dc_from_cn.py did with PyMuPDF clips:
//   seller (Opptra entity) : rect (24, 237) - (185, 365), minus "Credit Note" label lines
//   customer (Bill To)     : rect (24, 384) - (185, 525)
// Coordinates are top-left based; pdf.js reports bottom-left, so we flip with pageHeight.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// y1 374 (not the legacy 365): pdf.js filters by text BASELINE, so the seller GSTIN
// line whose baseline sits at ~367 was dropped by the PyMuPDF-era bound. 374 catches
// it while staying above the "Bill To:" label strip (~378).
// These are FALLBACKS only - see computeLayout() below for why they can't be trusted
// as fixed bounds on every credit note.
const SELLER_RECT = { x0: 24, y0: 237, x1: 185, y1: 374 };
const BILLTO_RECT = { x0: 24, y0: 384, x1: 185, y1: 525 };
const CREDIT_LABELS = new Set(['Credit', 'Credit Note', 'Credit Note No:']);

// Unicommerce reflows this template: a longer Bill To / Ship To customer address pushes
// the product table further down the page. The seller block (top) is always the SAME
// fixed Opptra entity address, so it never varies - but the customer address does, per
// order. A fixed-pixel bottom bound (the legacy 525) works for a "typical" address and
// silently drops the LAST line - usually the city/state/pin or the GSTIN itself - for
// any customer with a longer one (this is the root cause of "GST missing" / "city
// missing" reports). Instead, read the real position of the "Bill To:" label and the
// product-table header off THIS document, and only fall back to the legacy constants
// when a label can't be found (a non-standard CN).
export function computeLayout(items) {
  const billToLabel = items.find((it) => /^Bill To:?$/i.test(it.str.trim()));
  const tableHeader = items.find((it) => /^Sr\.?\s*No\.?$/i.test(it.str.trim()) || /^Product\s*Name$/i.test(it.str.trim()));
  const billToTop = billToLabel ? billToLabel.yTop : 380.6;
  const tableTop = tableHeader ? tableHeader.yTop : 541;
  return {
    billToTop,
    tableTop,
    sellerRect: { ...SELLER_RECT, y1: Math.max(SELLER_RECT.y1, billToTop - 6) },
    billtoRect: { ...BILLTO_RECT, y0: Math.min(BILLTO_RECT.y0, billToTop + 4), y1: Math.max(BILLTO_RECT.y1, tableTop - 10) },
  };
}

export async function pageTextItems(pdfBuffer) {
  const all = await pageTextItemsAll(pdfBuffer);
  return all.filter((it) => it.page === 1);
}

/** Text items from every page (page is 1-based). Needed for multi-page CNs. */
export async function pageTextItemsAll(pdfBuffer) {
  const doc = await getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  try {
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { items } = await page.getTextContent();
      const H = page.getViewport({ scale: 1 }).viewBox[3];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        out.push({
          str: it.str,
          x: it.transform[4],
          yBase: it.transform[5],
          yTop: H - it.transform[5],
          width: it.width || 0,
          height: it.height || 8,
          page: p,
        });
      }
    }
    return out;
  } finally {
    await doc.destroy();
  }
}

function linesInRect(items, rect) {
  const inside = items.filter((it) => it.x >= rect.x0 - 1 && it.x <= rect.x1 && it.yTop >= rect.y0 - 1 && it.yTop <= rect.y1 + 1);
  // group items into lines by rounded y, left-to-right within a line, top-to-bottom overall
  const byLine = new Map();
  for (const it of inside) {
    const key = Math.round(it.yTop / 4) * 4; // 4pt tolerance handles tiny baseline jitter
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(it);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Unicommerce's own template prints the GSTIN line twice back-to-back in the Bill To /
// Ship To blocks on some credit notes (a template quirk, not our bug) - now that the
// bottom bound is widened dynamically, both copies can fall inside the rect. Collapse
// an exact repeat of the immediately preceding line rather than printing it twice.
const dedupeConsecutive = (lines) => lines.filter((l, i) => l !== lines[i - 1]);

/** { sellerLines, customerLines } from page 1 of the credit note. Either may be empty
 *  when a CN deviates from the standard layout - callers treat them as best-effort. */
export async function extractPartiesFromCn(pdfBuffer) {
  const items = await pageTextItems(pdfBuffer);
  const { sellerRect, billtoRect } = computeLayout(items);
  const sellerLines = dedupeConsecutive(linesInRect(items, sellerRect).filter((l) => !CREDIT_LABELS.has(l) && !/^(Bill To:?|Ship To:?)$/i.test(l)));
  const customerLines = dedupeConsecutive(linesInRect(items, billtoRect).filter((l) => !/^(Bill To:?|Ship To:?)$/i.test(l)));
  return { sellerLines, customerLines };
}
