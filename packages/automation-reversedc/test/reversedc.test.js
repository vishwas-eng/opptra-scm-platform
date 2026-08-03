import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { editCreditNoteToDeliveryChallan } from '../src/edit.js';

async function blankA4Pdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // A4 in points
  return Buffer.from(await doc.save());
}

test('edit produces a valid one-page PDF (Credit Note → Delivery Challan)', async () => {
  const src = await blankA4Pdf();
  const out = await editCreditNoteToDeliveryChallan(src, { fromLines: ['Customer X', 'GSTIN: 29ABC'], toLines: ['Opptra Retail Pvt Ltd'] });
  const reloaded = await PDFDocument.load(out);
  assert.equal(reloaded.getPageCount(), 1);
  assert.ok(Buffer.isBuffer(out) && out.length > 500);
});

test('removeBarcode:false still returns a valid PDF', async () => {
  const out = await editCreditNoteToDeliveryChallan(await blankA4Pdf(), { fromLines: [], toLines: [] }, { removeBarcode: false });
  assert.ok(out.length > 500);
});

// Against the REAL sample credit note: the addresses must come off the document itself
// (swapped: From = the CN's Bill To customer, To = the CN's seller entity) when the
// form is left empty - the exact case that used to produce blank white boxes.
test('empty form input: parties are auto-extracted from the CN and swapped', async () => {
  const { readFileSync } = await import('node:fs');
  const { extractPartiesFromCn } = await import('../src/extract.js');
  const src = readFileSync(new URL('./fixtures/sample-cn.pdf', import.meta.url));
  const p = await extractPartiesFromCn(src);
  assert.match(p.customerLines.join(' '), /BLINK COMMERCE/i, 'From = customer from Bill To');
  assert.match(p.customerLines.join(' '), /GSTIN/i);
  assert.match(p.sellerLines.join(' '), /OppDoor/i, 'To = seller entity');
  assert.match(p.sellerLines.join(' '), /GSTIN: 27AAECO4444P1ZX/, 'seller GSTIN captured');
  assert.ok(!p.sellerLines.some((l) => /Credit Note/i.test(l)), 'Credit Note labels filtered');
  const out = await editCreditNoteToDeliveryChallan(src, {}, { removeBarcode: true });
  assert.ok(out.length > 10_000, 'full document survives the edit');
});

// Robustness: a PDF that is NOT the standard UC A4 template (wrong page size) must not
// get mangled by the fixed layout coordinates - it survives as a valid PDF, with only
// the text-adaptive removals applied.
test('non-UC-template page size: layout edits are skipped, PDF stays valid', async () => {
  const { PDFDocument: P } = await import('pdf-lib');
  const doc = await P.create();
  doc.addPage([300, 300]); // clearly not the ~595x842 UC template
  const weird = Buffer.from(await doc.save());
  const out = await editCreditNoteToDeliveryChallan(weird, { fromLines: ['X'], toLines: ['Y'] });
  const reloaded = await P.load(out);
  assert.equal(reloaded.getPageCount(), 1);
  const [pg] = reloaded.getPages();
  // page NOT cropped to the A4-template height (would be 300 - 165 = 135 if wrongly cropped)
  assert.ok(pg.getHeight() > 200, 'small non-template page not crop-mangled');
});

