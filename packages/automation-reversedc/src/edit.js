// Edit the ORIGINAL Uniware credit-note PDF into a Delivery Challan (pdf-lib, server-side).
// Same coordinates as the proven browser edit / reverse_dc_from_cn.py - NOT a new template:
// white-out the barcodes + "Credit Note" labels + address boxes, then draw
// "Delivery Challan" + From(customer) + To(Opptra). The product table / IRN / amounts
// stay from the original underneath.
//
// From/To default to the addresses EXTRACTED from the credit note itself, swapped
// (From = the CN's Bill To customer, To = the CN's seller block), exactly like the
// legacy tool - typed lines only override. Without this, an empty form produced
// blank white address boxes that read as "invisible text".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { extractPartiesFromCn, pageTextItems, computeLayout } from './extract.js';

// Labels the legacy tool removed by TEXT SEARCH (exact glyph boxes, so the section
// border lines around them survive - wide blanket rectangles erased the box lines).
const LABEL_TEXTS = ['Credit Note No:', 'Credit Note Date', 'Credit Note', 'Bill To:', 'Ship To:'];

export async function editCreditNoteToDeliveryChallan(pdfBuffer, parties = {}, { removeBarcode = true, challanDate = '' } = {}) {
  const extracted = await extractPartiesFromCn(pdfBuffer).catch(() => ({ sellerLines: [], customerLines: [] }));
  const items = await pageTextItems(pdfBuffer).catch(() => []);
  // Same document-read layout used for extraction, so what gets ERASED and what gets
  // RE-EXTRACTED always agree on where the customer address block actually ends (see
  // computeLayout's comment - a longer Bill To address pushes the table further down).
  const layout = computeLayout(items);

  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const page = doc.getPages()[0];
  const { width: W, height: H } = page.getSize();
  // The fixed-coordinate operations (address rects, labels, top crop) assume the standard
  // Unicommerce A4 credit-note template (~595x842). Every UC CN for this account uses that
  // one template - only the CONTENT varies, which is handled adaptively (text search +
  // box-region extraction). If a PDF arrives at a very different size it's NOT that
  // template, so we skip the layout-specific edits rather than mangle it; the text-adaptive
  // removals and address swap still run.
  const isUcTemplate = W > 560 && W < 620 && H > 800 && H < 900;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Coordinates are measured top-left; pdf-lib is bottom-left, so flip with H - y.
  const whiteTop = (x0, y0, x1, y1) =>
    page.drawRectangle({ x: x0, y: H - y1, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), color: rgb(1, 1, 1) });
  const textTop = (x, yTop, str, size = 8, font = helv) =>
    page.drawText(String(str || ''), { x, y: H - yTop, size, font, color: rgb(0, 0, 0) });
  // White-out one text item's glyph box (baseline coords straight from pdf.js). Default
  // is TIGHT because cell border lines run 2-3pt above the labels and any vertical
  // padding erases border segments (the "lines not visible" bug). `loose` is for text
  // sitting in open cell space (e.g. the $shippingPackage template var) that no border
  // touches - there a fuller box guarantees complete coverage.
  const whiteItem = (it, loose = false) => page.drawRectangle(loose
    ? { x: it.x - 1, y: it.yBase - 3, width: it.width + 4, height: it.height + 6, color: rgb(1, 1, 1) }
    : { x: it.x - 0.5, y: it.yBase - 1.5, width: it.width + 1, height: it.height + 1, color: rgb(1, 1, 1) });

  if (removeBarcode) {
    whiteTop(200, 295, 400, 355);                            // 1a) order barcode under Order No
    whiteTop(40, 35, 170, 165);                              // 1b) QR code top-left
  }

  // 2) text-targeted removals (label texts, IRN, unrendered template junk, stray GSTIN)
  let irnTop = null;
  for (const it of items) {
    const s = it.str.trim();
    if (LABEL_TEXTS.includes(s)) whiteItem(it);
    if (s.startsWith('IRN')) { whiteItem(it); irnTop = it.yTop; }
    if (s.includes('$shippingPackage') || s.includes('noOfBoxes')) whiteItem(it, true); // UC template var that never rendered
    // GSTIN lines whose glyphs hang just below the (dynamic) address rects - PyMuPDF
    // redactions caught intersecting glyphs, plain rectangles don't, so target the text
    // itself. Bands follow the SAME per-document bottoms as the rects below, not fixed
    // pixels, so a longer customer address doesn't leave its GSTIN un-erased.
    if (/GSTIN/i.test(s) && it.x < 188 && (
      (it.yTop > layout.sellerRect.y1 - 16 && it.yTop < layout.sellerRect.y1 + 8) ||
      (it.yTop > layout.billtoRect.y1 - 4 && it.yTop < layout.billtoRect.y1 + 24)
    )) whiteItem(it);
  }
  if (irnTop !== null) {
    // the IRN wraps to a short second line - white anything just below it
    for (const it of items) if (it.yTop > irnTop && it.yTop < irnTop + 26 && it.x < 200) whiteItem(it);
  }

  // 3) the three address regions - bottoms follow the document's real layout (see
  // computeLayout), insets kept from the legacy tool so the rectangle edges can never
  // clip the cell border lines they sit against
  whiteTop(24, 239, 185, layout.sellerRect.y1 - 11);          // seller header
  whiteTop(24, layout.billToTop + 6, 185, layout.billtoRect.y1 - 2);   // Bill To content
  whiteTop(190, layout.billToTop + 6, 400, layout.billtoRect.y1 - 2); // Ship To content

  page.drawText('Delivery Challan', { x: 248, y: H - 234, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  textTop(190.5, 249, 'Delivery Challan No:');
  textTop(412.5, 249, 'Delivery Challan Date');

  // The date value sits one line under its label on this template. When the credit note
  // arrived without one, write the caller's date there so the challan is never undated.
  if (challanDate) {
    const dateLabel = items.find((it) => /^Credit Note Date/i.test(it.str.trim()));
    const anchorX = dateLabel?.x ?? 412.5;
    const anchorY = dateLabel?.yTop ?? 249;
    const hasValue = items.some((it) => it !== dateLabel
      && Math.abs(it.x - anchorX) < 40
      && it.yTop > anchorY + 6 && it.yTop < anchorY + 22
      && it.str.trim());
    if (!hasValue) textTop(anchorX, anchorY + 15, challanDate);
  }

  const clean = (lines) => (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
  const fromLines = clean(parties.fromLines).length ? clean(parties.fromLines) : extracted.customerLines;
  const toLines = clean(parties.toLines).length ? clean(parties.toLines) : extracted.sellerLines;

  // Company-name lines are bold on the original CN (address lines stay regular). A line
  // is a name line if it's mostly uppercase or carries a company suffix word - and only
  // among the first 3 lines, so a later ALL-CAPS token can't get bolded by accident.
  const NAME_WORD = /\b(LIMITED|LTD|PRIVATE|PVT|LLP|SOLUTIONS|COMMERCE|ENTERPRISES|INDUSTRIES|RETAIL|INNOVATIVE)\b/i;
  const isNameLine = (line, idx) => {
    if (idx > 2) return false;
    const letters = line.replace(/[^A-Za-z]/g, '');
    const upperRatio = letters ? (line.replace(/[^A-Z]/g, '').length / letters.length) : 0;
    return upperRatio > 0.7 || NAME_WORD.test(line);
  };
  const drawBlock = (x, topLabelY, firstLineY, lines, cap, maxY) => {
    let yy = firstLineY;
    lines.forEach((raw, idx) => {
      const t = String(raw || '').slice(0, cap);
      if (t && yy <= maxY) { textTop(x, yy, t, 7, isNameLine(t, idx) ? helvBold : helv); yy += 10; }
    });
  };

  // maxY caps used to be fixed pixels (360 / 520) sized for the SHORT, fixed seller
  // address that used to live in these slots. After the swap, the "From" slot holds the
  // customer's address instead - which varies in length per order - so a fixed cap
  // silently dropped its last line (commonly the GSTIN) once an address ran long. Both
  // caps now track the same per-document boundaries used for extraction/erasure.
  textTop(24, 248, 'From:');
  drawBlock(24, 248, 260, fromLines, 48, layout.billToTop - 12);

  const toLabelY = layout.billToTop - 2.6;
  // Keep the original CN label names (Bill To / Ship To) - "To:" alone looked blank
  // and ops couldn't tell which box was which on the Delivery Challan.
  textTop(24, toLabelY, 'Bill To:');
  drawBlock(24, toLabelY + 12, toLabelY + 12, toLines, 42, layout.tableTop - 16);     // former Bill To slot
  textTop(190.5, toLabelY, 'Ship To:');
  drawBlock(190.5, toLabelY + 12, toLabelY + 12, toLines, 48, layout.tableTop - 16);  // former Ship To slot

  // Pull content up: the CN template's top ~175pt (removed QR + IRN) is dead space now.
  // The logo/title start at ~yTop 185, so crop the page's top band down to a ~20pt margin
  // above them - conservative so the logo can never be clipped on any CN of this template.
  // Cropping (not moving) keeps every element's exact position; the visible / printed page
  // just starts at the content. Applied last so all drawing coords stayed valid.
  if (isUcTemplate) {
    const TOP_TRIM = 165;
    const newHeight = H - TOP_TRIM;
    page.setCropBox(0, 0, W, newHeight);
    page.setMediaBox(0, 0, W, newHeight);
  }

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
