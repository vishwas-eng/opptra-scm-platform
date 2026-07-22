import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { editCreditNoteToDeliveryChallan } from '../src/edit.js';
import { makeReverseDcPipeline } from '../src/pipeline.js';

async function blankA4Pdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // A4 in points
  return Buffer.from(await doc.save());
}

test('edit produces a valid PDF that still has one page', async () => {
  const src = await blankA4Pdf();
  const out = await editCreditNoteToDeliveryChallan(src, { fromLines: ['Customer X', 'GSTIN: 29ABC'], toLines: ['Opptra Retail Pvt Ltd'] });
  const reloaded = await PDFDocument.load(out);
  assert.equal(reloaded.getPageCount(), 1);
  assert.ok(out.length > src.length - 200); // edited PDF is a real document
});

test('pipeline downloads the CN (facility hop), edits, returns base64 PDF', async () => {
  const src = await blankA4Pdf();
  const uc = {
    async dataBinary(path, opts) {
      assert.match(path, /invoice\/show\?invoiceCodes=/);
      // only one facility "has" the CN
      if (opts.facility === 'Opp_RSG_MH') return { buffer: src, contentType: 'application/pdf' };
      return { buffer: Buffer.alloc(0), contentType: 'text/html' };
    },
  };
  const { build } = makeReverseDcPipeline(uc, {});
  const r = await build({ creditNote: 'SRRMH2627/0134', fromLines: ['Cust'] });
  assert.equal(r.ok, true);
  assert.equal(r.facility, 'Opp_RSG_MH');
  assert.equal(r.file.contentType, 'application/pdf');
  assert.ok(r.file.filename.startsWith('DC_'));
  assert.ok(r.file.base64.length > 100);
});

test('pipeline reports a clear error when the CN is nowhere', async () => {
  const uc = { async dataBinary() { return { buffer: Buffer.alloc(0), contentType: 'text/html' }; } };
  const { build } = makeReverseDcPipeline(uc, {});
  const r = await build({ creditNote: 'NOPE' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});
