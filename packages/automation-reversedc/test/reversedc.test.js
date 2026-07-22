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