// Regression: Unicommerce pushes the product table down when the Bill To / Ship To
// customer address has more lines than usual. A fixed-pixel bottom bound (the legacy
// 525) silently truncates the LAST lines of such an address - in practice the
// city/state/pin ("...Nashik...") and/or the GSTIN. Build a synthetic CN with a
// longer-than-typical Bill To block and confirm nothing gets dropped.
test('a longer-than-usual Bill To address keeps its last lines (city + GSTIN)', async () => {
  const { PDFDocument: P, StandardFonts } = await import('pdf-lib');
  const { extractPartiesFromCn } = await import('../src/extract.js');
  const doc = await P.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const H = 842;
  const put = (x, yTop, s) => page.drawText(s, { x, y: H - yTop, size: 7, font: helv });
  put(24, 380.6, 'Bill To:');
  put(190.5, 380.6, 'Ship To:');
  const billLines = [
    'A VERY LONG CUSTOMER NAME PRIVATE LIMITED',
    'Building Number Twelve, Long Society Road',
    'Near Big Landmark, Extended Colony Phase Two',
    'Behind Old Water Tank, Sector Nine',
    'Opposite Community Hall, Main Road',
    'Cross Street Number Five, Industrial Area',
    'Additional Locality Description Line',
    'District Area Extension Block C',
    'Nashik, Maharashtra 422101',
    'India',
    'GSTIN: 27ZZZZZ9999Z1ZZ',
  ];
  let y = 395.6;
  for (const l of billLines) { put(24, y, l); y += 15; } // wider than the ~9-line typical case
  put(30.1, y + 20, 'Sr');
  put(97.3, y + 20, 'Product Name');
  const src = Buffer.from(await doc.save());

  const { customerLines } = await extractPartiesFromCn(src);
  assert.ok(customerLines.some((l) => l.includes('Nashik')), 'city line survives a long address');
  assert.ok(customerLines.some((l) => l.includes('GSTIN')), 'GSTIN survives a long address');

  const out = await editCreditNoteToDeliveryChallan(src, {}, { removeBarcode: false });
  const reloaded = await P.load(out);
  assert.equal(reloaded.getPageCount(), 1);
});

// The standard UC CN is cropped up (top dead-space removed) and stays a valid one-pager.
test('standard UC credit note is cropped up and remains valid', async () => {
  const { readFileSync } = await import('node:fs');
  const { PDFDocument: P } = await import('pdf-lib');
  const src = readFileSync(new URL('./fixtures/sample-cn.pdf', import.meta.url));
  const out = await editCreditNoteToDeliveryChallan(src, {}, { removeBarcode: true });
  const [pg] = (await P.load(out)).getPages();
  assert.ok(pg.getHeight() < 700 && pg.getHeight() > 640, 'A4 CN cropped from 842 to ~677');
});

// Layout-proof path: parse ALL pages of a real multi-page CN and rebuild a DC that
// still carries every product line (this is what breaks when we paint fixed coords).
test('parse+rebuild: sample CN keeps all line items across pages', async () => {
  const { readFileSync } = await import('node:fs');
  const { PDFDocument: P } = await import('pdf-lib');
  const { parseCreditNote } = await import('../src/parseCn.js');
  const { makeReverseDcPipeline } = await import('../src/pipeline.js');
  const src = readFileSync(new URL('./fixtures/sample-cn.pdf', import.meta.url));

  const parsed = await parseCreditNote(src);
  assert.match(parsed.creditNoteNo, /SRRMH2627\/0134/);
  assert.match(parsed.fromLines.join(' '), /BLINK COMMERCE/i);
  assert.match(parsed.toLines.join(' '), /OppDoor/i);
  assert.ok(parsed.lines.length >= 10, `expected ≥10 lines, got ${parsed.lines.length}`);
  assert.match(parsed.lines[0].name, /Black Graphic/i);
  assert.match(parsed.lines[0].code, /HAMLEYS-494757136/);
  assert.equal(parsed.lines[0].qty, '75');
  assert.ok(parsed.lines.some((l) => l.sr === '10'), 'page-2 line 10 present');
  assert.ok(parsed.totals.totalAmount, 'totals parsed');

  const pipe = makeReverseDcPipeline(null);
  const r = await pipe.buildFromUpload(src);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'rebuild');
  assert.ok(r.lineCount >= 10);
  const reloaded = await P.load(Buffer.from(r.file.base64, 'base64'));
  assert.ok(reloaded.getPageCount() >= 1);
});

