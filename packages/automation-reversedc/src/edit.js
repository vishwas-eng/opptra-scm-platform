// Edit the ORIGINAL Uniware credit-note PDF into a Delivery Challan (pdf-lib, server-side).
// Same coordinates as the proven browser edit / reverse_dc_from_cn.py — NOT a new template:
// white-out the barcode + "Credit Note" labels + address boxes, then draw
// "Delivery Challan" + From(customer) + To(Opptra). The product table / IRN / amounts
// stay from the original underneath.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function editCreditNoteToDeliveryChallan(pdfBuffer, parties = {}, { removeBarcode = true } = {}) {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const page = doc.getPages()[0];
  const { height: H } = page.getSize();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Coordinates are measured top-left; pdf-lib is bottom-left, so flip with H - y.
  const whiteTop = (x0, y0, x1, y1) =>
    page.drawRectangle({ x: x0, y: H - y1, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0), color: rgb(1, 1, 1) });
  const textTop = (x, yTop, str, size = 8, font = helv) =>
    page.drawText(String(str || ''), { x, y: H - yTop, size, font, color: rgb(0, 0, 0) });

  if (removeBarcode) whiteTop(200, 295, 400, 355);          // 1) barcode zone
  whiteTop(250, 218, 360, 240);                              // 2) title
  whiteTop(188, 235, 270, 255);                              //    Credit Note No:
  whiteTop(408, 235, 500, 255);                              //    Credit Note Date
  whiteTop(20, 235, 188, 368);                               // 3) seller header
  whiteTop(20, 368, 188, 528);                               //    Bill To content
  whiteTop(188, 368, 405, 528);                              //    Ship To content
  whiteTop(20, 365, 230, 385);                               //    Bill/Ship label strip

  page.drawText('Delivery Challan', { x: 248, y: H - 234, size: 12, font: helvBold, color: rgb(0, 0, 0) });
  textTop(190.5, 249, 'Delivery Challan No:');
  textTop(412.5, 249, 'Delivery Challan Date');

  const fromLines = parties.fromLines || [];
  const toLines = parties.toLines || [];

  textTop(24, 248, 'From:');
  let y = 260;
  for (const raw of fromLines) {
    const fl = String(raw || '').slice(0, 48);
    if (fl) { textTop(24, y, fl, 7); y += 10; if (y > 360) break; }
  }

  const drawTo = (x, cap) => {
    textTop(x, 378, 'To:');
    let yy = 390;
    for (const raw of toLines) {
      const tl = String(raw || '').slice(0, cap);
      if (tl) { textTop(x, yy, tl, 7); yy += 10; if (yy > 520) break; }
    }
  };
  drawTo(24, 42);      // former Bill To slot
  drawTo(190.5, 48);   // former Ship To slot

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