// Hybrid gate: the rebuilt DC is used ONLY when parsed lines reconcile against the
// CN's own printed totals. Anything off → reason string → pipeline falls back to
// editing the original PDF so no data can be lost.
test('validation gate: reconcileParsed catches every failure class', async () => {
  const { reconcileParsed } = await import('../src/pipeline.js');
  const good = {
    lines: [
      { sr: '1', name: 'A', qty: '2', amount: '100.00' },
      { sr: '2', name: 'B', qty: '3', amount: '50.00' },
    ],
    totals: { totalQty: '5', totalAmount: '150.00' },
  };
  assert.equal(reconcileParsed(good), null, 'clean parse passes');

  assert.match(reconcileParsed({ lines: [] }) || '', /no line items/i);
  assert.match(
    reconcileParsed({ ...good, lines: [good.lines[0], { sr: '2', name: '', qty: '3', amount: '50' }] }) || '',
    /name missing/i,
  );
  assert.match(
    reconcileParsed({ ...good, lines: [good.lines[0], { sr: '3', name: 'B', qty: '3', amount: '50' }] }) || '',
    /serial/i, 'gap in serials means a dropped row',
  );
  assert.match(
    reconcileParsed({ ...good, totals: { totalQty: '9', totalAmount: '150.00' } }) || '',
    /qty sum/i,
  );
  assert.match(
    reconcileParsed({ ...good, totals: { totalQty: '5', totalAmount: '999.00' } }) || '',
    /amount sum/i,
  );
  // Totals row missing entirely → row-level checks still guard, totals checks skip.
  assert.equal(reconcileParsed({ ...good, totals: {} }), null);
});

// A Delivery Challan must always carry a date: when the uploaded credit note has none,
// today's date is used. A CN that DOES have a date keeps its own.
test('missing credit note date is filled with today (both build modes)', async () => {
  const { readFileSync } = await import('node:fs');
  const { PDFDocument: P, StandardFonts } = await import('pdf-lib');
  const { makeReverseDcPipeline, istTodayDate } = await import('../src/pipeline.js');
  const pipe = makeReverseDcPipeline(null);
  const today = istTodayDate();
  assert.match(today, /^\d{2}-[A-Z][a-z]{2}-\d{4}$/, 'DD-Mon-YYYY, same shape as the CN prints');

  // Real CN carries "21-Jul-2026" - that must survive untouched.
  const real = readFileSync(new URL('./fixtures/sample-cn.pdf', import.meta.url));
  const kept = await pipe.buildFromUpload(real);
  assert.equal(kept.dateFilled, false);
  assert.equal(kept.challanDate, '21-Jul-2026');

  // A CN with the date LABEL but no value next to it → dated today.
  const doc = await P.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const put = (x, yTop, s) => page.drawText(s, { x, y: 842 - yTop, size: 7, font: helv });
  put(190.5, 248.5, 'Credit Note No:');
  put(190.5, 263.5, 'SRTEST/0001');
  put(412.5, 248.5, 'Credit Note Date'); // label present, value absent
  const undated = Buffer.from(await doc.save());

  const r = await pipe.buildFromUpload(undated);
  assert.equal(r.ok, true);
  assert.equal(r.dateFilled, true);
  assert.equal(r.challanDate, today);
  const out = await P.load(Buffer.from(r.file.base64, 'base64'));
  assert.ok(out.getPageCount() >= 1, 'still a valid PDF');
});

// A CN whose table can't be parsed must come back as an edited original, never empty.
test('validation gate: unparseable CN falls back to in-place edit of the original', async () => {
  const { PDFDocument: P, StandardFonts } = await import('pdf-lib');
  const { makeReverseDcPipeline } = await import('../src/pipeline.js');
  const doc = await P.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Some CN in a layout our parser has never seen', { x: 40, y: 700, size: 10, font: helv });
  const src = Buffer.from(await doc.save());

  const pipe = makeReverseDcPipeline(null);
  const r = await pipe.buildFromUpload(src);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'edit-fallback');
  assert.ok(r.fallbackReason, 'reason for fallback is reported');
  const reloaded = await P.load(Buffer.from(r.file.base64, 'base64'));
  assert.equal(reloaded.getPageCount(), 1, 'original document survives intact');
});

test('rejects typo / multi bulk-return IDs before calling Unicommerce', async () => {
  const { downloadCnByBulkReturn } = await import('../src/download.js');
  const uc = { dataBinary: async () => { throw new Error('should not call UC'); }, data: async () => { throw new Error('should not call UC'); } };
  await assert.rejects(() => downloadCnByBulkReturn(uc, 'vugj', 'Opp_WIQ_MH_1'), /Bulk Return ID like BR0160/);
  await assert.rejects(() => downloadCnByBulkReturn(uc, 'BR0052 BR0053', 'Opp_WIQ_MH_1'), /Bulk Return ID like BR0160/);
});
